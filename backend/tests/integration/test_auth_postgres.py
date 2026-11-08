"""Opt-in real PostgreSQL + Redis auth acceptance. All SQL test writes roll back.

No Docker commands, schema resets, downgrades, or test-record deletion. The outer
transaction owns every application commit through SQLAlchemy savepoints.
"""

import json
import os
import re
from collections import Counter
from copy import copy
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.db.base import Base
from app.main import create_app
from app.modules.applications.models import JobApplication
from app.modules.companion.models import AICompanion, ChatMessage, ChatSession
from app.modules.memory.models import Memory
from app.modules.wallet.models import Wallet

EXPECTED_CLUSTER = "7703042374370492450"

pytestmark = pytest.mark.skipif(
    os.environ.get("WEIBIYE_AUTH_PG_TESTS") != "1",
    reason="Explicit local PostgreSQL auth acceptance opt-in required",
)


class NamespacedAuthCache:
    """Forward real auth commands into one verified integration namespace."""

    def __init__(self, cache, prefix):
        self.cache, self.prefix, self.calls = cache, prefix, Counter()

    async def get(self, key):
        self.calls["get"] += 1
        return await self.cache.get(self.prefix + key)

    async def set(self, key, value, **options):
        assert options.get("ex", 0) > 0, "Namespaced auth writes must have a TTL"
        self.calls["set"] += 1
        if key.startswith("weibiye:auth:revoked:"):
            self.calls["revocation_set"] += 1
        return await self.cache.set(self.prefix + key, value, **options)

    async def eval(self, script, numkeys, *arguments):
        assert numkeys > 0 and len(arguments) >= numkeys
        self.calls["eval"] += 1
        keys = tuple(self.prefix + key for key in arguments[:numkeys])
        return await self.cache.eval(script, numkeys, *keys, *arguments[numkeys:])


@pytest.fixture(scope="module")
def postgres_client():
    isolated_url = os.environ.get("WEIBIYE_AUTH_TEST_DATABASE_URL")
    isolated_cache = os.environ.get("WEIBIYE_AUTH_TEST_REDIS_URL")
    assert isolated_url, "Explicit isolated auth PostgreSQL URL required; no development fallback"
    assert isolated_cache, "Explicit isolated auth Redis URL required; no development fallback"
    namespace = os.environ.get("WEIBIYE_AUTH_TEST_REDIS_NAMESPACE")
    run_id = os.environ["WEIBIYE_P3_TEST_RUN_ID"]
    assert re.fullmatch(r"[0-9a-f]{32}", run_id)
    if namespace:
        assert namespace == f"p4integration:test:{run_id}:auth:", "Invalid auth test namespace"
    url = make_url(isolated_url)
    cache_url = make_url(isolated_cache)
    assert url.drivername in {"postgresql", "postgresql+psycopg"}
    assert not url.query, "Database connection query overrides are not allowed"
    assert (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
    assert re.fullmatch(r"weibiye_p3_test_[0-9a-f]{32}", url.database or ""), (
        "Refusing an auth test database without the exact isolated P3 test name"
    )
    url = url.set(drivername="postgresql+psycopg")
    assert not cache_url.query and not cache_url.username and not cache_url.password
    assert (cache_url.drivername, cache_url.host, cache_url.port, cache_url.database) == (
        "redis",
        "127.0.0.1",
        26380,
        "0" if namespace else "15",
    )
    expected = os.environ["WEIBIYE_EXPECTED_PG_CLUSTER_ID"]
    assert expected == EXPECTED_CLUSTER, "Unexpected PostgreSQL cluster identifier"
    lease = (
        f"p4integration:test:{run_id}:owner"
        if namespace
        else f"weibiye:chat:test:{run_id}:integration-owner"
    )
    with Redis.from_url(isolated_cache, socket_timeout=3) as cache:
        assert cache.get(lease) == run_id.encode(), "Isolated Redis test ownership is not verified"
    settings = Settings(
        environment="test",
        demo_enabled=False,
        chat_runner_enabled=False,
        database_url=SecretStr(url.render_as_string(hide_password=False)),
        redis_url=SecretStr(isolated_cache),
        auth_store_backend="redis",
        rate_limit_backend="redis",
        llm_provider="mock",
        real_llm_enabled=False,
        memory_management_enabled=False,
        memory_injection_enabled=False,
    )
    backend = Path(__file__).resolve().parents[2]
    revision = ScriptDirectory.from_config(Config(str(backend / "alembic.ini"))).get_current_head()
    engine = create_engine(url)

    def snapshot():
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            assert (
                db.scalar(text("SELECT system_identifier::text FROM pg_control_system()"))
                == expected
            )
            assert db.scalar(text("SELECT current_database()")) == url.database
            assert db.scalar(text("SELECT version_num FROM alembic_version")) == revision
            return {
                name: db.scalar(text(f'SELECT count(*) FROM "{name}"'))
                for name in Base.metadata.tables
            }

    namespace_cache = None
    try:
        before = snapshot()
        assert all(value == 0 for value in before.values()), "Unexpected existing business data"
        app = create_app(settings)
        with TestClient(
            app,
            backend_options={"loop_factory": new_event_loop},
            headers={"Origin": "http://127.0.0.1:35174"},
            client=("weibiye-auth-acceptance-" + uuid4().hex, 50000),
        ) as client:
            if namespace:
                namespace_cache = NamespacedAuthCache(app.state.redis, namespace)
                app.state.auth_store.cache = namespace_cache
            original = app.state.session_factory

            async def begin():
                connection = await app.state.engine.connect()
                transaction = await connection.begin()
                app.state.session_factory = async_sessionmaker(
                    bind=connection,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                return connection, transaction

            connection, transaction = client.portal.call(begin)
            try:
                yield client
            finally:

                async def finish():
                    app.state.session_factory = original
                    await transaction.rollback()
                    await connection.close()

                client.portal.call(finish)
        after = snapshot()
    finally:
        engine.dispose()
    assert before == after, "PostgreSQL acceptance leaked records outside its transaction"
    if namespace_cache is not None:
        assert all(
            namespace_cache.calls[name] > 0 for name in ("get", "set", "eval", "revocation_set")
        ), "Auth acceptance must use actual namespaced Redis operations"
    output = Path(__file__).resolve().parents[3] / ".verification/auth/postgres-acceptance.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "clusterVerified": True,
                "revision": revision,
                "before": before,
                "after": after,
                "allTestSqlWritesRolledBack": True,
                "redisAuthBackend": "redis",
                "redisNamespace": namespace,
                "redisCommands": dict(namespace_cache.calls) if namespace_cache else None,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def test_real_postgres_redis_auth_and_cross_user_isolation(postgres_client):
    client = postgres_client
    password = "Local-Pg-Acceptance!2026"

    def restore(saved):
        client.cookies.clear()
        for cookie in saved:
            client.cookies.jar.set_cookie(copy(cookie))

    def headers():
        response = client.get("/api/v1/auth/csrf")
        assert response.status_code == 200
        return {"X-CSRF-Token": response.json()["csrf_token"]}

    def register_and_login(email):
        payload = {"email": email, "password": password, "display_name": "PG acceptance"}
        first = client.post("/api/v1/auth/register", json=payload, headers=headers())
        duplicate = client.post("/api/v1/auth/register", json=payload, headers=headers())
        assert (
            first.status_code == duplicate.status_code == 202 and first.json() == duplicate.json()
        )
        response = client.post(
            "/api/v1/auth/login", json={"email": email, "password": password}, headers=headers()
        )
        assert response.status_code == 200, response.text
        return UUID(response.json()["id"]), [copy(cookie) for cookie in client.cookies.jar]

    first, cookies_a = register_and_login(f"pg-a-{uuid4().hex}@example.com")
    client.cookies.clear()
    second, cookies_b = register_and_login(f"pg-b-{uuid4().hex}@example.com")

    async def seed():
        rows = {}
        async with client.app.state.session_factory() as db:
            for uid in (first, second):
                companion, conversation, message, application, memory, wallet = [
                    uuid4() for _ in range(6)
                ]
                db.add(AICompanion(id=companion, owner_id=uid, name="test", persona="mock"))
                await db.flush()
                db.add(
                    ChatSession(
                        id=conversation, owner_id=uid, companion_id=companion, title="private"
                    )
                )
                await db.flush()
                db.add(
                    ChatMessage(
                        id=message,
                        session_id=conversation,
                        owner_id=uid,
                        sequence=0,
                        role="user",
                        content="private",
                        provider="mock",
                    )
                )
                db.add(
                    JobApplication(id=application, owner_id=uid, company="test", position="test")
                )
                db.add(
                    Memory(
                        id=memory,
                        owner_id=uid,
                        content="private",
                        consent_granted_at=datetime.now(UTC),
                    )
                )
                db.add(Wallet(id=wallet, owner_id=uid))
                rows[uid] = {
                    "/companion/companions": companion,
                    "/companion/sessions": conversation,
                    "/applications": application,
                    "/memory": memory,
                    "/wallet": wallet,
                }
            await db.commit()
        return rows

    records = client.portal.call(seed)
    client.cookies.clear()
    restore(cookies_a)
    for path, identifier in records[second].items():
        assert client.get(f"/api/v1{path}/{identifier}").status_code == 404
        # A legacy consent timestamp is not an explicit P4 grant, even for its owner.
        assert client.get(f"/api/v1{path}/{records[first][path]}").status_code == (
            404 if path == "/memory" else 200
        )
        if path != "/wallet":
            listing = client.get(f"/api/v1{path}").json()
            if path == "/companion/sessions":
                listing = listing["items"]
            assert [row["id"] for row in listing] == (
                [] if path == "/memory" else [str(records[first][path])]
            )
    assert client.get("/health/ready").status_code == 200
    captured = [copy(cookie) for cookie in client.cookies.jar]
    assert client.post("/api/v1/auth/logout", headers=headers()).status_code == 204
    restore(captured)
    assert client.get("/api/v1/auth/me").status_code == 401
    client.cookies.clear()
    restore(cookies_b)
    assert client.get("/api/v1/auth/me").status_code == 200
    current_email = client.get("/api/v1/auth/me").json()["email"]
    assert (
        client.post(
            "/api/v1/auth/forgot-password", json={"email": current_email}, headers=headers()
        ).status_code
        == 202
    )
    reset_token = next(
        message.token
        for message in reversed(client.app.state.mailer.messages)
        if message.purpose == "password_reset"
    )
    new_password = "Recovered-Pg-Safe!2026"
    saved = [copy(cookie) for cookie in client.cookies.jar]
    assert (
        client.post(
            "/api/v1/auth/reset-password",
            json={"token": reset_token, "password": new_password},
            headers=headers(),
        ).status_code
        == 200
    )
    restore(saved)
    assert client.get("/api/v1/auth/me").status_code == 401
    client.cookies.clear()
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": current_email, "password": new_password},
            headers=headers(),
        ).status_code
        == 200
    )
