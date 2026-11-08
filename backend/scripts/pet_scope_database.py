"""Prepare one new pet test database; never migrate or clean the development DB.

Evidence contains schema/count/hash metadata, never original row contents or DSNs.
Run from backend with its existing virtual environment. Databases are retained.
"""

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from fastapi.testclient import TestClient
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.db import models  # noqa: F401
from app.db.base import Base
from app.db.capabilities import PET_TABLES
from app.main import create_app

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / ".verification" / "pet-scope"
CLUSTER = "7703042374370492450"


def snapshot(connection):
    inspector = inspect(connection)
    tables = sorted(set(inspector.get_table_names()) - {"alembic_version"})
    result = {}
    for name in tables:
        # Names originate from PostgreSQL catalog, quoted by the active dialect.
        identifier = connection.dialect.identifier_preparer.quote_identifier(name)
        rows = connection.exec_driver_sql("SELECT * FROM " + identifier).mappings().all()
        canonical = sorted(json.dumps(dict(row), sort_keys=True, default=str) for row in rows)
        result[name] = {
            "rows": len(rows),
            "sha256": hashlib.sha256("\n".join(canonical).encode()).hexdigest(),
            "columns": [
                (column["name"], str(column["type"]), column["nullable"], str(column["default"]))
                for column in inspector.get_columns(name)
            ],
            "pk": inspector.get_pk_constraint(name),
            "fk": inspector.get_foreign_keys(name),
            "uq": inspector.get_unique_constraints(name),
            "check": inspector.get_check_constraints(name),
            "indexes": inspector.get_indexes(name),
        }
    return {
        "database": connection.scalar(text("SELECT current_database()")),
        "cluster": connection.scalar(
            text("SELECT system_identifier::text FROM pg_control_system()")
        ),
        "version": connection.scalar(text("SELECT version_num FROM alembic_version")),
        "tables": result,
    }


def read_snapshot(engine):
    with engine.begin() as connection:
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return snapshot(connection)


def seed_legacy(url, run):
    settings = Settings(
        environment="test",
        database_url=SecretStr(url),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        chat_runner_enabled=False,
        llm_provider="mock",
        real_llm_enabled=False,
        memory_management_enabled=True,
        memory_hmac_key=SecretStr("pet-migration-fixture-only-" + run),
        cors_origins=["http://testserver"],
        frontend_origin="http://testserver",
    )
    with TestClient(
        create_app(settings),
        headers={"Origin": "http://testserver"},
        backend_options={"loop_factory": new_event_loop},
    ) as client:
        credentials = {
            "email": f"pet-legacy-{run}@example.com",
            "password": "Fixture!SafePassword-2026",
        }
        token = client.get("/api/v1/auth/csrf").json()["csrf_token"]
        assert (
            client.post(
                "/api/v1/auth/register",
                json={**credentials, "display_name": "Pet legacy fixture"},
                headers={"X-CSRF-Token": token},
            ).status_code
            == 202
        )
        assert (
            client.post(
                "/api/v1/auth/login", json=credentials, headers={"X-CSRF-Token": token}
            ).status_code
            == 200
        )
        token = client.get("/api/v1/auth/csrf").json()["csrf_token"]

        def send(method, path, body):
            return client.request(
                method,
                path,
                json=body,
                headers={"X-CSRF-Token": token, "Idempotency-Key": str(uuid4())},
            )

        session = send("POST", "/api/v1/companion/sessions", {"title": "Preserved legacy fixture"})
        assert session.status_code == 201, session.text
        session_id = session.json()["session"]["id"]
        message = send(
            "POST",
            f"/api/v1/companion/sessions/{session_id}/messages",
            {
                "content": "Legacy synthetic conversation must stay unassigned.",
                "client_message_id": str(uuid4()),
            },
        )
        assert message.status_code == 202, message.text
        consent = {
            "confirmed": True,
            "policy_version": "memory-policy/1",
            "notice_version": "memory-notice/1",
        }
        preferences = client.get("/api/v1/memory/preferences").json()
        enabled = send(
            "PATCH",
            "/api/v1/memory/preferences",
            {
                "long_term_memory_enabled": True,
                "expected_version": preferences["version"],
                "consent": consent,
            },
        )
        assert enabled.status_code == 200, enabled.text
        memory = send(
            "POST",
            "/api/v1/memory/items",
            {
                "title": "Old explicitly authorized memory",
                "content": "I prefer concise replies.",
                "category": "communication_preference",
                "source": {"kind": "manual"},
                "expected_preferences_version": enabled.json()["version"],
                "consent": consent,
            },
        )
        assert memory.status_code == 201, memory.text


def prepare():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    target_file = EVIDENCE / "target.json"
    if target_file.exists():
        raise RuntimeError("An evidence target already exists; refusing to replace or reuse it.")
    original = make_url(Settings().database_url.get_secret_value())
    assert (
        original.drivername,
        original.host,
        original.port,
        original.username,
        original.database,
    ) == ("postgresql+psycopg", "127.0.0.1", 25433, "weibiye", "weibiye")
    assert not original.query
    source = create_engine(
        original,
        connect_args={"connect_timeout": 5, "application_name": "weibiye-pet-readonly-audit"},
    )
    before = read_snapshot(source)
    assert (
        before["cluster"] == CLUSTER and before["version"] == "0005" and len(before["tables"]) == 26
    )
    (EVIDENCE / "shared-before.json").write_text(
        json.dumps(before, indent=2, default=str), encoding="utf-8"
    )
    run = uuid4().hex
    name = "weibiye_pet_test_" + run
    admin = create_engine(original.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        assert (
            connection.scalar(text("SELECT system_identifier::text FROM pg_control_system()"))
            == CLUSTER
        )
        assert (
            connection.scalar(
                text("SELECT count(*) FROM pg_database WHERE datname=:name"), {"name": name}
            )
            == 0
        )
        connection.exec_driver_sql('CREATE DATABASE "' + name + '" TEMPLATE template0')
    admin.dispose()
    (EVIDENCE / ("created-" + run + ".json")).write_text(
        json.dumps(
            {
                "run_id": run,
                "database": name,
                "cluster": CLUSTER,
                "state": "created-not-yet-verified",
            }
        ),
        encoding="utf-8",
    )
    target = original.set(database=name)
    engine = create_engine(
        target,
        connect_args={"connect_timeout": 5, "application_name": "weibiye-pet-migration-test"},
    )
    config = Config(str(ROOT / "backend/alembic.ini"))
    # Explicit connection prevents Alembic's default settings selecting the development DB.
    with engine.begin() as connection:
        assert connection.scalar(text("SELECT current_database()")) == name
        connection.exec_driver_sql("SET LOCAL lock_timeout='5s'")
        connection.exec_driver_sql("SET LOCAL statement_timeout='60s'")
        config.attributes["connection"] = connection
        command.upgrade(config, "0005")
    config.attributes.pop("connection")
    seed_legacy(target.render_as_string(hide_password=False), run)
    legacy = read_snapshot(engine)
    assert legacy["version"] == "0005" and len(legacy["tables"]) == 26
    started = datetime.now(UTC)
    with engine.begin() as connection:
        assert connection.scalar(text("SELECT current_database()")) == name
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0005"
        connection.exec_driver_sql("SET LOCAL lock_timeout='5s'")
        connection.exec_driver_sql("SET LOCAL statement_timeout='60s'")
        config.attributes["connection"] = connection
        command.upgrade(config, "0006")
    elapsed = (datetime.now(UTC) - started).total_seconds()
    config.attributes.pop("connection")
    after = read_snapshot(engine)
    assert after["version"] == "0006" and len(after["tables"]) == 34
    assert set(after["tables"]) - set(legacy["tables"]) == PET_TABLES
    assert all(after["tables"][table] == value for table, value in legacy["tables"].items())
    assert all(after["tables"][table]["rows"] == 0 for table in PET_TABLES)
    with engine.connect() as connection:
        assert (
            compare_metadata(
                MigrationContext.configure(connection, opts={"compare_type": True}), Base.metadata
            )
            == []
        )
        assert (
            connection.scalar(
                text("SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready")
            )
            == 0
        )
        assert (
            connection.scalar(
                text(
                    "SELECT count(*) FROM pg_constraint "
                    "WHERE connamespace='public'::regnamespace AND NOT convalidated"
                )
            )
            == 0
        )
    redis = Redis.from_url("redis://127.0.0.1:26380/0", socket_timeout=3)
    assert redis.ping()
    key = "weibiye:pet-scope-probe:" + run
    assert redis.set(key, "isolated-check", nx=True, ex=60)
    assert redis.get(key) == b"isolated-check"
    redis.close()
    final = read_snapshot(source)
    assert before == final, "Development DB changed; stop for investigation."
    for filename, data in [
        ("test-before-0006.json", legacy),
        ("test-after-0006.json", after),
        ("shared-after-prepare.json", final),
    ]:
        (EVIDENCE / filename).write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    evidence = {
        "run_id": run,
        "database": name,
        "cluster": CLUSTER,
        "revision": "0006",
        "tables": 34,
        "legacy_preserved": True,
        "migration_seconds": elapsed,
        "completed_at": datetime.now(UTC).isoformat(),
    }
    target_file.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    engine.dispose()
    source.dispose()
    print(json.dumps(evidence))


if __name__ == "__main__":
    if os.environ.get("WEIBIYE_PET_PREPARE_NEW_DATABASE") != "1":
        raise SystemExit("Explicitly opt in to preparing one NEW isolated pet test database.")
    prepare()
