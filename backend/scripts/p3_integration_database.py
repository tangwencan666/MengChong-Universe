"""Prepare and inspect a fresh P3 test database; never reset an existing database.

Only the verified WeiBiYe loopback PostgreSQL instance is accepted. The shared
development database is read-only. New databases and Redis evidence are retained.
"""

import argparse
import json
import re
from pathlib import Path
from uuid import uuid4

import psycopg
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from psycopg import sql
from redis import Redis
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.db import models  # noqa: F401
from app.db.base import Base

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".verification" / "p3-integration-target.json"
CLUSTER = "7703042374370492450"
ISOLATED_NAME = re.compile(r"weibiye_p3_test_[0-9a-f]{32}")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def local_url(value, *, shared=False):
    url = make_url(value)
    require(
        url.drivername == "postgresql+psycopg"
        and (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
        and not url.query,
        "Refusing an unverified PostgreSQL target",
    )
    require(
        url.database == "weibiye" if shared else ISOLATED_NAME.fullmatch(url.database or ""),
        "Refusing a non-isolated database name",
    )
    return url


def snapshot(url):
    engine = create_engine(
        url.update_query_dict({"options": "-c default_transaction_read_only=on"}),
        connect_args={"connect_timeout": 3},
    )
    try:
        with engine.connect() as db:
            identity = db.execute(
                text(
                    "SELECT current_database(), current_user, "
                    "(SELECT system_identifier::text FROM pg_control_system()), "
                    "current_setting('transaction_read_only')"
                )
            ).one()
            require(
                tuple(identity) == (url.database, "weibiye", CLUSTER, "on"),
                "PostgreSQL identity or read-only guard mismatch",
            )
            tables = inspect(db).get_table_names()
            require("alembic_version" in tables, "Database is not forward-migrated")
            counts = {
                name: db.exec_driver_sql(
                    f"SELECT count(*) FROM {db.dialect.identifier_preparer.quote(name)}"
                ).scalar_one()
                for name in tables
                if name != "alembic_version"
            }
            return {
                "database": url.database,
                "cluster": CLUSTER,
                "revision": db.scalar(text("SELECT version_num FROM alembic_version")),
                "business_tables": len(counts),
                "counts": counts,
                "read_only": True,
            }
    finally:
        engine.dispose()


def read_manifest():
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    require(ISOLATED_NAME.fullmatch(data["database"]), "Invalid integration manifest")
    require(re.fullmatch(r"[0-9a-f]{32}", data["run_id"]), "Invalid run identifier")
    require(data["database"] == f"weibiye_p3_test_{data['run_id']}", "Manifest target mismatch")
    require(data["redis_db"] == 15, "Invalid isolated Redis database")
    if "auth_database" in data:
        require(
            ISOLATED_NAME.fullmatch(data["auth_database"])
            and data["auth_database"] != data["database"],
            "Auth tests require a separate isolated database",
        )
    return data


def prepare():
    require(not MANIFEST.exists(), "Target manifest exists; no database will be recreated")
    settings = Settings()
    require(settings.llm_provider == "mock" and not settings.real_llm_enabled, "Mock required")
    source = local_url(settings.database_url.get_secret_value(), shared=True)
    before = snapshot(source)
    require(before["revision"] == "0003", "Shared development database is not at 0003")
    cache_url = make_url(settings.redis_url.get_secret_value())
    require(
        (cache_url.drivername, cache_url.host, cache_url.port, cache_url.database)
        == ("redis", "127.0.0.1", 26380, "0")
        and not cache_url.username
        and not cache_url.password
        and not cache_url.query,
        "Refusing an unverified Redis target",
    )
    cache = Redis(host="127.0.0.1", port=26380, db=15, socket_timeout=3)
    try:
        require(cache.ping() and cache.dbsize() == 0, "Redis DB 15 is not empty; no keys changed")
        run_id = uuid4().hex
        name = f"weibiye_p3_test_{run_id}"
        auth_name = f"weibiye_p3_test_{uuid4().hex}"
        require(auth_name != name, "Acceptance databases must be distinct")
        admin_url = source.set(database="postgres", drivername="postgresql")
        with psycopg.connect(
            admin_url.render_as_string(hide_password=False), autocommit=True, connect_timeout=3
        ) as db:
            identity = db.execute(
                "SELECT current_database(), current_user, "
                "(SELECT system_identifier::text FROM pg_control_system())"
            ).fetchone()
            require(identity == ("postgres", "weibiye", CLUSTER), "Admin identity mismatch")
            for isolated_name in (name, auth_name):
                require(
                    not db.execute(
                        "SELECT 1 FROM pg_database WHERE datname=%s", (isolated_name,)
                    ).fetchone(),
                    "Target database already exists; refusing reuse",
                )
                db.execute(
                    sql.SQL("CREATE DATABASE {} OWNER {} TEMPLATE template0").format(
                        sql.Identifier(isolated_name), sql.Identifier("weibiye")
                    )
                )
        lease = f"weibiye:chat:test:{run_id}:integration-owner"
        reserved = cache.eval(
            "if redis.call('DBSIZE') ~= 0 then return 0 end "
            "redis.call('SET', KEYS[1], ARGV[1], 'EX', 21600); return 1",
            1,
            lease,
            run_id,
        )
        require(reserved == 1, "Redis target changed; fresh database retained without migration")
        data = {
            "run_id": run_id,
            "database": name,
            "auth_database": auth_name,
            "cluster": CLUSTER,
            "redis_db": 15,
            "redis_run_id": cache.info("server")["run_id"],
            "redis_lease_key": lease,
            "shared_before": before,
        }
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps(data, indent=2), encoding="utf-8")
        target = source.set(database=name)
        engine = create_engine(target, connect_args={"connect_timeout": 3})
        try:
            config = Config(str(ROOT / "backend" / "alembic.ini"))
            for revision in ("0003", "0004"):
                with engine.begin() as db:
                    require(
                        db.scalar(text("SELECT current_database()")) == name,
                        "Migration target changed",
                    )
                    config.attributes["connection"] = db
                    command.upgrade(config, revision)
                data[f"at_{revision}"] = snapshot(target)
            with engine.connect() as db:
                config.attributes["connection"] = db
                command.check(config)
        finally:
            engine.dispose()
        auth_target = source.set(database=auth_name)
        auth_engine = create_engine(auth_target, connect_args={"connect_timeout": 3})
        try:
            with auth_engine.begin() as db:
                require(db.scalar(text("SELECT current_database()")) == auth_name, "Auth target")
                config.attributes["connection"] = db
                command.upgrade(config, "0004")
            data["auth_snapshot"] = snapshot(auth_target)
            require(
                data["auth_snapshot"]["business_tables"] == 21
                and not any(data["auth_snapshot"]["counts"].values()),
                "Auth rollback tests require a fresh empty schema",
            )
        finally:
            auth_engine.dispose()
        require(data["at_0003"]["business_tables"] == 18, "Unexpected 0003 schema")
        require(data["at_0004"]["business_tables"] == 21, "Unexpected 0004 schema")
        require(snapshot(source) == before, "Shared database changed during preparation")
        MANIFEST.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "database": name,
                    "revision": "0004",
                    "business_tables": 21,
                    "redis": "127.0.0.1:26380/15",
                    "shared_database_unchanged": True,
                }
            )
        )
    finally:
        cache.close()


def verify():
    data = read_manifest()
    settings = Settings()
    source = make_url(settings.database_url.get_secret_value()).set(database="weibiye")
    source = local_url(source.render_as_string(hide_password=False), shared=True)
    require(snapshot(source) == data["shared_before"], "Shared development database changed")
    target = source.set(database=data["database"])
    result = snapshot(target)
    require(result["revision"] == "0004" and result["business_tables"] == 21, "Schema mismatch")
    engine = create_engine(target)
    try:
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            differences = compare_metadata(
                MigrationContext.configure(db, opts={"compare_type": True}), Base.metadata
            )
            require(not differences, "Model and PostgreSQL schema differ")
            result["model_differences"] = len(differences)
            result["idle_in_transaction"] = db.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                    "AND state='idle in transaction' AND pid<>pg_backend_pid()"
                )
            )
            require(result["idle_in_transaction"] == 0, "Leaked database transaction")
    finally:
        engine.dispose()
    result["shared_database_unchanged"] = True
    result["counts"] = {key: value for key, value in result["counts"].items()}
    (MANIFEST.parent / "p3-integration-final-database.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "verify"))
    operation = parser.parse_args().operation
    prepare() if operation == "prepare" else verify()
