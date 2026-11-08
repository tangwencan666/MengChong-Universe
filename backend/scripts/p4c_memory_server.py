"""Guarded real P4-C API; only model output is local observing Mock.

No HTTP identity/fixture backdoor. Observations contain IDs and synthetic content
digests, never source/chat text, Cookie, credentials, full prompts or model input.
"""

import asyncio
import hashlib
import json
import os
from collections import Counter
from contextlib import asynccontextmanager

import uvicorn
from p4c_memory_database import ROOT, local_url, read_manifest, require, snapshot
from redis import Redis

import app.agent.chat_runner as runner
from app.agent.providers import PrivateMockLLM
from app.core.config import Settings
from app.main import create_app


class IsolatedRedis:
    """Transparent namespacing of real auth, limiter and stream-slot Redis commands."""

    def __init__(self, cache, prefix):
        self.cache, self.prefix, self.calls = cache, prefix, Counter()

    async def ping(self):
        return await self.cache.ping()

    async def get(self, key):
        self.calls["get"] += 1
        return await self.cache.get(self.prefix + key)

    async def set(self, key, value, **options):
        require(options.get("ex", 0) > 0, "Acceptance cache writes need TTL")
        self.calls["set"] += 1
        if key.startswith("weibiye:auth:revoked:"):
            self.calls["revocation_set"] += 1
        return await self.cache.set(self.prefix + key, value, **options)

    async def eval(self, script, numkeys, *arguments):
        require(numkeys > 0 and len(arguments) >= numkeys, "Invalid namespaced Lua arguments")
        self.calls["eval"] += 1
        keys = tuple(self.prefix + key for key in arguments[:numkeys])
        return await self.cache.eval(script, numkeys, *keys, *arguments[numkeys:])

    async def zrem(self, key, *members):
        self.calls["zrem"] += 1
        return await self.cache.zrem(self.prefix + key, *members)


class ObservingSlowMock(PrivateMockLLM):
    def __init__(self, output):
        self.output = output

    async def stream(self, messages, system_prompt):
        memories = []
        for message in messages:
            try:
                data = json.loads(message["content"])
            except (ValueError, TypeError):
                continue
            if isinstance(data, dict) and data.get("type") == "authorized_memory_data":
                require(message["role"] == "user", "Memory unexpectedly elevated to system role")
                memories.extend(
                    {
                        "memory_id": item["memory_id"],
                        "version": item["version"],
                        "content_sha256": hashlib.sha256(item["content"].encode()).hexdigest(),
                    }
                    for item in data["items"]
                )
        with self.output.open("a", encoding="utf-8") as out:
            out.write(json.dumps({"provider": "observing-local-mock", "memories": memories}) + "\n")
        async for chunk in super().stream(messages, system_prompt):
            await asyncio.sleep(0.25)
            yield chunk


def main():
    manifest = read_manifest()
    settings = Settings()
    target = local_url(settings.database_url.get_secret_value())
    require(target.database == manifest["database"], "Wrong P4-C test database")
    require(
        settings.redis_url.get_secret_value() == "redis://127.0.0.1:26380/0", "Wrong Redis target"
    )
    require(
        settings.environment == "test"
        and settings.llm_provider == "mock"
        and not settings.real_llm_enabled
        and settings.memory_management_enabled
        and settings.memory_injection_enabled
        and settings.chat_runner_enabled
        and settings.auth_store_backend == settings.rate_limit_backend == "redis",
        "Test API requires actual dependencies, memory, and only local Mock",
    )
    state = snapshot(target)
    require(state["revision"] == "0005" and state["business_tables"] == 26, "Schema mismatch")
    with Redis(host="127.0.0.1", port=26380, db=0, socket_timeout=3) as cache:
        require(
            cache.info("server")["run_id"] == manifest["redis_run_id"]
            and cache.get(manifest["redis_lease_key"]) == manifest["run_id"].encode(),
            "Redis ownership/instance mismatch",
        )
    observations = ROOT / ".verification/p4c-provider-observations.jsonl"

    def mock_only(config, provider, model):
        require(
            config.environment == "test"
            and config.llm_provider == provider == "mock"
            and not config.real_llm_enabled
            and model is None,
            "Real models forbidden",
        )
        return ObservingSlowMock(observations)

    runner.build_private_provider = mock_only
    app = create_app(settings)
    original = app.router.lifespan_context

    @asynccontextmanager
    async def isolated_lifespan(application):
        async with original(application):
            facade = IsolatedRedis(application.state.redis, manifest["redis_prefix"])
            application.state.redis = facade
            application.state.auth_store.cache = facade
            application.state.chat_scope = manifest["run_id"]
            try:
                yield
            finally:
                (ROOT / ".verification/p4c-redis-commands.json").write_text(
                    json.dumps(
                        {"namespace": manifest["redis_prefix"], "calls": dict(facade.calls)}
                    ),
                    encoding="utf-8",
                )

    app.router.lifespan_context = isolated_lifespan
    api_port = int(os.environ.get("WEIBIYE_E2E_API_PORT", "38305"))
    require(1024 <= api_port <= 65535, "Invalid API port")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=api_port,
        access_log=False,
        proxy_headers=False,
        loop="app.core.event_loop:new_event_loop",
    )


if __name__ == "__main__":
    main()
