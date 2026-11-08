"""Real 0004 chat/Redis compatibility before the isolated P4 forward migration.

Only the manifest-owned p4a database is writable. Cookies stay in process memory;
the evidence file has no credentials, message bodies, or session secrets.
"""

from copy import copy
from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from p4_integration_database import read_manifest, target_url
from p4c_memory_database import ROOT, identity, require, snapshot, write_new
from p4c_memory_server import IsolatedRedis
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import MetaData, Table, create_engine, select

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app

PREFIX = "/api/v1/companion"
OUTPUT = ROOT / ".verification/p4-v4-smoke.json"


def command(client, method, path, payload=None, *, idempotent=False):
    csrf = client.get("/api/v1/auth/csrf")
    require(csrf.status_code == 200, "CSRF issuance failed")
    headers = {"X-CSRF-Token": csrf.json()["csrf_token"]}
    if idempotent:
        headers["Idempotency-Key"] = str(uuid4())
    return client.request(method, path, json=payload, headers=headers)


def isolate_cache(client, manifest):
    cache = IsolatedRedis(client.app.state.redis, manifest["redis_prefix"] + "v4:")
    client.app.state.redis = client.app.state.auth_store.cache = cache
    client.app.state.chat_scope = manifest["run_id"] + "-v4"
    return cache


def main():
    manifest = read_manifest()
    require(manifest["phase"] == "prepared-0004", "Run only before the isolated promotion")
    require(not OUTPUT.exists(), "V4 smoke evidence exists; refusing duplicate run")
    url = target_url(manifest, "p4a")
    before = snapshot(url)
    require(before["revision"] == "0004" and before["business_tables"] == 21, "Wrong V4 target")
    with Redis(host="127.0.0.1", port=26380, db=0, socket_timeout=3) as cache:
        require(
            cache.info("server")["run_id"] == manifest["redis_run_id"]
            and cache.get(manifest["redis_lease_key"]) == manifest["run_id"].encode(),
            "Redis ownership/instance mismatch",
        )
    settings = Settings(
        environment="test",
        database_url=SecretStr(url.render_as_string(hide_password=False)),
        redis_url=SecretStr("redis://127.0.0.1:26380/0"),
        auth_store_backend="redis",
        rate_limit_backend="redis",
        chat_runner_enabled=False,
        memory_management_enabled=False,
        memory_injection_enabled=False,
        llm_provider="mock",
        real_llm_enabled=False,
        frontend_origin="http://testserver",
        cors_origins=["http://testserver"],
    )
    options = {
        "backend_options": {"loop_factory": new_event_loop},
        "headers": {"Origin": "http://testserver"},
    }
    counts = {}
    with TestClient(create_app(settings), **options) as client:
        cache = isolate_cache(client, manifest)
        require(client.get("/health/live").status_code == 200, "V4 liveness failed")
        require(client.get("/health/ready").status_code == 200, "V4 readiness failed")
        email = "p4-v4-" + manifest["run_id"] + "@example.com"
        password = "Isolated-V4-Mock-Only!2026"
        registration = command(
            client,
            "POST",
            "/api/v1/auth/register",
            {"email": email, "password": password, "display_name": "P4 V4 synthetic acceptance"},
        )
        require(registration.status_code == 202, "V4 registration failed")
        login = command(
            client, "POST", "/api/v1/auth/login", {"email": email, "password": password}
        )
        require(login.status_code == 200, "V4 login failed")
        owner = UUID(login.json()["id"])
        cookies = [copy(cookie) for cookie in client.cookies.jar]
        created = command(
            client, "POST", PREFIX + "/sessions", {"title": "V4 acceptance"}, idempotent=True
        )
        require(created.status_code == 201, "V4 session creation failed")
        session_id = created.json()["session"]["id"]
        sent = command(
            client,
            "POST",
            PREFIX + f"/sessions/{session_id}/messages",
            {"content": "V4 synthetic mock compatibility probe", "client_message_id": str(uuid4())},
            idempotent=True,
        )
        require(sent.status_code == 202, "V4 message creation failed")
        require(client.portal.call(client.app.state.chat_runner.run_once), "V4 worker did not run")
        accepted = sent.json()
        stream = client.get(accepted["events_url"])
        require(
            stream.status_code == 200
            and "event: completed" in stream.text
            and "event: delta" in stream.text,
            "V4 local Mock SSE did not complete",
        )
        history = client.get(PREFIX + f"/sessions/{session_id}/messages")
        require(history.status_code == 200, "V4 history unavailable")
        messages = history.json()["items"]
        require(
            len(messages) == 2 and all(item["content"] for item in messages),
            "V4 history not persisted",
        )
        message_ids = [item["id"] for item in messages]
        require(
            client.get("/api/v1/memory/preferences").status_code == 503,
            "V4 memory must fail closed",
        )
        counts.update(cache.calls)
    # Recreate the actual application/connection pool, retaining only the Cookie in RAM.
    with TestClient(create_app(settings), **options) as fresh:
        cache = isolate_cache(fresh, manifest)
        for cookie in cookies:
            fresh.cookies.jar.set_cookie(copy(cookie))
        require(fresh.get("/api/v1/auth/me").status_code == 200, "V4 Cookie restore failed")
        restored = fresh.get(PREFIX + f"/sessions/{session_id}/messages")
        require(restored.status_code == 200, "V4 new application history failed")
        require(
            [item["id"] for item in restored.json()["items"]] == message_ids,
            "V4 history IDs changed",
        )
        for key, value in cache.calls.items():
            counts[key] = counts.get(key, 0) + value
    engine = create_engine(url, connect_args={"connect_timeout": 3})
    try:
        with engine.begin() as db:
            identity(db, manifest["databases"]["p4a"])
            require(snapshot(url)["revision"] == "0004", "Target changed before legacy probe")
            legacy = Table("memories", MetaData(), autoload_with=db)
            memory_id = uuid4()
            db.execute(
                legacy.insert().values(
                    id=memory_id,
                    owner_id=owner,
                    content="Synthetic legacy fact without a P4 grant",
                    source_session_id=UUID(session_id),
                    consent_granted_at=datetime.now(UTC),
                )
            )
            require(
                db.scalar(select(legacy.c.id).where(legacy.c.id == memory_id)) == memory_id,
                "Legacy seed failed",
            )
    finally:
        engine.dispose()
    result = {
        "database": manifest["databases"]["p4a"],
        "revision": "0004",
        "register_login_cookie_csrf": True,
        "real_redis_calls": counts,
        "mock_graph_sse_complete": True,
        "persisted_messages": 2,
        "fresh_application_cookie_and_history_restored": True,
        "memory_management_rejected_503": True,
        "synthetic_legacy_memory_seeded": True,
    }
    write_new(OUTPUT, result)
    print("V4 real PostgreSQL/Redis, Cookie restore, Mock graph/SSE and history verified.")


if __name__ == "__main__":
    main()
