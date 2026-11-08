"""Real Redis pool saturation must fail closed and recover without restarting Redis."""

import os
import re

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from redis import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy.engine import make_url
from test_auth_postgres import NamespacedAuthCache

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app


@pytest.mark.skipif(
    not os.environ.get("WEIBIYE_AUTH_TEST_REDIS_URL"),
    reason="Explicit isolated P3 Redis ownership is required",
)
def test_real_redis_pool_exhaustion_fails_closed_then_recovers():
    database = os.environ["WEIBIYE_CHAT_TEST_DATABASE_URL"]
    cache_url = os.environ["WEIBIYE_AUTH_TEST_REDIS_URL"]
    parsed = make_url(database)
    assert (parsed.host, parsed.port, parsed.username) == ("127.0.0.1", 25433, "weibiye")
    assert not parsed.query and re.fullmatch(r"weibiye_p3_test_[0-9a-f]{32}", parsed.database)
    run_id = os.environ["WEIBIYE_P3_TEST_RUN_ID"]
    assert re.fullmatch(r"[0-9a-f]{32}", run_id)
    namespace = os.environ.get("WEIBIYE_AUTH_TEST_REDIS_NAMESPACE")
    if namespace:
        assert namespace == f"p4integration:test:{run_id}:auth:"
        assert parsed.database == "weibiye_p3_test_" + run_id
        assert cache_url == "redis://127.0.0.1:26380/0"
        lease = f"p4integration:test:{run_id}:owner"
    else:
        assert cache_url == "redis://127.0.0.1:26380/15"
        lease = f"weibiye:chat:test:{run_id}:integration-owner"
    with Redis.from_url(cache_url, socket_timeout=3) as cache:
        assert cache.get(lease) == run_id.encode()
    settings = Settings(
        environment="test",
        database_url=SecretStr(database),
        redis_url=SecretStr(cache_url),
        auth_store_backend="redis",
        rate_limit_backend="redis",
        chat_runner_enabled=False,
        llm_provider="mock",
        real_llm_enabled=False,
    )
    with TestClient(
        create_app(settings), backend_options={"loop_factory": new_event_loop}
    ) as client:
        if namespace:
            # Occupy only this application's real connection pool. All auth
            # commands still reach Redis, restricted to our manifest-owned keys.
            client.app.state.auth_store.cache = NamespacedAuthCache(
                client.app.state.redis, namespace + "pool:"
            )
        pool = client.app.state.redis.connection_pool
        held = []

        async def occupy():
            for _ in range(32):
                held.append(await pool.get_connection())
            with pytest.raises(RedisConnectionError):
                await pool.get_connection()

        async def release():
            for connection in held:
                await pool.release(connection)

        try:
            client.portal.call(occupy)
            assert client.get("/health/ready").status_code == 503
            denied = client.get("/api/v1/auth/csrf")
            assert denied.status_code == 503
            assert denied.json()["error"]["code"] == "AUTH_STORE_UNAVAILABLE"
        finally:
            client.portal.call(release)
        assert client.get("/health/ready").status_code == 200
        assert client.get("/api/v1/auth/csrf").status_code == 200
