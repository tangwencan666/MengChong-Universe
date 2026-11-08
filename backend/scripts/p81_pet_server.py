"""Isolated P8.1 server: offline by default; approved live budgets are one or two.

Never migrates or writes the shared database. No public fault/shutdown backdoor.
Only the exact synthetic owner/pet in the checked manifest can select DeepSeek.
"""

import argparse
import asyncio
import json
import os
import re
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from pathlib import Path
from uuid import UUID

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
OUT = ROOT / ".verification/p81"
REPLY = "【P8.1 离线模拟】月芽的 DeepSeek 流式链路已连通，没有调用真实模型。"
DUMMY_KEY = "p81-synthetic-offline-not-a-real-key"
MAX_PAID_CALLS = 2
MAX_INPUT_BYTES = 4096
APP_STARTUP_TIMEOUT_SECONDS = 20


def require(condition, message="P81 isolation check failed"):
    if not condition:
        raise RuntimeError(message)


def startup_checkpoint(folder, stage):
    require(not (folder / "stop-requested").exists(), "This P81 run is stopping")
    # Fixed internal stage names only; never include configuration or exceptions.
    print("P81 startup phase: " + stage, flush=True)


class PrivateParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "Invalid P81 options. Keys belong only in the backend environment.\n")


def write_event(folder, event, **fields):
    # No prompt, model output, URL query, credential or SDK exception is saved.
    with (folder / "transport-events.jsonl").open("a", encoding="utf-8") as file:
        file.write(json.dumps({"event": event, **fields}) + "\n")


class OfflineStream(httpx.AsyncByteStream):
    def __init__(self, folder):
        self.folder = folder

    async def __aiter__(self):
        parts = [REPLY[:15], REPLY[15:30], REPLY[30:]]
        for index, content in enumerate([*parts, None]):
            terminal = index == len(parts)
            await asyncio.sleep(0.7 if not terminal else 0)
            event = {
                "id": "p81-local-fixture",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "deepseek-flash",
                "choices": [
                    {
                        "index": 0,
                        "delta": {} if terminal else {"content": content},
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
            yield ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode()
        yield b"data: [DONE]\n\n"

    async def aclose(self):
        write_event(self.folder, "stream_closed")


def checked_payload(request, *, max_tokens):
    require(request.method == "POST")
    require(str(request.url) == "https://api.deepseek.com/chat/completions")
    body = json.loads(request.content)
    require(body["model"] == "deepseek-flash" and body["stream"] is True)
    require(body["max_tokens"] == max_tokens and body["thinking"] == {"type": "disabled"})
    require(body["stream_options"] == {"include_usage": True})
    require(isinstance(body["messages"], list) and 1 <= len(body["messages"]) <= 22)
    for item in body["messages"]:
        require(item["role"] in {"system", "user", "assistant"})
        require(isinstance(item["content"], str))
        require("authorized_memory_data" not in item["content"])
    return body


def offline_handler(folder):
    def respond(request):
        require(request.headers["authorization"] == "Bearer " + DUMMY_KEY)
        body = checked_payload(request, max_tokens=512)
        if any(
            item["role"] == "user" and "P81_SIMULATE_UPSTREAM_429" in item["content"]
            for item in body["messages"]
        ):
            write_event(folder, "request", model="deepseek-flash", status=429)
            return httpx.Response(429, json={"error": {"message": "Synthetic rate limit"}})
        write_event(folder, "request", model="deepseek-flash")
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=OfflineStream(folder)
        )

    return respond


class LiveBudget:
    """One event-loop-local, process-wide budget; SDK retries remain disabled."""

    def __init__(self, folder, max_calls=MAX_PAID_CALLS):
        require(type(max_calls) is int and 1 <= max_calls <= MAX_PAID_CALLS)
        self.folder, self.calls, self.max_calls = folder, 0, max_calls

    def admit(self, request):
        body = checked_payload(request, max_tokens=64)
        require(
            sum(len(item["content"].encode()) for item in body["messages"]) <= MAX_INPUT_BYTES,
            "Live synthetic context exceeds its byte budget",
        )
        require(self.calls < self.max_calls, "Approved live request budget exhausted")
        # No await between comparison and increment: concurrent jobs cannot both
        # consume the final slot. A failure/cancel still consumes the slot.
        self.calls += 1
        write_event(
            self.folder, "request", ordinal=self.calls, model="deepseek-flash", max_output_tokens=64
        )


class BudgetedTransport(httpx.AsyncBaseTransport):
    def __init__(self, budget):
        self.budget = budget
        self.inner = httpx.AsyncHTTPTransport(trust_env=False, retries=0)

    async def handle_async_request(self, request):
        self.budget.admit(request)
        return await self.inner.handle_async_request(request)

    async def aclose(self):
        await self.inner.aclose()


def read_target(path, live):
    path = path.resolve()
    require(path.is_relative_to(OUT.resolve()), "Manifest must belong to this P81 checkout")
    target = json.loads(path.read_text(encoding="utf-8"))
    original = json.loads((ROOT / ".verification/p6/target.json").read_text(encoding="utf-8"))
    require(target["databaseName"] == "weibiye_p6_desktop_test_" + original["runId"])
    require(target["accounts"] == original["accounts"])
    require(target["moonOwnerId"] == target["accounts"]["a"]["user_id"])
    require(target["moonPetId"] in {pet["pet_id"] for pet in target["accounts"]["a"]["pets"]})
    require(re.fullmatch(r"[a-f0-9]{32}", target["p81RunId"]))
    prefix = "weibiye:p81:" + ("live:" if live else "") + target["p81RunId"] + ":"
    require(target["redisPrefix"] == prefix)
    port, ui = (38329, 35329) if live else (38319, 35319)
    require(target["backendOrigin"] == f"http://127.0.0.1:{port}" and target["uiPort"] == ui)
    mode = target.get("acceptanceMode", "full")
    require(mode in {"full", "cancel-only"})
    budget = 1 if mode == "cancel-only" else MAX_PAID_CALLS
    require(target["modelTransport"] == (f"live-budgeted-{budget}" if live else "httpx-mock-only"))
    if live:
        require(
            type(target["maxModelRequests"]) is int
            and target["maxModelRequests"] == budget
            and type(target["maxOutputTokens"]) is int
            and target["maxOutputTokens"] == 64
        )
        require(not (path.parent / "stop-requested").exists(), "This live run already ended")
    return target, path.parent, port, ui


def main(argv=None):
    parser = PrivateParser(description=__doc__)
    parser.add_argument("--target", type=Path, default=OUT / "target.json")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--confirm-paid-requests", type=int, default=0)
    args = parser.parse_args(argv)
    require(
        not args.live or args.confirm_paid_requests in {1, MAX_PAID_CALLS},
        "Live mode requires separate approval for the selected bounded request budget",
    )
    # Keep the alias local to P81; global settings and other pets remain Mock.
    key = (
        (
            os.environ.get("WEIBIYE_DEEPSEEK_API_KEY", "").strip()
            or os.environ.get("DEEPSEEK_API_KEY", "").strip()
        )
        if args.live
        else DUMMY_KEY
    )
    require(bool(key.strip()), "Backend process cannot see the DeepSeek key")
    target, folder, port, ui = read_target(args.target, args.live)
    if args.live:
        require(
            args.confirm_paid_requests == target["maxModelRequests"],
            "P81 request approval mismatch",
        )
    print(f"P81 backend process: pid={os.getpid()} parent_pid={os.getppid()}", flush=True)
    startup_checkpoint(folder, "configuration")
    source = make_url(Settings().database_url.get_secret_value())
    require((source.host, source.port, source.database) == ("127.0.0.1", 25433, "weibiye"))
    require(not source.query)
    url = source.set(database=target["databaseName"])
    startup_checkpoint(folder, "database_snapshot")
    engine = create_engine(
        url,
        connect_args={
            "connect_timeout": 5,
            "options": "-c statement_timeout=5000 -c lock_timeout=2000",
        },
    )
    try:
        snapshot = read_snapshot(engine)
        require(
            snapshot["cluster"] == target["cluster"] == CLUSTER, "P81_POSTGRES_CLUSTER_MISMATCH"
        )
        require(
            snapshot["version"] == "0006" and len(snapshot["tables"]) == 34,
            "P81_DATABASE_SCHEMA_MISMATCH",
        )
        startup_checkpoint(folder, "database_guards")
        with engine.begin() as db:
            db.exec_driver_sql("SET TRANSACTION READ ONLY")
            require(
                db.scalar(
                    text(
                        "SELECT count(*) FROM chat_generations WHERE state IN "
                        "('queued','running','cancel_requested')"
                    )
                )
                == 0
            )
            require(
                db.scalar(
                    text("SELECT owner_id::text FROM pets WHERE id=:id"),
                    {"id": target["moonPetId"]},
                )
                == target["moonOwnerId"]
            )
    finally:
        engine.dispose()
    startup_checkpoint(folder, "redis_identity")
    with Redis.from_url(
        "redis://127.0.0.1:26380/0", socket_connect_timeout=3, socket_timeout=3
    ) as cache:
        require(cache.ping(), "P81_REDIS_UNAVAILABLE")
        require(
            cache.info("server")["run_id"] == target["redisRunId"], "P81_REDIS_IDENTITY_MISMATCH"
        )
    startup_checkpoint(folder, "app_configuration")
    settings = Settings(
        _env_prefix="WEIBIYE_P81_INTERNAL_UNUSED_",
        environment="development",
        database_url=SecretStr(url.render_as_string(hide_password=False)),
        redis_url=SecretStr("redis://127.0.0.1:26380/0"),
        llm_provider="mock",
        real_llm_enabled=True,
        deepseek_api_key=SecretStr(key),
        deepseek_model="deepseek-flash",
        deepseek_max_tokens=64 if args.live else 512,
        dev_deepseek_pet_owner_id=UUID(target["moonOwnerId"]),
        dev_deepseek_pet_id=UUID(target["moonPetId"]),
        auth_store_backend="redis",
        rate_limit_backend="redis",
        frontend_origin=f"http://127.0.0.1:{ui}",
        cors_origins=[f"http://127.0.0.1:{ui}"],
        memory_management_enabled=True,
        memory_injection_enabled=True,
        memory_hmac_key=SecretStr("p6-desktop-fixture-only-" + target["runId"]),
        mock_mail_dir=folder / "mock-mail",
        login_ip_limit=300,
        register_ip_limit=200,
        chat_commands_per_minute=100,
        chat_ip_commands_per_minute=1000,
    )
    key = ""
    budget = LiveBudget(folder, max_calls=target["maxModelRequests"]) if args.live else None

    def bounded_client(**options):
        require(options["trust_env"] is False and options["follow_redirects"] is False)
        transport = (
            BudgetedTransport(budget) if budget else httpx.MockTransport(offline_handler(folder))
        )
        return httpx.AsyncClient(transport=transport, **options)

    providers.DefaultAsyncHttpxClient = bounded_client
    app = create_app(settings)
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def isolated_lifespan(application):
        async with AsyncExitStack() as stack:
            async with asyncio.timeout(APP_STARTUP_TIMEOUT_SECONDS):
                await stack.enter_async_context(original_lifespan(application))
            startup_checkpoint(folder, "app_ready")
            cache = IsolatedRedis(application.state.redis, target["redisPrefix"])
            application.state.redis = cache
            application.state.auth_store.cache = cache
            application.state.chat_scope = target["p81RunId"]

            async def watch_stop():
                # A per-run file is the cross-process signal; no public shutdown API.
                while not (folder / "stop-requested").exists():  # noqa: ASYNC110
                    await asyncio.sleep(0.1)
                server.should_exit = True

            watcher = asyncio.create_task(watch_stop())
            if args.live:
                with (folder / "startup.json").open("x", encoding="utf-8") as file:
                    json.dump(
                        {
                            "pid": os.getpid(),
                            "parentPid": os.getppid(),
                            "runId": target["p81RunId"],
                            "modelTransport": target["modelTransport"],
                        },
                        file,
                    )
            try:
                yield
            finally:
                watcher.cancel()
                with suppress(asyncio.CancelledError):
                    await watcher
                (folder / "redis-commands.json").write_text(
                    json.dumps({"prefix": cache.prefix, "calls": dict(cache.calls)}),
                    encoding="utf-8",
                )

    app.router.lifespan_context = isolated_lifespan
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            access_log=False,
            proxy_headers=False,
            loop="app.core.event_loop:new_event_loop",
            timeout_graceful_shutdown=10,
        )
    )
    startup_checkpoint(folder, "app_startup")
    server.run()


def report_failure(error):
    # Only allowlisted codes are printable. SDK/config exception messages are private.
    print("P81 server stopped: isolation/configuration check failed.")
    code = error.args[0] if error.args else None
    if type(code) is str and code in {
        "P81_POSTGRES_CLUSTER_MISMATCH",
        "P81_DATABASE_SCHEMA_MISMATCH",
        "P81_REDIS_UNAVAILABLE",
        "P81_REDIS_IDENTITY_MISMATCH",
    }:
        print("P81 isolation failure: " + code)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report_failure(error)
        raise SystemExit(2) from None
