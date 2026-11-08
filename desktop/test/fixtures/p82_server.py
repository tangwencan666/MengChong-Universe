"""P8.2 acceptance only: new SQLite file, memory auth, local Mock, no model keys."""

import argparse
import asyncio
import json
import os
import socket
import sys
from pathlib import Path
from uuid import uuid4

REPOSITORY = Path(__file__).resolve().parents[3]
BACKEND = REPOSITORY / "backend"
sys.path.insert(0, str(BACKEND))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ui-port", type=int, required=True)
    args = parser.parse_args()
    if any(name.upper().startswith(("WEIBIYE_", "OPENAI_", "DEEPSEEK_")) for name in os.environ):
        raise RuntimeError("Fixture requires a filtered environment without model credentials")
    if not args.output.is_absolute() or not args.output.is_dir():
        raise RuntimeError("Existing absolute new evidence directory required")
    if not 1024 <= args.port <= 65535 or not 1024 <= args.ui_port <= 65535:
        raise RuntimeError("Invalid local fixture ports")
    database = args.output / "p82-offline.sqlite3"
    if database.exists() or (args.output / "target.json").exists():
        raise RuntimeError("Refusing to reuse fixture data")
    # Bind before creating data. Never start against an existing service.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", args.port))
    listener.setblocking(False)

    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from pydantic import SecretStr

    os.environ["WEIBIYE_DATABASE_URL"] = "sqlite:///" + database.as_posix()
    command.upgrade(Config(str(BACKEND / "alembic.ini")), "head")
    del os.environ["WEIBIYE_DATABASE_URL"]

    import uvicorn

    from app.agent import providers
    from app.core.config import Settings
    from app.core.event_loop import new_event_loop
    from app.db.capabilities import require_enabled_capabilities
    from app.main import create_app

    original_stream = providers.PrivateMockLLM.stream

    async def paced_mock(self, messages, system_prompt):
        # Visible state transitions only. This remains explicitly synthetic.
        async for chunk in original_stream(self, messages, system_prompt):
            await asyncio.sleep(0.3)
            yield chunk

    providers.PrivateMockLLM.stream = paced_mock

    origin = f"http://127.0.0.1:{args.ui_port}"
    settings = Settings(
        _env_prefix="WEIBIYE_P82_UNUSED_",
        environment="test",
        database_url=SecretStr("sqlite+aiosqlite:///" + database.as_posix()),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        llm_provider="mock",
        real_llm_enabled=False,
        auth_store_backend="memory",
        rate_limit_backend="memory",
        frontend_origin=origin,
        cors_origins=[origin],
        memory_management_enabled=True,
        memory_hmac_key=SecretStr("p82-local-offline-memory-fixture-only"),
        mock_mail_dir=args.output / "mock-mail",
    )
    # Fixture accounts and pets are created through actual API validation.
    accounts = []
    with TestClient(create_app(settings), headers={"Origin": origin}) as client:
        for number in (1, 2):
            email = f"p82-offline-{number}@example.com"
            password = "P82-Local-Only!2026"

            def post(route, payload):
                csrf = client.get("/api/v1/auth/csrf").json()["csrf_token"]
                return client.post(
                    "/api/v1" + route,
                    json=payload,
                    headers={"X-CSRF-Token": csrf, "Idempotency-Key": str(uuid4())},
                )

            response = post(
                "/auth/register",
                {"email": email, "password": password, "display_name": f"离线桌面验收{number}"},
            )
            assert response.status_code == 202
            assert post("/auth/login", {"email": email, "password": password}).status_code == 200
            owner = client.get("/api/v1/auth/me").json()["id"]
            pets = []
            for name, role in (("月芽", "cat"), ("豆包", "dog"), ("小云", "custom")):
                response = post(
                    "/pets",
                    {
                        "name": name,
                        "role_type": role,
                        "persona_config": {"description": "离线验收，温和简短", "tone": "calm"},
                    },
                )
                assert response.status_code == 201
                pets.append(response.json())
            accounts.append({"email": email, "password": password, "owner_id": owner, "pets": pets})
            client.cookies.clear()

    target = {
        "fixture": "p82-sqlite-mock-only/1",
        "real_model_requests": 0,
        "paced_mock_seconds_per_chunk": 0.3,
        "backend_origin": f"http://127.0.0.1:{args.port}",
        "ui_origin": origin,
        "database": str(database),
        "accounts": accounts,
    }
    with (args.output / "target.json").open("x", encoding="utf-8") as file:
        json.dump(target, file, ensure_ascii=False, indent=2)
    application = create_app(settings)

    @application.get("/__p82_fixture/ready")
    async def fixture_ready():
        # Production /health/ready still requires Redis and is not changed.
        assert application.state.settings.llm_provider == "mock"
        assert application.state.settings.real_llm_enabled is False
        async with application.state.session_factory() as session:
            await require_enabled_capabilities(session, settings, verify_schema=True)
        return {"fixture": "p82-sqlite-mock-only/1", "schema_ready": True}

    server = uvicorn.Server(
        uvicorn.Config(
            application,
            host="127.0.0.1",
            port=args.port,
            access_log=False,
            log_level="warning",
        )
    )

    async def run():
        async def stop():
            while not (args.output / "stop-requested").exists():  # noqa: ASYNC110
                await asyncio.sleep(0.1)
            server.should_exit = True

        task = asyncio.create_task(stop())
        try:
            await server.serve(sockets=[listener])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            listener.close()

    with asyncio.Runner(loop_factory=new_event_loop) as runner:
        runner.run(run())


if __name__ == "__main__":
    main()
