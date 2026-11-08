"""Disposable Windows test server: real SDK, fake key, HTTPX MockTransport only."""

import argparse
import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ui-port", type=int, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".verification/desktop-chat") or not output.is_dir():
        raise RuntimeError("Owned desktop chat evidence directory required")
    if any(name.upper().startswith(("WEIBIYE_", "OPENAI_", "DEEPSEEK_")) for name in os.environ):
        raise RuntimeError("Filtered offline environment required")
    database = output / "offline.sqlite3"
    if database.exists() or (output / "target.json").exists():
        raise RuntimeError("Fixture reuse refused")
    import httpx
    import uvicorn
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from pydantic import SecretStr
    from sqlalchemy import create_engine, text

    from app.agent import providers
    from app.core.config import Settings
    from app.core.event_loop import new_event_loop
    from app.main import create_app

    engine = create_engine("sqlite:///" + database.as_posix())
    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA journal_mode=WAL")).scalar_one() == "wal"
        connection.commit()
        config = Config(str(ROOT / "backend/alembic.ini"))
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        connection.commit()
    engine.dispose()
    origin = f"http://127.0.0.1:{args.ui_port}"
    settings = Settings(
        environment="test",
        database_url="sqlite+aiosqlite:///" + database.as_posix(),
        redis_url="redis://127.0.0.1:1/0",
        auth_store_backend="memory",
        rate_limit_backend="memory",
        frontend_origin=origin,
        cors_origins=[origin],
        chat_runner_enabled=False,
        memory_management_enabled=True,
        memory_hmac_key=SecretStr("desktop-offline-test-only-memory-hmac-0001"),
    )
    definitions = json.loads(
        (ROOT / "desktop/assets/pet-definitions.json").read_text(encoding="utf-8")
    )["pets"]
    accounts = []
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": origin},
    ) as client:
        for number in (1, 2):
            email, password = f"desktop-model-{number}@example.com", "Desktop-Only!2026"

            def post(route, payload):
                csrf = client.get("/api/v1/auth/csrf").json()["csrf_token"]
                return client.post(
                    "/api/v1" + route,
                    json=payload,
                    headers={"X-CSRF-Token": csrf, "Idempotency-Key": str(uuid4())},
                )

            assert (
                post(
                    "/auth/register",
                    {"email": email, "password": password, "display_name": "桌面离线测试"},
                ).status_code
                == 202
            )
            assert post("/auth/login", {"email": email, "password": password}).status_code == 200
            owner = client.get("/api/v1/auth/me").json()["id"]
            pets = []
            for definition in [*definitions, next(p for p in definitions if p["id"] == "hajimi")]:
                response = post(
                    "/pets",
                    {
                        "name": definition["name"],
                        "role_type": definition["role_type"],
                        "persona_config": {
                            "description": definition["persona"],
                            "tone": definition["tone"],
                        },
                        "appearance_config": {
                            "asset_id": definition["id"],
                            "tint": definition["tint"],
                            "scale": 1.0,
                        },
                    },
                )
                assert response.status_code == 201
                pets.append(response.json())
            accounts.append({"email": email, "password": password, "owner_id": owner, "pets": pets})
            client.cookies.clear()
    chosen = [accounts[0]["pets"][4], accounts[0]["pets"][8]]
    settings = Settings.model_validate(
        settings.model_dump()
        | {
            "environment": "development",
            "chat_runner_enabled": True,
            "real_llm_enabled": True,
            "deepseek_api_key": SecretStr("desktop-SDK-fixture-never-a-real-credential"),
            "local_deepseek_pets": [
                {"owner_id": accounts[0]["owner_id"], "pet_id": p["pet_id"]} for p in chosen
            ],
            "local_deepseek_max_requests": 4,
            "deepseek_max_tokens": 64,
        }
    )
    metrics = {
        "fixture": "desktop-deepseek-sdk-offline/1",
        "real_model_requests": 0,
        "mock_upstream_attempts": 0,
        "streams_closed": 0,
    }

    class OfflineStream(httpx.AsyncByteStream):
        def __init__(self, hold):
            self.hold = hold

        async def __aiter__(self):
            for part in ("【离线协议测试，", "非真实模型】", "我只记得当前宠物的这段对话。"):
                await asyncio.sleep(0.3)
                yield event(part)
                if self.hold:
                    await asyncio.Event().wait()
            yield event(None, terminal=True)
            yield b"data: [DONE]\n\n"

        async def aclose(self):
            metrics["streams_closed"] += 1

    def event(content, terminal=False):
        value = {
            "id": "desktop-offline-only",
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
            value["usage"] = {"prompt_tokens": 40, "completion_tokens": 12, "total_tokens": 52}
        return ("data: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode()

    def upstream(request):
        assert (
            request.method == "POST"
            and str(request.url) == "https://api.deepseek.com/chat/completions"
        )
        payload = json.loads(request.content)
        assert payload["model"] == "deepseek-flash" and payload["max_tokens"] == 64
        metrics["mock_upstream_attempts"] += 1
        control = output / "upstream-status"
        if control.exists() and control.read_text().strip() == "429":
            return httpx.Response(429, json={"error": {"message": "synthetic rate limit"}})
        hold = any(
            "OFFLINE_HOLD" in item["content"]
            for item in payload["messages"]
            if item["role"] == "user"
        )
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=OfflineStream(hold)
        )

    original_transport = providers.DefaultAsyncHttpxClient
    providers.DefaultAsyncHttpxClient = lambda **options: original_transport(
        **options, transport=httpx.MockTransport(upstream)
    )
    target = {
        "fixture": metrics["fixture"],
        "ui_origin": origin,
        "backend_origin": f"http://127.0.0.1:{args.port}",
        "accounts": accounts,
        "selected_pet_ids": [p["pet_id"] for p in chosen],
        "real_model_requests": 0,
    }
    with (output / "target.json").open("x", encoding="utf-8") as file:
        json.dump(target, file, ensure_ascii=False, indent=2)
    app = create_app(settings)

    @app.get("/__desktop_chat_fixture/ready")
    async def ready():
        return metrics | {"budget_used": app.state.chat_runner.local_deepseek_budget.used}

    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original_lifespan(application):
            yield
        with (output / "transport-summary.json").open("x", encoding="utf-8") as file:
            json.dump(
                metrics | {"budget_used": application.state.chat_runner.local_deepseek_budget.used},
                file,
            )

    app.router.lifespan_context = lifespan
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning")
    )

    async def serve():
        async def stop():
            while not (output / "stop-requested").exists():  # noqa: ASYNC110
                await asyncio.sleep(0.1)
            server.should_exit = True

        task = asyncio.create_task(stop())
        try:
            await server.serve()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    with asyncio.Runner(loop_factory=new_event_loop) as runner:
        runner.run(serve())


if __name__ == "__main__":
    main()
