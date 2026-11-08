"""Loopback-only real P3 API for the explicitly prepared PostgreSQL/Redis target.

The actual auth, CSRF, repositories, runner and SSE routes are used. Only the
fixed local Mock provider is slowed down so cancellation/network tests can act.
No test identity endpoints or HTTP response fixtures are installed.
"""

import asyncio
import os

import uvicorn
from p3_integration_database import local_url, read_manifest, require, snapshot
from redis import Redis
from sqlalchemy.engine import make_url

import app.agent.chat_runner as runner
from app.agent.providers import PrivateMockLLM
from app.core.config import Settings
from app.main import create_app


class SlowLocalMock(PrivateMockLLM):
    async def stream(self, messages, system_prompt):
        # Explicit synthetic fault fixture only in this guarded test launcher.
        if messages[-1]["content"].startswith("[integration-length]"):
            yield "【Mock 演示】" + "🧪" * 8001
            return
        async for chunk in super().stream(messages, system_prompt):
            await asyncio.sleep(0.45)
            yield chunk


def mock_only(settings, provider, model):
    require(
        settings.environment == "test"
        and settings.llm_provider == provider == "mock"
        and not settings.real_llm_enabled
        and model is None,
        "Real models are forbidden in integration acceptance",
    )
    return SlowLocalMock()


def main():
    manifest = read_manifest()
    settings = Settings()
    target = local_url(settings.database_url.get_secret_value())
    require(target.database == manifest["database"], "Wrong integration database")
    require(
        settings.environment == "test"
        and settings.llm_provider == "mock"
        and not settings.real_llm_enabled
        and settings.auth_store_backend == settings.rate_limit_backend == "redis",
        "Integration must use real Redis auth/rate limiting and local Mock output",
    )
    cache_url = make_url(settings.redis_url.get_secret_value())
    require(
        (cache_url.drivername, cache_url.host, cache_url.port, cache_url.database)
        == ("redis", "127.0.0.1", 26380, "15")
        and not cache_url.username
        and not cache_url.password
        and not cache_url.query,
        "Wrong integration Redis target",
    )
    state = snapshot(target)
    require(state["revision"] == "0004" and state["business_tables"] == 21, "Schema mismatch")
    with Redis.from_url(settings.redis_url.get_secret_value(), socket_timeout=3) as cache:
        require(
            cache.info("server")["run_id"] == manifest["redis_run_id"]
            and cache.get(manifest["redis_lease_key"]) == manifest["run_id"].encode(),
            "Redis integration ownership or instance changed",
        )
    api_port = int(os.environ.get("WEIBIYE_E2E_API_PORT", "38101"))
    require(1024 <= api_port <= 65535, "Invalid integration API port")
    runner.build_private_provider = mock_only
    uvicorn.run(
        create_app(settings),
        host="127.0.0.1",
        port=api_port,
        access_log=False,
        proxy_headers=False,
        loop="app.core.event_loop:new_event_loop",
    )


if __name__ == "__main__":
    main()
