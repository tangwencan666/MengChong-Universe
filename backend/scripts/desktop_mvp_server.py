"""Fixed-port, strictly isolated P6 API. Real PG/Redis, local observing Mock only."""

import json
from contextlib import asynccontextmanager

import uvicorn
from desktop_mvp_database import OUT, UI
from p4c_memory_server import IsolatedRedis, ObservingSlowMock
from pet_scope_database import CLUSTER, read_snapshot
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

import app.agent.chat_runner as runner
from app.core.config import Settings
from app.main import create_app


def main():
    target = json.loads((OUT / "target.json").read_text(encoding="utf-8"))
    assert target["databaseName"] == "weibiye_p6_desktop_test_" + target["runId"]
    assert target["cluster"] == CLUSTER and target["schemaVersion"] == "0006"
    original = make_url(Settings().database_url.get_secret_value())
    assert (original.host, original.port, original.database) == ("127.0.0.1", 25433, "weibiye")
    url = original.set(database=target["databaseName"])
    engine = create_engine(url)
    snapshot = read_snapshot(engine)
    assert (
        snapshot["cluster"] == CLUSTER
        and snapshot["version"] == "0006"
        and len(snapshot["tables"]) == 34
    )
    with engine.connect() as db:
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM chat_generations "
                    "WHERE state IN ('queued','running','cancel_requested')"
                )
            )
            == 0
        )
    engine.dispose()
    with Redis.from_url("redis://127.0.0.1:26380/0", socket_timeout=3) as cache:
        assert cache.ping() and cache.info("server")["run_id"] == target["redisRunId"]
    settings = Settings(
        environment="test",
        database_url=SecretStr(url.render_as_string(hide_password=False)),
        redis_url=SecretStr("redis://127.0.0.1:26380/0"),
        auth_store_backend="redis",
        rate_limit_backend="redis",
        llm_provider="mock",
        real_llm_enabled=False,
        frontend_origin=UI,
        cors_origins=[UI],
        chat_runner_enabled=True,
        memory_management_enabled=True,
        memory_injection_enabled=True,
        memory_hmac_key=SecretStr("p6-desktop-fixture-only-" + target["runId"]),
        mock_mail_dir=OUT / "mock-mail",
        login_ip_limit=300,
        register_ip_limit=200,
        chat_commands_per_minute=100,
        chat_ip_commands_per_minute=1000,
    )

    def only_mock(config, provider, model):
        assert config.environment == "test" and config.llm_provider == provider == "mock"
        assert not config.real_llm_enabled and model is None
        return ObservingSlowMock(OUT / "provider-observations.jsonl")

    runner.build_private_provider = only_mock
    app = create_app(settings)
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def isolated_lifespan(application):
        async with original_lifespan(application):
            cache = IsolatedRedis(application.state.redis, target["redisPrefix"])
            application.state.redis = cache
            application.state.auth_store.cache = cache
            application.state.chat_scope = target["runId"]
            try:
                yield
            finally:
                (OUT / "redis-commands.json").write_text(
                    json.dumps({"prefix": cache.prefix, "calls": dict(cache.calls)}),
                    encoding="utf-8",
                )

    app.router.lifespan_context = isolated_lifespan
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=38316,
        access_log=False,
        proxy_headers=False,
        loop="app.core.event_loop:new_event_loop",
    )


if __name__ == "__main__":
    main()
