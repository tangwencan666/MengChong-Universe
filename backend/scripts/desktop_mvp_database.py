"""Create ONE new P6 test database; preserve both development and previous test data."""

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from pet_scope_database import CLUSTER, read_snapshot
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".verification/p6"
UI = "http://127.0.0.1:35316"
PASSWORD = "Local-P6-Safe!2026"


def normalized(value):
    return json.loads(json.dumps(value, default=str))


def main():
    target_file = OUT / "target.json"
    assert not target_file.exists(), "Never replace an existing test target."
    original = make_url(Settings().database_url.get_secret_value())
    assert (original.host, original.port, original.username, original.database) == (
        "127.0.0.1",
        25433,
        "weibiye",
        "weibiye",
    )
    source = create_engine(original)
    before = normalized(read_snapshot(source))
    assert (
        before["version"] == "0005" and len(before["tables"]) == 26 and before["cluster"] == CLUSTER
    )
    (OUT / "shared-before.json").write_text(json.dumps(before, indent=2), encoding="utf-8")
    previous_target = json.loads(
        (ROOT / ".verification/pet-scope/target.json").read_text(encoding="utf-8")
    )
    assert previous_target["database"] == "weibiye_pet_test_" + previous_target["run_id"]
    previous = create_engine(original.set(database=previous_target["database"]))
    old_state = normalized(read_snapshot(previous))
    assert (
        old_state["version"] == "0006"
        and len(old_state["tables"]) == 34
        and old_state["cluster"] == CLUSTER
    )
    with previous.connect() as db:
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM chat_generations "
                    "WHERE state IN ('queued','running','cancel_requested')"
                )
            )
            == 0
        )
    (OUT / "previous-pet-test-before.json").write_text(
        json.dumps(old_state, indent=2), encoding="utf-8"
    )
    run = uuid4().hex
    name = "weibiye_p6_desktop_test_" + run
    admin = create_engine(original.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as db:
        assert db.scalar(text("SELECT system_identifier::text FROM pg_control_system()")) == CLUSTER
        assert (
            db.scalar(text("SELECT count(*) FROM pg_database WHERE datname=:name"), {"name": name})
            == 0
        )
        db.exec_driver_sql('CREATE DATABASE "' + name + '" TEMPLATE template0')
    admin.dispose()
    (OUT / "created-test-database.json").write_text(
        json.dumps({"database": name, "runId": run, "cluster": CLUSTER}), encoding="utf-8"
    )
    url = original.set(database=name)
    engine = create_engine(url)
    config = Config(str(ROOT / "backend/alembic.ini"))
    with engine.begin() as db:
        assert db.scalar(text("SELECT current_database()")) == name
        db.exec_driver_sql("SET LOCAL lock_timeout='5s'")
        db.exec_driver_sql("SET LOCAL statement_timeout='60s'")
        config.attributes["connection"] = db
        command.upgrade(config, "0006")
    config.attributes.pop("connection")
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
        assert len(set(inspect(db).get_table_names()) - {"alembic_version"}) == 34
    settings = Settings(
        environment="test",
        database_url=SecretStr(url.render_as_string(hide_password=False)),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        frontend_origin=UI,
        cors_origins=[UI],
        llm_provider="mock",
        real_llm_enabled=False,
        chat_runner_enabled=False,
        memory_management_enabled=True,
        memory_hmac_key=SecretStr("p6-desktop-fixture-only-" + run),
        mock_mail_dir=OUT / "mock-mail",
    )
    accounts = {}
    for label, count in [("a", 3), ("b", 1)]:
        with TestClient(
            create_app(settings),
            headers={"Origin": UI},
            backend_options={"loop_factory": new_event_loop},
        ) as client:

            def headers():
                token = client.get("/api/v1/auth/csrf").json()["csrf_token"]
                return {"X-CSRF-Token": token, "Idempotency-Key": str(uuid4())}

            email = f"desktop-{run}-{label}@example.com"
            register = client.post(
                "/api/v1/auth/register",
                json={
                    "email": email,
                    "password": PASSWORD,
                    "display_name": "桌宠验收" + label.upper(),
                },
                headers=headers(),
            )
            assert register.status_code == 202, register.status_code
            login = client.post(
                "/api/v1/auth/login", json={"email": email, "password": PASSWORD}, headers=headers()
            )
            assert login.status_code == 200, login.status_code
            pets = []
            for index in range(count):
                payload = {
                    "name": (["月芽", "豆包", "小云"][index] if label == "a" else "另一账号的宠物"),
                    "role_type": ["cat", "dog", "custom"][index],
                    "persona_config": {
                        "description": "用自然简短的话交流。",
                        "tone": ["warm", "playful", "calm"][index],
                    },
                    "appearance_config": {
                        "asset_id": "pet-default",
                        "tint": ["#83A78C", "#C89B72", "#90A6BB"][index],
                        "scale": 1.0,
                    },
                }
                response = client.post("/api/v1/pets", json=payload, headers=headers())
                assert response.status_code == 201, response.status_code
                pet = response.json()
                pets.append(
                    {"pet_id": pet["pet_id"], "name": pet["name"], "role_type": pet["role_type"]}
                )
            accounts[label] = {
                "email": email,
                "password": PASSWORD,
                "user_id": login.json()["id"],
                "pets": pets,
            }
            assert client.post("/api/v1/auth/logout", headers=headers()).status_code == 204
    cache = Redis.from_url("redis://127.0.0.1:26380/0", socket_timeout=3)
    assert cache.ping()
    redis_id = cache.info("server")["run_id"]
    key = "weibiye:p6-probe:" + run
    assert cache.set(key, "ready", nx=True, ex=60) and cache.get(key) == b"ready"
    cache.close()
    assert before == normalized(read_snapshot(source))
    assert old_state == normalized(read_snapshot(previous))
    evidence = {
        "runId": run,
        "databaseName": name,
        "schemaVersion": "0006",
        "cluster": CLUSTER,
        "uiPort": 35316,
        "backendOrigin": "http://127.0.0.1:38316",
        "redisRunId": redis_id,
        "redisPrefix": "weibiye:p6:" + run + ":",
        "accounts": accounts,
        "createdAt": datetime.now(UTC).isoformat(),
    }
    with target_file.open("x", encoding="utf-8") as out:
        json.dump(evidence, out, ensure_ascii=False, indent=2)
    with (OUT / "test-database-before-services.json").open("x", encoding="utf-8") as out:
        json.dump(normalized(read_snapshot(engine)), out, indent=2)
    source.dispose()
    previous.dispose()
    engine.dispose()
    print(
        json.dumps(
            {
                "database": name,
                "version": "0006",
                "tables": 34,
                "accounts": 2,
                "pets": 4,
                "source_0005_unchanged": True,
                "previous_0006_unchanged": True,
                "target_manifest_sha256": hashlib.sha256(target_file.read_bytes()).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    main()
