"""P8.4 Windows acceptance: fresh SQLite, five templates, local paced Mock only."""

import argparse
import asyncio
import json
import os
import socket
import sys
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--ui-port", type=int, required=True)
    args = parser.parse_args()
    if any(name.upper().startswith(("WEIBIYE_", "OPENAI_", "DEEPSEEK_")) for name in os.environ):
        raise RuntimeError("Filtered test environment required")
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".verification/p84") or not output.is_dir():
        raise RuntimeError("Owned new P84 evidence directory required")
    database = output / "p84-offline.sqlite3"
    if database.exists() or (output / "target.json").exists():
        raise RuntimeError("Fixture reuse refused")
    listener = socket.socket()
    listener.bind(("127.0.0.1", args.port))
    listener.setblocking(False)
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from pydantic import SecretStr
    from sqlalchemy import create_engine

    from app.agent import providers
    from app.core.config import Settings
    from app.core.event_loop import new_event_loop
    from app.db.capabilities import require_enabled_capabilities
    from app.main import create_app

    engine = create_engine("sqlite:///" + database.as_posix())
    try:
        config = Config(str(BACKEND / "alembic.ini"))
        with engine.connect() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
            connection.commit()
    finally:
        engine.dispose()
    original = providers.PrivateMockLLM.stream

    async def paced(self, messages, system_prompt):
        async for chunk in original(self, messages, system_prompt):
            await asyncio.sleep(0.3)
            yield chunk

    providers.PrivateMockLLM.stream = paced
    origin = f"http://127.0.0.1:{args.ui_port}"
    settings = Settings(
        _env_prefix="P84_UNUSED_",
        environment="test",
        database_url=SecretStr("sqlite+aiosqlite:///" + database.as_posix()),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        llm_provider="mock",
        real_llm_enabled=False,
        deepseek_api_key=None,
        openai_api_key=None,
        auth_store_backend="memory",
        rate_limit_backend="memory",
        frontend_origin=origin,
        cors_origins=[origin],
        memory_management_enabled=True,
        memory_hmac_key=SecretStr("p84-offline-fixture-only-memory-hmac-0000001"),
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
        for number in [1, 2]:
            email, password = f"p84-local-{number}@example.com", "P84-Local-Only!2026"

            def post(route, payload):
                csrf = client.get("/api/v1/auth/csrf").json()["csrf_token"]
                response = client.post(
                    "/api/v1" + route,
                    json=payload,
                    headers={"X-CSRF-Token": csrf, "Idempotency-Key": str(uuid4())},
                )
                return response

            assert (
                post(
                    "/auth/register",
                    {"email": email, "password": password, "display_name": "P84离线验收"},
                ).status_code
                == 202
            )
            assert post("/auth/login", {"email": email, "password": password}).status_code == 200
            owner = client.get("/api/v1/auth/me").json()["id"]
            pets = []
            for definition in definitions:
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
    target = {
        "fixture": "p84-sqlite-mock-only/1",
        "database": str(database),
        "ui_origin": origin,
        "backend_origin": f"http://127.0.0.1:{args.port}",
        "accounts": accounts,
        "real_model_requests": 0,
    }
    with (output / "target.json").open("x", encoding="utf-8") as stream:
        json.dump(target, stream, ensure_ascii=False, indent=2)
    app = create_app(settings)

    @app.get("/__p84_fixture/ready")
    async def ready():
        assert settings.llm_provider == "mock" and not settings.real_llm_enabled
        assert settings.deepseek_api_key is None and settings.openai_api_key is None
        async with app.state.session_factory() as db:
            await require_enabled_capabilities(db, settings, verify_schema=True)
        return {"fixture": "p84-sqlite-mock-only/1", "schema_ready": True}

    import uvicorn

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
            await server.serve(sockets=[listener])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            listener.close()

    with asyncio.Runner(loop_factory=new_event_loop) as runner:
        runner.run(serve())


if __name__ == "__main__":
    main()
