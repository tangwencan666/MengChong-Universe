"""Loopback TLS + real React/auth/chat + synthetic mailbox + Mock, never deployment."""

import argparse
import asyncio
import hashlib
import json
import mimetypes
import os
import socket
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--certificate", type=Path, required=True)
    parser.add_argument("--private-key", type=Path, required=True)
    args = parser.parse_args()
    if any(name.upper().startswith(("WEIBIYE_", "OPENAI_", "DEEPSEEK_")) for name in os.environ):
        raise RuntimeError("Filtered environment required")
    run = args.output.resolve()
    if not run.is_relative_to(ROOT / ".verification" / "p83") or not run.is_dir():
        raise RuntimeError("Owned new P83 evidence directory required")
    database = run / "p83-https.sqlite3"
    if database.exists() or (run / "target.json").exists():
        raise RuntimeError("Fixture reuse forbidden")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", args.port))
    listener.setblocking(False)
    from alembic import command
    from alembic.config import Config
    from fastapi import HTTPException, Request
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
    from pydantic import SecretStr
    from sqlalchemy import create_engine

    from app.core.config import Settings
    from app.core.event_loop import new_event_loop
    from app.main import create_app
    from app.modules.auth.mail import MockMailSender
    from app.modules.beta_quota.models import BetaInvitation

    engine = create_engine("sqlite:///" + database.as_posix())
    try:
        for file in ["alembic.ini", "beta_quota_alembic.ini"]:
            config = Config(str(BACKEND / file))
            with engine.connect() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "head")
                connection.commit()
        with engine.begin() as db:
            db.execute(
                BetaInvitation.__table__.insert().values(
                    code_hash=hashlib.sha256(b"p83-local-synthetic-invitation-0000001").hexdigest(),
                    grant_requests=20,
                    expires_at=datetime.now(UTC) + timedelta(days=1),
                    grant_expires_at=datetime.now(UTC) + timedelta(days=14),
                )
            )
    finally:
        engine.dispose()
    origin = f"https://p83.weibiye.test:{args.port}"
    settings = Settings(
        _env_prefix="P83_UNUSED_",
        environment="test",
        database_url=SecretStr("sqlite+aiosqlite:///" + database.as_posix()),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        llm_provider="mock",
        real_llm_enabled=False,
        deepseek_api_key=None,
        openai_api_key=None,
        auth_store_backend="memory",
        rate_limit_backend="memory",
        cookie_secure=True,
        require_verified_email=True,
        frontend_origin=origin,
        cors_origins=[origin],
        memory_management_enabled=True,
        memory_hmac_key=SecretStr("p83-mock-memory-only-never-production"),
        beta_quota_enabled=True,
        beta_pricing_attested=True,
        beta_pricing_version="p83-offline-synthetic",
        beta_request_ceiling_microusd=100,
        beta_global_daily_budget_microusd=10000,
        beta_telemetry_enabled=True,
        beta_telemetry_hmac_key=SecretStr("p83-local-telemetry-hmac-never-production"),
    )
    mailbox = MockMailSender(origin=origin)
    app = create_app(settings, mailer=mailbox)
    target = {
        "fixture": "p83-loopback-https-mock/1",
        "origin": origin,
        "database": str(database),
        "real_model_requests": 0,
        "certificate": str(args.certificate),
        "public_deployment": False,
    }
    (run / "target.json").write_text(json.dumps(target, indent=2), encoding="utf-8")

    @app.get("/__p83_fixture/ready")
    async def ready():
        assert settings.llm_provider == "mock" and not settings.real_llm_enabled
        assert settings.deepseek_api_key is None and settings.openai_api_key is None
        assert app.state.schema_ready
        return {"fixture": "p83-loopback-https-mock/1", "ready": True, "schema_ready": True}

    @app.get("/__p83_fixture/mail")
    async def mail(request: Request, recipient: str):
        if request.client.host != "127.0.0.1" or not recipient.endswith("@example.com"):
            raise HTTPException(404)
        message = next(
            (item for item in reversed(mailbox.messages) if item.recipient == recipient), None
        )
        if message is None:
            raise HTTPException(404)
        return {"link": message.link, "mock": True}

    @app.get("/__p83_fixture/metrics")
    async def metrics(request: Request):
        # Test-only aggregate: no subjects, email, text or tokens are returned.
        if request.client.host != "127.0.0.1":
            raise HTTPException(404)
        from sqlalchemy import func, select

        from app.modules.beta_quota.privacy_models import BetaTelemetryEvent

        async with app.state.session_factory() as db:
            rows = await db.execute(
                select(BetaTelemetryEvent.kind, func.count()).group_by(BetaTelemetryEvent.kind)
            )
            return {"counts": dict(rows.all())}

    # Windows file associations can override .js to text/plain; fixture serves modules.
    mimetypes.add_type("application/javascript", ".js")
    app.mount(
        "/assets", StaticFiles(directory=ROOT / "frontend/dist/assets"), name="fixture-assets"
    )

    @app.get("/{path:path}")
    async def ui(path: str):
        if path.startswith(("api/", "health/", "__p83_fixture/")):
            raise HTTPException(404)
        return FileResponse(ROOT / "frontend/dist/index.html")

    import uvicorn

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=args.port,
            ssl_certfile=str(args.certificate),
            ssl_keyfile=str(args.private_key),
            access_log=False,
            log_level="warning",
        )
    )

    async def run_server():
        async def stop():
            while not (run / "stop-requested").exists():  # noqa: ASYNC110
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
        runner.run(run_server())


if __name__ == "__main__":
    main()
