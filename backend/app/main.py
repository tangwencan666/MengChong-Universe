import asyncio
import secrets
from contextlib import asynccontextmanager
from uuid import uuid4

from anyio import CapacityLimiter, to_thread
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis
from sqlalchemy.pool import StaticPool

from app.agent.chat_runner import ChatRunner
from app.api.health import router as health_router
from app.api.router import router
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.core.logging import configure_logging
from app.core.middleware import install_request_middleware
from app.core.rate_limit import MemoryWindowLimiter
from app.db import models  # noqa: F401
from app.db.capabilities import SchemaUnavailable, require_enabled_capabilities
from app.db.session import build_database
from app.modules.auth.mail import MailSender, MockMailSender
from app.modules.auth.service import PASSWORD_HASHER
from app.modules.auth.store import AuthStore
from app.modules.beta_quota.privacy_router import router as beta_privacy_router
from app.modules.beta_quota.router import router as beta_quota_router


def create_app(settings: Settings | None = None, *, mailer: MailSender | None = None) -> FastAPI:
    settings = settings or get_settings()
    if (
        settings.environment == "production"
        and (settings.beta_quota_enabled or settings.beta_telemetry_enabled)
        and (mailer is None or isinstance(mailer, MockMailSender))
    ):
        raise ValueError("Beta production requires an explicitly configured real mail sender")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging()
        engine, factory = build_database(settings.database_url.get_secret_value())
        if isinstance(engine.pool, StaticPool):
            # Allocate the single in-memory SQLite connection before the supervisor
            # and HTTP requests can race to create two initial StaticPool connections.
            async with engine.connect():
                pass
        cache = Redis.from_url(
            settings.redis_url.get_secret_value(),
            socket_connect_timeout=2,
            socket_timeout=2,
            decode_responses=True,
            max_connections=32,
        )
        app.state.settings = settings
        app.state.engine = engine
        app.state.session_factory = factory
        app.state.redis = cache
        app.state.limiter = MemoryWindowLimiter()
        app.state.chat_scope = uuid4().hex
        app.state.chat_admission = asyncio.Lock()
        app.state.chat_stream_lock = asyncio.Lock()
        app.state.chat_streams = {}
        app.state.chat_runner = ChatRunner(factory, settings)
        app.state.auth_store = AuthStore(cache if settings.auth_store_backend == "redis" else None)
        app.state.mailer = (
            mailer
            if mailer is not None
            else MockMailSender(origin=settings.frontend_origin, outbox_dir=settings.mock_mail_dir)
        )
        app.state.password_limiter = CapacityLimiter(2)
        app.state.dummy_hash = await to_thread.run_sync(
            PASSWORD_HASHER.hash, secrets.token_urlsafe(32)
        )
        try:
            try:
                async with factory() as session:
                    await require_enabled_capabilities(session, settings, verify_schema=True)
                    if settings.beta_quota_enabled:
                        from app.modules.beta_quota.service import schema_ready

                        await schema_ready(session, required=True)
                    if settings.beta_telemetry_enabled:
                        from app.modules.beta_quota.privacy import require_schema

                        await require_schema(session)
                app.state.schema_ready = True
            except SchemaUnavailable:
                # Auth and liveness can remain available on old/unmigrated storage.
                # Readiness, every chat command, and the runner still fail closed.
                app.state.schema_ready = False
            if settings.chat_runner_enabled:
                app.state.chat_runner.start()
            yield
        finally:
            await app.state.chat_runner.close()
            await cache.aclose()
            await engine.dispose()

    app = FastAPI(
        title="未毕业 · WeiBiYe API",
        version="0.1.0",
        description="Cookie 会话认证与用户隔离已实现；未实现业务返回 501，AI 演示固定使用 Mock。",
        lifespan=lifespan,
        docs_url="/docs" if settings.environment != "production" else None,
        redoc_url=None,
    )
    install_exception_handlers(app)
    install_request_middleware(app, production=settings.environment == "production")

    @app.middleware("http")
    async def chat_stream_cache_policy(request, call_next):
        response = await call_next(request)
        if (
            request.url.path.startswith("/api/v1/companion/sessions/")
            and request.url.path.endswith("/events")
            and response.status_code == 200
            and response.headers.get("content-type", "").startswith("text/event-stream")
        ):
            # Keep the existing security middleware's no-store and explicitly disable caches.
            response.headers["Cache-Control"] = "no-cache, no-store"
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type",
            "Authorization",
            "Idempotency-Key",
            "X-CSRF-Token",
            "Last-Event-ID",
        ],
        expose_headers=["X-Request-ID", "Retry-After"],
    )
    app.include_router(health_router)

    @app.get("/api/v1/auth/capabilities")
    async def auth_capabilities(request: Request):
        return {
            "email_verification_required": settings.require_verified_email,
            "mail_mode": "mock"
            if isinstance(request.app.state.mailer, MockMailSender)
            else "external",
        }

    app.include_router(router)
    app.include_router(beta_quota_router, prefix="/api/v1")
    app.include_router(beta_privacy_router, prefix="/api/v1")
    return app


app = create_app()
