"""One-shot P4 integration targets; retain all databases and synthetic evidence.

prepare creates five absent databases and migrates each to exactly 0004. The
coordinator may run the V4 smoke before promote advances four targets to 0005.
verify is read-only. No command migrates or cleans the shared development DB.
"""

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from uuid import uuid4

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from p4c_memory_database import (
    CLUSTER,
    ROOT,
    containers,
    identity,
    require,
    snapshot,
    source_url,
    write_new,
)
from redis import Redis
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.db.base import Base
from app.db.capabilities import _manifest_matches

MANIFEST = ROOT / ".verification/p4-integration-target.json"
P4C_MANIFEST = ROOT / ".verification/p4c-memory-target.json"
ROLES = frozenset({"p4a", "p4b", "p4c", "p3chat", "auth"})
V5_ROLES = ("p4a", "p4b", "p4c", "auth")
PHASES = frozenset({"preparing", "prepared-0004", "promoting-0005", "promoted-0005"})


def target_names(run_id, auth_run_id):
    require(
        isinstance(run_id, str)
        and isinstance(auth_run_id, str)
        and re.fullmatch(r"[0-9a-f]{32}", run_id)
        and re.fullmatch(r"[0-9a-f]{32}", auth_run_id)
        and run_id != auth_run_id,
        "Invalid or overlapping integration run identifiers",
    )
    return {
        "p4a": "weibiye_p4a_test_" + run_id,
        "p4b": "weibiye_p4b_test_" + run_id,
        "p4c": "weibiye_p4c_test_" + run_id,
        "p3chat": "weibiye_p3_test_" + run_id,
        "auth": "weibiye_p3_test_" + auth_run_id,
    }


def validate_manifest(data):
    require(isinstance(data, dict), "Invalid integration manifest")
    names = target_names(data.get("run_id"), data.get("auth_run_id"))
    require(data.get("databases") == names, "Integration target names changed")
    require(data.get("cluster") == CLUSTER, "Integration cluster changed")
    require(data.get("phase") in PHASES, "Invalid integration phase")
    require(
        data.get("redis_prefix") == f"p4integration:test:{data['run_id']}:"
        and data.get("redis_lease_key") == data["redis_prefix"] + "owner"
        and data.get("redis15_lease_key") == f"weibiye:chat:test:{data['run_id']}:integration-owner"
        and type(data.get("redis15_reserved")) is bool
        and isinstance(data.get("redis_run_id"), str)
        and re.fullmatch(r"[0-9a-f]{40}", data["redis_run_id"]),
        "Invalid Redis ownership manifest",
    )
    before = data.get("shared_before")
    require(
        isinstance(before, dict)
        and before.get("database") == "weibiye"
        and before.get("cluster") == CLUSTER
        and before.get("revision") == "0004"
        and before.get("business_tables") == 21,
        "Invalid shared database baseline",
    )
    return data


def read_manifest():
    return validate_manifest(json.loads(MANIFEST.read_text(encoding="utf-8")))


def local_target_url(value, names):
    require(
        set(names) == ROLES
        and len(set(names.values())) == len(ROLES)
        and all(
            re.fullmatch(
                "weibiye_" + ("p3" if role in {"p3chat", "auth"} else role) + r"_test_[0-9a-f]{32}",
                name,
            )
            for role, name in names.items()
        ),
        "Invalid isolated integration target names",
    )
    url = make_url(value)
    require(
        url.drivername == "postgresql+psycopg"
        and (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
        and not url.query
        and url.database in names.values(),
        "Refusing unverified integration database target",
    )
    return url


def target_url(data, role):
    validate_manifest(data)
    require(role in ROLES, "Unknown integration database role")
    return local_target_url(source_url().set(database=data["databases"][role]), data["databases"])


def p4c_manifest(data):
    validate_manifest(data)
    prefix = "p4c:test:" + data["run_id"] + ":"
    return {
        "run_id": data["run_id"],
        "database": data["databases"]["p4c"],
        "cluster": CLUSTER,
        "redis_prefix": prefix,
        "redis_lease_key": prefix + "owner",
        "redis_run_id": data["redis_run_id"],
        "shared_before": data["shared_before"],
        "containers_before": data["containers_before"],
        "time": data["time"],
    }


def write_phase(data, phase):
    current = read_manifest()
    immutable = (
        "run_id",
        "auth_run_id",
        "databases",
        "cluster",
        "redis_prefix",
        "redis_lease_key",
        "redis15_lease_key",
        "redis_run_id",
        "shared_before",
        "containers_before",
        "time",
    )
    require(
        all(current[key] == data[key] for key in immutable) and current["phase"] == data["phase"],
        "Integration manifest changed concurrently",
    )
    data["phase"] = phase
    MANIFEST.write_text(json.dumps(data, indent=2), encoding="utf-8")


def assert_baseline(data):
    require(snapshot(source_url()) == data["shared_before"], "Shared schema/rows/SHA changed")
    require(containers() == data["containers_before"], "Dedicated containers changed")
    with Redis(host="127.0.0.1", port=26380, db=0, socket_timeout=3) as cache:
        require(
            cache.ping() and cache.info("server")["run_id"] == data["redis_run_id"],
            "Redis instance changed",
        )
        require(
            cache.get(data["redis_lease_key"]) == data["run_id"].encode()
            and cache.get(p4c_manifest(data)["redis_lease_key"]) == data["run_id"].encode(),
            "Integration namespace lease expired or changed",
        )


def assert_absent(db, names):
    require(
        not db.execute(
            text("SELECT datname FROM pg_database WHERE datname = ANY(:names)"),
            {"names": list(names.values())},
        ).all(),
        "An integration database already exists; refusing reuse",
    )


def create_targets(data):
    """Preflight ALL targets before the first CREATE; never recreate a target."""
    engine = create_engine(source_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as db:
            identity(db, "postgres")
            assert_absent(db, data["databases"])
            for name in data["databases"].values():
                assert_absent(db, {"next": name})
                db.exec_driver_sql(
                    "CREATE DATABASE "
                    + db.dialect.identifier_preparer.quote_identifier(name)
                    + " OWNER weibiye TEMPLATE template0"
                )
    finally:
        engine.dispose()


def migrate(data, role, previous, revision):
    require(
        (previous, revision) == (None, "0004")
        or (previous, revision) == ("0004", "0005")
        and role in V5_ROLES,
        "Only explicitly selected forward integration migrations are allowed",
    )
    engine = create_engine(target_url(data, role))
    try:
        with engine.begin() as db:
            identity(db, data["databases"][role])
            if previous is None:
                require(not inspect(db).get_table_names(), "Fresh integration target is not empty")
            else:
                require(
                    db.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
                    == [previous],
                    "Unexpected pre-migration revision",
                )
            db.execute(text("SET LOCAL lock_timeout='5s'"))
            db.execute(text("SET LOCAL statement_timeout='60s'"))
            config = Config(str(ROOT / "backend/alembic.ini"))
            config.attributes["connection"] = db
            command.upgrade(config, revision)
    finally:
        engine.dispose()


def check_target(data, role, revision, *, require_closed=False):
    require(revision in {"0004", "0005"}, "Unknown integration schema revision")
    url = target_url(data, role)
    state = snapshot(url)
    require(
        state["revision"] == revision
        and state["business_tables"] == (26 if revision == "0005" else 21),
        "Integration schema revision or table count mismatch",
    )
    engine = create_engine(
        url.update_query_dict({"options": "-c default_transaction_read_only=on"})
    )
    try:
        with engine.connect() as db:
            identity(db, url.database)
            require(_manifest_matches(db, revision), "Required schema capability manifest differs")
            if revision == "0005":
                require(
                    not compare_metadata(
                        MigrationContext.configure(db, opts={"compare_type": True}), Base.metadata
                    ),
                    "Integration model metadata differs",
                )
            if require_closed:
                require(
                    db.scalar(
                        text(
                            "SELECT count(*) FROM pg_stat_activity "
                            "WHERE datname=current_database() AND pid<>pg_backend_pid()"
                        )
                    )
                    == 0,
                    "Integration database still has other connections",
                )
    finally:
        engine.dispose()
    return state


def old_column_snapshot(url, old_schema):
    """Only old columns are hashed; no row content is emitted into evidence."""
    engine = create_engine(
        url.update_query_dict({"options": "-c default_transaction_read_only=on"})
    )
    try:
        with engine.connect() as db:
            identity(db, url.database)
            quote = db.dialect.identifier_preparer.quote_identifier
            result = {}
            for name, shape in sorted(old_schema.items()):
                if name == "alembic_version":
                    continue
                columns = [column[0] for column in shape["columns"]]
                query = (
                    "SELECT row_to_json(t) FROM (SELECT "
                    + ",".join(quote(column) for column in columns)
                    + " FROM public."
                    + quote(name)
                    + ") t"
                )
                rows = sorted(
                    json.dumps(row, sort_keys=True, separators=(",", ":"))
                    for row in db.exec_driver_sql(query).scalars()
                )
                result[name] = {
                    "columns": columns,
                    "count": len(rows),
                    "sha256": hashlib.sha256("\n".join(rows).encode()).hexdigest(),
                }
            return result
    finally:
        engine.dispose()


def prepare():
    require(not MANIFEST.exists(), "Integration manifest exists; no targets will be reused")
    require(not P4C_MANIFEST.exists(), "P4-C manifest exists; no target will be reused")
    before = snapshot(source_url())
    require(
        before["revision"] == "0004" and before["business_tables"] == 21,
        "Shared development database must remain at 0004/21 tables",
    )
    run_id, auth_run_id = uuid4().hex, uuid4().hex
    names = target_names(run_id, auth_run_id)
    # Detect any target conflict before writing Redis ownership or issuing DDL.
    engine = create_engine(source_url().set(database="postgres"))
    try:
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            identity(db, "postgres")
            assert_absent(db, names)
    finally:
        engine.dispose()
    with Redis(host="127.0.0.1", port=26380, db=0, socket_timeout=3) as cache:
        require(cache.ping(), "Dedicated Redis unavailable")
        data = {
            "run_id": run_id,
            "auth_run_id": auth_run_id,
            "databases": names,
            "cluster": CLUSTER,
            "phase": "preparing",
            "redis_prefix": f"p4integration:test:{run_id}:",
            "redis_lease_key": f"p4integration:test:{run_id}:owner",
            "redis15_lease_key": f"weibiye:chat:test:{run_id}:integration-owner",
            "redis15_reserved": False,
            "redis_run_id": cache.info("server")["run_id"],
            "shared_before": before,
            "containers_before": containers(),
            "time": datetime.now(UTC).isoformat(),
        }
        write_new(MANIFEST, validate_manifest(data))
        for key in (data["redis_lease_key"], p4c_manifest(data)["redis_lease_key"]):
            require(cache.set(key, run_id, nx=True, ex=86400), "Redis namespace already reserved")
    with Redis(host="127.0.0.1", port=26380, db=15, socket_timeout=3) as cache:
        require(cache.info("server")["run_id"] == data["redis_run_id"], "Redis instance mismatch")
        data["redis15_reserved"] = bool(
            cache.eval(
                "if redis.call('DBSIZE') ~= 0 then return 0 end "
                "return redis.call('SET', KEYS[1], ARGV[1], 'EX', 86400, 'NX')",
                1,
                data["redis15_lease_key"],
                run_id,
            )
        )
    create_targets(data)
    states = {}
    for role in data["databases"]:
        migrate(data, role, None, "0004")
        states[role] = check_target(data, role, "0004")
    assert_baseline(data)
    write_new(ROOT / ".verification/p4-integration-prepared.json", states)
    write_new(P4C_MANIFEST, p4c_manifest(data))
    write_phase(data, "prepared-0004")
    print(
        json.dumps(
            {
                "phase": data["phase"],
                "databases": names,
                "redis15_reserved": data["redis15_reserved"],
            }
        )
    )


def promote():
    data = read_manifest()
    require(data["phase"] == "prepared-0004", "Promotion is one-shot from prepared-0004 only")
    require(
        json.loads(P4C_MANIFEST.read_text(encoding="utf-8")) == p4c_manifest(data),
        "P4-C manifest changed",
    )
    assert_baseline(data)
    before = {role: check_target(data, role, "0004", require_closed=True) for role in ROLES}
    old_rows = {
        role: old_column_snapshot(target_url(data, role), before[role]["schema"])
        for role in V5_ROLES
    }
    write_new(
        ROOT / ".verification/p4-integration-before-v5.json",
        {"state": before, "old_columns": old_rows},
    )
    write_phase(data, "promoting-0005")
    for role in V5_ROLES:
        migrate(data, role, "0004", "0005")
        check_target(data, role, "0005")
        require(
            old_column_snapshot(target_url(data, role), before[role]["schema"]) == old_rows[role],
            "Existing integration data changed during forward migration",
        )
    check_target(data, "p3chat", "0004")
    assert_baseline(data)
    write_new(ROOT / ".verification/p4-integration-promoted.json", {"old_columns_preserved": True})
    write_phase(data, "promoted-0005")
    print(
        json.dumps(
            {"phase": data["phase"], "old_columns_preserved": True, "shared_revision": "0004"}
        )
    )


def verify():
    data = read_manifest()
    require(data["phase"] == "promoted-0005", "All isolated forward migrations must complete")
    require(
        json.loads(P4C_MANIFEST.read_text(encoding="utf-8")) == p4c_manifest(data),
        "P4-C manifest changed",
    )
    assert_baseline(data)
    if data["redis15_reserved"]:
        with Redis(host="127.0.0.1", port=26380, db=15, socket_timeout=3) as cache:
            require(
                cache.get(data["redis15_lease_key"]) == data["run_id"].encode(),
                "Redis DB15 test lease changed or expired",
            )
    states = {
        role: check_target(data, role, "0004" if role == "p3chat" else "0005", require_closed=True)
        for role in ROLES
    }
    write_new(
        ROOT / ".verification/p4-integration-final-database.json",
        {
            "verified": True,
            "shared_schema_rows_sha256_unchanged": True,
            "dedicated_containers_unchanged": True,
            "redis_instance_unchanged": True,
            "isolated": states,
        },
    )
    print(
        json.dumps({"verified": True, "shared_revision": "0004", "isolated_targets": len(states)})
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "promote", "verify"))
    {"prepare": prepare, "promote": promote, "verify": verify}[parser.parse_args().operation]()
