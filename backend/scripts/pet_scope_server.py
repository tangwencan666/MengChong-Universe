"""Real API/PG/Redis browser lane, strictly bound to one prepared test database."""

import asyncio
import json
from contextlib import asynccontextmanager

import uvicorn
from p4c_memory_server import IsolatedRedis, ObservingSlowMock
from pet_scope_database import CLUSTER, EVIDENCE, read_snapshot
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

import app.agent.chat_runner as runner
from app.core.config import Settings
from app.main import create_app


def main():
    target = json.loads((EVIDENCE / "target.json").read_text(encoding="utf-8"))
    settings = Settings()
    url = make_url(settings.database_url.get_secret_value())
    assert (url.host, url.port, url.username, url.database) == (
        "127.0.0.1",
        25433,
        "weibiye",
        "weibiye_pet_test_" + target["run_id"],
    )
    assert url.database == target["database"] and not url.query
    assert (
        settings.environment == "test"
        and settings.llm_provider == "mock"
        and not settings.real_llm_enabled
    )
    assert (
        settings.memory_management_enabled
        and settings.memory_injection_enabled
        and settings.chat_runner_enabled
    )
    assert settings.auth_store_backend == settings.rate_limit_backend == "redis"
    assert settings.redis_url.get_secret_value() == "redis://127.0.0.1:26380/0"
    engine = create_engine(url.set(drivername="postgresql+psycopg"))
    snapshot = read_snapshot(engine)
    engine.dispose()
    assert (
        snapshot["cluster"] == CLUSTER
        and snapshot["version"] == "0006"
        and len(snapshot["tables"]) == 34
    )
    observations = EVIDENCE / "provider-observations.jsonl"

    def mock_only(config, provider, model):
        assert config.environment == "test" and provider == config.llm_provider == "mock"
        assert not config.real_llm_enabled and model is None
        return ObservingSlowMock(observations)

    runner.build_private_provider = mock_only
    app = create_app(settings)
    original = app.router.lifespan_context

    @asynccontextmanager
    async def isolated_lifespan(application):
        async with original(application):
            facade = IsolatedRedis(
                application.state.redis, "weibiye:pet-test:" + target["run_id"] + ":"
            )
            application.state.redis = facade
            application.state.auth_store.cache = facade
            application.state.chat_scope = target["run_id"]
            try:
                yield
            finally:
                await asyncio.sleep(0)
                (EVIDENCE / "redis-commands.json").write_text(
                    json.dumps({"namespace": facade.prefix, "calls": dict(facade.calls)}),
                    encoding="utf-8",
                )

    app.router.lifespan_context = isolated_lifespan
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=38306,
        access_log=False,
        proxy_headers=False,
        loop="app.core.event_loop:new_event_loop",
    )


if __name__ == "__main__":
    main()
