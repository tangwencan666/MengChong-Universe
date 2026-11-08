"""Guarded P4-C local acceptance database, retained evidence and no cleanup operations.

prepare creates ONE absent, randomly named database and upgrades it to exactly 0005.
verify is read-only. Neither operation migrates the shared development database.
"""

import argparse
import hashlib
import json
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from redis import Redis
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.db import models  # noqa: F401
from app.db.base import Base

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".verification/p4c-memory-target.json"
CLUSTER = "7703042374370492450"
PATTERN = re.compile(r"weibiye_p4c_test_[0-9a-f]{32}")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        json.dump(data, output, indent=2)


def local_url(value, *, shared=False):
    url = make_url(value)
    require(
        url.drivername == "postgresql+psycopg"
        and (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
        and not url.query,
        "Refusing unverified PostgreSQL address, port, user or options",
    )
    require(
        url.database == "weibiye" if shared else PATTERN.fullmatch(url.database or ""),
        "Refusing a database without the exact P4-C isolated name",
    )
    return url


def source_url():
    # Public, local-only development defaults, not credential files or production settings.
    value = Settings.model_fields["database_url"].default.get_secret_value()
    return local_url(value, shared=True)


def identity(db, name):
    require(
        tuple(
            db.execute(
                text(
                    "SELECT current_database(), current_user, "
                    "(SELECT system_identifier::text FROM pg_control_system())"
                )
            ).one()
        )
        == (name, "weibiye", CLUSTER),
        "PostgreSQL database/user/cluster identity mismatch",
    )


def snapshot(url):
    engine = create_engine(
        url.update_query_dict({"options": "-c default_transaction_read_only=on"}),
        connect_args={"connect_timeout": 3},
    )
    try:
        with engine.connect() as db:
            identity(db, url.database)
            inspector = inspect(db)
            tables = sorted(inspector.get_table_names(schema="public"))
            require("alembic_version" in tables, "Target is not migrated")
            rows = {}
            for name in tables:
                quoted = db.dialect.identifier_preparer.quote_identifier(name)
                data = sorted(
                    json.dumps(item, sort_keys=True, separators=(",", ":"))
                    for item in db.exec_driver_sql(
                        f"SELECT row_to_json(t) FROM public.{quoted} t"
                    ).scalars()
                )
                rows[name] = {
                    "count": len(data),
                    "sha256": hashlib.sha256("\n".join(data).encode()).hexdigest(),
                }
            shape = {
                name: {
                    "columns": [
                        (column["name"], str(column["type"]), column["nullable"], column["default"])
                        for column in inspector.get_columns(name)
                    ],
                    "pk": inspector.get_pk_constraint(name),
                    "fk": inspector.get_foreign_keys(name),
                    "unique": inspector.get_unique_constraints(name),
                    "check": inspector.get_check_constraints(name),
                    "indexes": inspector.get_indexes(name),
                }
                for name in tables
            }
            return json.loads(
                json.dumps(
                    {
                        "database": url.database,
                        "cluster": CLUSTER,
                        "revision": db.scalar(text("SELECT version_num FROM alembic_version")),
                        "business_tables": len(tables) - 1,
                        "rows": rows,
                        "schema": shape,
                    }
                )
            )
    finally:
        engine.dispose()


def containers():
    template = (
        '{"id":{{json .Id}},"status":{{json .State.Status}},'
        '"health":{{json .State.Health.Status}},"started_at":{{json .State.StartedAt}},'
        '"restart_count":{{json .RestartCount}},"ports":{{json .HostConfig.PortBindings}},'
        '"mounts":{{json .Mounts}}}'
    )
    result = []
    for name in ("weibiye-postgres-1", "weibiye-redis-1"):
        data = subprocess.check_output(["docker", "inspect", name, "--format", template], text=True)
        record = {"name": name, **json.loads(data)}
        require(
            record["status"] == "running" and record["health"] == "healthy",
            "Unhealthy dedicated container",
        )
        result.append(record)
    return result


def read_manifest():
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    require(re.fullmatch(r"[0-9a-f]{32}", data["run_id"]), "Invalid run identifier")
    require(data["database"] == "weibiye_p4c_test_" + data["run_id"], "Manifest database mismatch")
    require(data["cluster"] == CLUSTER, "Manifest cluster mismatch")
    require(data["redis_prefix"] == "p4c:test:" + data["run_id"] + ":", "Invalid namespace")
    require(data["redis_lease_key"] == data["redis_prefix"] + "owner", "Invalid test lease")
    return data


def prepare():
    require(not MANIFEST.exists(), "Manifest exists; refusing to reuse or recreate target")
    source = source_url()
    before = snapshot(source)
    require(
        before["revision"] == "0004" and before["business_tables"] == 21,
        "Shared development database is not the expected 0004/21-table instance",
    )
    docker = containers()
    run_id = uuid4().hex
    name = "weibiye_p4c_test_" + run_id
    target = local_url(source.set(database=name).render_as_string(hide_password=False))
    with Redis(host="127.0.0.1", port=26380, db=0, socket_timeout=3) as cache:
        require(cache.ping(), "Dedicated Redis unavailable")
        redis_id = cache.info("server")["run_id"]
        prefix = "p4c:test:" + run_id + ":"
        require(
            cache.set(prefix + "owner", run_id, nx=True, ex=86400), "Run namespace already reserved"
        )
    data = {
        "run_id": run_id,
        "database": name,
        "cluster": CLUSTER,
        "redis_prefix": prefix,
        "redis_lease_key": prefix + "owner",
        "redis_run_id": redis_id,
        "shared_before": before,
        "containers_before": docker,
        "time": datetime.now(UTC).isoformat(),
    }
    # Save the safety baseline before any DDL, retaining evidence on failure.
    write_new(MANIFEST, data)
    engine = create_engine(source.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as db:
            identity(db, "postgres")
            require(
                not db.scalar(
                    text("SELECT 1 FROM pg_database WHERE datname=:name"), {"name": name}
                ),
                "Target already exists; no DDL performed",
            )
            db.exec_driver_sql(
                "CREATE DATABASE "
                + db.dialect.identifier_preparer.quote_identifier(name)
                + " OWNER weibiye TEMPLATE template0"
            )
    finally:
        engine.dispose()
    engine = create_engine(target)
    try:
        with engine.begin() as db:
            identity(db, name)
            require(not inspect(db).get_table_names(), "Target is not empty")
            db.execute(text("SET LOCAL lock_timeout='5s'"))
            db.execute(text("SET LOCAL statement_timeout='60s'"))
            cfg = Config(str(ROOT / "backend/alembic.ini"))
            cfg.attributes["connection"] = db
            command.upgrade(cfg, "0005")
        with engine.connect() as db:
            require(
                not compare_metadata(MigrationContext.configure(db), Base.metadata),
                "Model mismatch",
            )
    finally:
        engine.dispose()
    state = snapshot(target)
    require(state["revision"] == "0005" and state["business_tables"] == 26, "Schema mismatch")
    require(snapshot(source) == before, "Shared database changed during preparation")
    write_new(ROOT / ".verification/p4c-isolated-prepared.json", state)
    print(
        json.dumps(
            {
                "database": name,
                "revision": "0005",
                "business_tables": 26,
                "shared_revision": "0004",
                "redis_namespace": prefix,
                "model_differences": 0,
            }
        )
    )


def verify():
    manifest = read_manifest()
    source = source_url()
    require(snapshot(source) == manifest["shared_before"], "Shared schema/rows/content changed")
    require(containers() == manifest["containers_before"], "Dedicated containers changed")
    target = source.set(database=manifest["database"])
    state = snapshot(target)
    require(
        state["revision"] == "0005" and state["business_tables"] == 26, "Target version changed"
    )
    engine = create_engine(target)
    try:
        with engine.connect() as db:
            identity(db, manifest["database"])
            require(
                not compare_metadata(MigrationContext.configure(db), Base.metadata),
                "Model mismatch",
            )
            require(
                db.scalar(
                    text(
                        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                        "AND state='idle in transaction' AND pid<>pg_backend_pid()"
                    )
                )
                == 0,
                "Leaked database transaction",
            )
    finally:
        engine.dispose()
    with Redis(host="127.0.0.1", port=26380, db=0, socket_timeout=3) as cache:
        require(
            cache.ping() and cache.info("server")["run_id"] == manifest["redis_run_id"],
            "Redis instance changed",
        )
    result = {
        "verified": True,
        "shared_schema_rows_sha256_unchanged": True,
        "shared_revision": "0004",
        "dedicated_containers_unchanged": True,
        "redis_instance_unchanged": True,
        "isolated": state,
        "model_differences": 0,
    }
    write_new(ROOT / ".verification/p4c-isolated-final.json", result)
    print(json.dumps({key: value for key, value in result.items() if key != "isolated"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "verify"))
    prepare() if parser.parse_args().operation == "prepare" else verify()
