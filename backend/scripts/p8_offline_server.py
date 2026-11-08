"""P8 acceptance: real isolated PG/Redis, DeepSeek SDK with NO network transport.

The dummy-key upstream is an in-process HTTPX MockTransport. This launcher never
reads a real model key or sends an internet request. It does not migrate a DB.
"""

import asyncio
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from p4c_memory_server import IsolatedRedis
from pet_scope_database import CLUSTER, read_snapshot
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

import app.agent.providers as providers
from app.core.config import Settings
from app.main import create_app

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".verification/p8"
DUMMY_KEY = "p8-offline-synthetic-not-a-real-key"
REPLY = "【DeepSeek 离线模拟】SDK 流式链路已连通；没有访问真实模型。"


def require(condition, message="P8 isolation check failed"):
    if not condition:
        raise RuntimeError(message)


class LocalStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        for part in [REPLY[:12], REPLY[12:26], REPLY[26:]]:
            await asyncio.sleep(0.7)
            yield self.event(part)
        yield self.event(None, terminal=True)
        yield b"data: [DONE]\n\n"

    @staticmethod
    def event(content, terminal=False):
        event = {
            "id": "p8-offline-completion",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "deepseek-flash",
            "choices": [
                {
                    "index": 0,
                    "delta": {} if content is None else {"content": content},
                    "finish_reason": "stop" if terminal else None,
                }
            ],
        }
        if terminal:
            event["usage"] = {
                "prompt_tokens": 40,
                "completion_tokens": 20,
                "total_tokens": 60,
                "prompt_cache_hit_tokens": 10,
                "prompt_cache_miss_tokens": 30,
            }
        return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode()

    async def aclose(self):
        # Called on success, disconnect, cancellation and runner shutdown.
        with (OUT / "transport-events.jsonl").open("a", encoding="utf-8") as file:
            file.write(json.dumps({"event": "stream_closed"}) + "\n")


def offline_response(request):
    # No credential or request-body serialization into observations.
    require(request.method == "POST")
    require(str(request.url) == "https://api.deepseek.com/chat/completions")
    require(request.headers["authorization"] == "Bearer " + DUMMY_KEY)
    body = json.loads(request.content)
    require(body["model"] == "deepseek-flash" and body["stream"] is True)
    require(body["max_tokens"] == 512 and body["thinking"] == {"type": "disabled"})
    require(body["stream_options"] == {"include_usage": True})
    require(not any("authorized_memory_data" in item["content"] for item in body["messages"]))
    with (OUT / "transport-events.jsonl").open("a", encoding="utf-8") as file:
        file.write(json.dumps({"event": "request", "model": body["model"]}) + "\n")
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=LocalStream())


def main():
    original = json.loads((ROOT / ".verification/p6/target.json").read_text(encoding="utf-8"))
    target = json.loads((OUT / "target.json").read_text(encoding="utf-8"))
    require(target["databaseName"] == "weibiye_p6_desktop_test_" + original["runId"])
    require(target["accounts"] == original["accounts"])
    require(re.fullmatch(r"[0-9a-f]{32}", target["p8RunId"]))
    require(target["redisPrefix"] == "weibiye:p8:" + target["p8RunId"] + ":")
    require(target["backendOrigin"] == "http://127.0.0.1:38318" and target["uiPort"] == 35318)
    source = make_url(Settings().database_url.get_secret_value())
    require((source.host, source.port, source.database) == ("127.0.0.1", 25433, "weibiye"))
    url = source.set(database=target["databaseName"])
    engine = create_engine(url)
    snapshot = read_snapshot(engine)
    require(snapshot["cluster"] == target["cluster"] == CLUSTER)
    require(snapshot["version"] == "0006" and len(snapshot["tables"]) == 34)
    with engine.connect() as db:
        require(
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
        require(cache.ping() and cache.info("server")["run_id"] == target["redisRunId"])
    settings = Settings(
        environment="development",
        database_url=SecretStr(url.render_as_string(hide_password=False)),
        redis_url=SecretStr("redis://127.0.0.1:26380/0"),
        auth_store_backend="redis",
        rate_limit_backend="redis",
        llm_provider="deepseek",
        real_llm_enabled=True,
        deepseek_api_key=SecretStr(DUMMY_KEY),
        deepseek_model="deepseek-flash",
        frontend_origin="http://127.0.0.1:35318",
        cors_origins=["http://127.0.0.1:35318"],
        memory_management_enabled=True,
        memory_injection_enabled=False,
        memory_hmac_key=SecretStr("p6-desktop-fixture-only-" + target["runId"]),
        mock_mail_dir=OUT / "mock-mail",
        login_ip_limit=300,
        register_ip_limit=200,
        chat_commands_per_minute=100,
        chat_ip_commands_per_minute=1000,
    )

    # The ordinary provider/factory/runner are exercised. Only the HTTP transport
    # is replaced, and the replacement has no fallback network implementation.
    def no_network_client(**options):
        require(options["trust_env"] is False and options["follow_redirects"] is False)
        return httpx.AsyncClient(transport=httpx.MockTransport(offline_response), **options)

    providers.DefaultAsyncHttpxClient = no_network_client
    app = create_app(settings)
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def isolated_lifespan(application):
        async with original_lifespan(application):
            cache = IsolatedRedis(application.state.redis, target["redisPrefix"])
            application.state.redis = cache
            application.state.auth_store.cache = cache
            application.state.chat_scope = target["p8RunId"]
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
        port=38318,
        access_log=False,
        proxy_headers=False,
        loop="app.core.event_loop:new_event_loop",
    )


if __name__ == "__main__":
    main()
