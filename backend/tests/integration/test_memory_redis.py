"""Opt-in real Redis/auth and isolated PostgreSQL P4-A acceptance; retain test data."""

import os
import re
from collections import Counter
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import make_url
from test_memory_api import (
    account,
    command,
    correction_payload,
    create_item,
    enable,
    item_payload,
    preferences,
    use_account,
)

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app
from app.modules.memory.models import Memory

PREFIX = "/api/v1/memory"
CHAT = "/api/v1/companion"
pytestmark = pytest.mark.skipif(
    not all(
        os.environ.get(name)
        for name in ("WEIBIYE_P4A_TEST_DATABASE_URL", "WEIBIYE_P4A_TEST_REDIS_URL")
    ),
    reason="Requires explicit isolated P4-A PostgreSQL and Redis URLs; no fallback",
)


class PrefixCache:
    """Forward real Redis commands while isolating existing AuthStore namespaces."""

    def __init__(self, cache, prefix):
        self.cache, self.prefix, self.calls = cache, prefix, Counter()

    async def get(self, key):
        self.calls["get"] += 1
        return await self.cache.get(self.prefix + key)

    async def set(self, key, value, **options):
        assert options.get("ex", 0) > 0, "Test Redis writes must expire naturally"
        self.calls["set"] += 1
        if key.startswith("weibiye:auth:revoked:"):
            self.calls["revocation_set"] += 1
        return await self.cache.set(self.prefix + key, value, **options)

    async def eval(self, script, numkeys, *arguments):
        assert numkeys > 0 and len(arguments) >= numkeys
        self.calls["eval"] += 1
        keys = tuple(self.prefix + key for key in arguments[:numkeys])
        return await self.cache.eval(script, numkeys, *keys, *arguments[numkeys:])


@pytest.fixture
def memory_redis_target():
    url = make_url(os.environ["WEIBIYE_P4A_TEST_DATABASE_URL"])
    assert url.drivername in {"postgresql", "postgresql+psycopg"} and not url.query
    assert (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
    assert re.fullmatch(r"weibiye_p4a_test_[0-9a-f]{32}", url.database or "")
    cache_url = os.environ["WEIBIYE_P4A_TEST_REDIS_URL"]
    assert cache_url == "redis://127.0.0.1:26380/0"
    url = url.set(drivername="postgresql+psycopg")
    engine = create_engine(url, connect_args={"connect_timeout": 3})
    try:
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            assert db.scalar(text("SELECT current_database()")) == url.database
            assert db.scalar(text("SELECT current_user")) == "weibiye"
            assert db.scalar(text("SELECT system_identifier::text FROM pg_control_system()")) == (
                "7703042374370492450"
            )
            assert db.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == [
                "0005"
            ]
            assert len(set(inspect(db).get_table_names()) - {"alembic_version"}) == 26
        yield engine, url.render_as_string(hide_password=False), cache_url
    finally:
        engine.dispose()


def test_real_redis_cookie_csrf_memory_crud_and_two_account_isolation(memory_redis_target):
    engine, database_url, cache_url = memory_redis_target
    run = uuid4().hex
    settings = Settings(
        environment="test",
        database_url=SecretStr(database_url),
        redis_url=SecretStr(cache_url),
        auth_store_backend="redis",
        rate_limit_backend="redis",
        memory_management_enabled=True,
        memory_injection_enabled=False,
        memory_hmac_key=SecretStr("p4a-redis-acceptance-only-not-a-production-key"),
        chat_runner_enabled=False,
        llm_provider="mock",
        real_llm_enabled=False,
        frontend_origin="http://testserver",
        cors_origins=["http://testserver"],
    )
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        cache = PrefixCache(client.app.state.redis, f"p4a:test:{run}:")
        client.app.state.auth_store.cache = cache
        client.app.state.chat_scope = run
        assert client.portal.call(client.app.state.redis.ping) is True
        assert client.get("/health/ready").status_code == 200
        owner, cookies_a = account(client, email=f"p4aredis-{run}-a@example.com")
        assert preferences(client)["long_term_memory_enabled"] is False
        enable(client)
        key, payload = str(uuid4()), item_payload(client)
        created = command(client, "POST", "/items", payload, key=key)
        assert created.status_code == 201
        item = created.json()["item"]
        assert client.get(f"{PREFIX}/items/{item['id']}").status_code == 200
        no_csrf = client.patch(
            f"{PREFIX}/items/{item['id']}",
            json=correction_payload(client, item),
            headers={"Idempotency-Key": str(uuid4())},
        )
        assert no_csrf.status_code == 403
        changed = command(
            client,
            "PATCH",
            f"/items/{item['id']}",
            correction_payload(client, item, content="希望了解测试开发岗位。"),
        )
        assert changed.status_code == 200
        item = changed.json()
        assert item["version"] == 2
        exported = command(client, "POST", "/export", {"format": "json"})
        assert exported.status_code == 200
        assert [entry["id"] for entry in exported.json()["items"]] == [item["id"]]
        use_account(client, {})
        other, cookies_b = account(client, email=f"p4aredis-{run}-b@example.com")
        assert owner["id"] != other["id"]
        assert preferences(client)["long_term_memory_enabled"] is False
        assert client.get(f"{PREFIX}/items/{item['id']}").status_code == 404
        enable(client)
        other_item = create_item(client, title="P4ARED 独立账户")
        use_account(client, cookies_a)
        assert client.get(f"{PREFIX}/items/{other_item['id']}").status_code == 404
        topic = client.get(CHAT + "/preferences").json()
        enabled_topic = client.patch(
            CHAT + "/preferences",
            json={"recent_topic_enabled": True, "expected_version": topic["version"]},
            headers=csrf(client),
        )
        assert enabled_topic.status_code == 200
        closed = command(
            client,
            "PATCH",
            "/preferences",
            {"long_term_memory_enabled": False, "expected_version": preferences(client)["version"]},
        )
        assert closed.status_code == 200 and not closed.json()["long_term_memory_enabled"]
        assert client.get(CHAT + "/preferences").json()["recent_topic_enabled"] is True
        assert client.get(PREFIX).json() == []
        inactive = client.get(f"{PREFIX}/items/{item['id']}")
        assert inactive.status_code == 200 and inactive.json()["status"] == "revoked"
        deleted = command(
            client,
            "DELETE",
            f"/items/{item['id']}",
            {"expected_version": inactive.json()["version"]},
        )
        assert deleted.status_code == 204
        assert command(client, "POST", "/items", payload, key=key).status_code == 410
        stale_cookies = type(client.cookies)(client.cookies)
        assert client.post("/api/v1/auth/logout", headers=csrf(client)).status_code == 204
        use_account(client, stale_cookies)
        assert client.get(PREFIX + "/preferences").status_code == 401
        use_account(client, cookies_b)
        assert client.get(f"{PREFIX}/items/{other_item['id']}").status_code == 200
        assert all(cache.calls[name] > 0 for name in ("get", "set", "eval", "revocation_set"))
    with engine.connect() as db:
        db.execute(text("SET TRANSACTION READ ONLY"))
        saved = db.execute(
            select(Memory.status, Memory.content, Memory.title, Memory.summary).where(
                Memory.id == UUID(item["id"]), Memory.owner_id == UUID(owner["id"])
            )
        ).one()
        assert tuple(saved) == ("deleted", "", "", "")
