"""Local-only composition using a newly prepared SQLite fixture, never a shared URL."""

import hashlib
import hmac
import json
import sqlite3
import time
from contextlib import asynccontextmanager, closing
from pathlib import Path
from uuid import uuid4

from app.modules.qq_p87.contracts import Rejected, uuid

ROOT = Path(__file__).resolve().parents[4]
BACKEND = Path(__file__).resolve().parents[3]
KIND = "p871-official-qq-local-sandbox/1"


def _safe(path):
    if any(
        item.is_symlink() or getattr(item, "is_junction", lambda: False)()
        for item in (path, *path.parents)
    ):
        raise Rejected("QQ_SANDBOX_PATH_INVALID")


def prepare_local(*, root=ROOT):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine

    run = str(uuid4())
    folder = Path(root).resolve() / ".verification/p871" / ("sandbox-" + run)
    _safe(folder)
    folder.mkdir(parents=True, exist_ok=False)
    path = folder / "application.sqlite3"
    with path.open("xb"):
        pass
    engine = create_engine("sqlite:///" + path.as_posix())
    try:
        with engine.connect() as db:
            cfg = Config(str(BACKEND / "alembic.ini"))
            cfg.attributes["connection"] = db  # migrations cannot open a configured shared URL
            command.upgrade(cfg, "head")
            db.exec_driver_sql(
                "CREATE TABLE p871_sandbox_identity (run TEXT PRIMARY KEY, kind TEXT NOT NULL)"
            )
            db.exec_driver_sql("INSERT INTO p871_sandbox_identity VALUES (?,?)", (run, KIND))
            db.commit()
    finally:
        engine.dispose()
    target = folder / "target.json"
    with target.open("x", encoding="utf-8") as stream:
        json.dump(
            {
                "kind": KIND,
                "run": run,
                "database": "application.sqlite3",
                "shared_database": False,
                "paid_models": False,
            },
            stream,
            indent=2,
        )
    return target


def load_local(path, *, root=ROOT):
    source = Path(path).absolute()
    _safe(source)
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
        run = uuid(data["run"])
        folder = Path(root).resolve() / ".verification/p871" / ("sandbox-" + run)
        if source != folder / "target.json" or data != {
            "kind": KIND,
            "run": run,
            "database": "application.sqlite3",
            "shared_database": False,
            "paid_models": False,
        }:
            raise ValueError
        database = folder / "application.sqlite3"
        _safe(database)
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            if db.execute("SELECT run,kind FROM p871_sandbox_identity").fetchall() != [(run, KIND)]:
                raise ValueError
            if db.execute("SELECT version_num FROM alembic_version").fetchall() != [("0006",)]:
                raise ValueError
        return folder, database, run
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        raise Rejected("QQ_SANDBOX_IDENTITY_INVALID") from None


def create_local_app(
    target,
    options,
    *,
    authorize_network=False,
    validation=False,
    transport=None,
    root=ROOT,
    local_port=38711,
    now=lambda: int(time.time()),
    channel_factory=None,
    receive_callback=True,
):
    # No credentials/HTTP client before verifying the exact non-shared fixture.
    folder, database, run = load_local(target, root=root)
    expected_mode = "official-webhook" if receive_callback else "official-websocket"
    if (
        options.mode != expected_mode
        or options.credentials is None
        or (not receive_callback and channel_factory is None)
    ):
        raise Rejected("QQ_SANDBOX_DISABLED")
    if options.allow_network and not authorize_network:
        raise Rejected("QQ_NETWORK_NOT_AUTHORIZED")
    if transport is None and not (
        options.allow_network and options.allow_send and authorize_network
    ):
        raise Rejected("QQ_NETWORK_NOT_AUTHORIZED")

    from pydantic import SecretStr

    from app.core.config import Settings
    from app.core.errors import AppError
    from app.main import create_app
    from app.modules.qq_p87.context import ExistingPetContextReader
    from app.modules.qq_p87.mocks import MockModel
    from app.modules.qq_p87.store import MockStore

    from .adapter import OfficialQQAdapter
    from .http import OfficialHTTP
    from .protocol import QQWebhookProtocol
    from .routes import install_qq_routes
    from .runtime import OfficialSandboxPetChannel

    secret = options.credentials.app_secret.get_secret_value().encode("ascii")
    pepper = hmac.new(secret, b"P871/local-metadata/v1\0" + run.encode(), hashlib.sha256).digest()

    class LocalQQSettings(Settings):
        @property
        def session_cookie(self):
            return "p871_" + run.replace("-", "") + "_session"

        @property
        def csrf_cookie(self):
            return "p871_" + run.replace("-", "") + "_csrf"

    local_origin = f"http://127.0.0.1:{local_port}"
    settings = LocalQQSettings(
        environment="test",
        database_url=SecretStr("sqlite+aiosqlite:///" + database.as_posix()),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        llm_provider="mock",
        real_llm_enabled=False,
        openai_api_key=None,
        deepseek_api_key=None,
        dev_deepseek_pet_id=None,
        dev_deepseek_pet_owner_id=None,
        auth_store_backend="memory",
        rate_limit_backend="memory",
        beta_quota_enabled=False,
        beta_telemetry_enabled=False,
        chat_runner_enabled=False,
        memory_management_enabled=True,
        memory_injection_enabled=False,
        memory_hmac_key=SecretStr(pepper.hex()),
        mock_mail_dir=None,
        frontend_origin=local_origin,
        cors_origins=[local_origin, "http://testserver"],
    )
    app = create_app(settings)
    original = app.router.lifespan_context

    @app.get("/api/v1/qq/sandbox-ready", include_in_schema=False)
    async def sandbox_ready():
        # This reports only the deliberately isolated QQ test composition; it
        # does not replace the application's PostgreSQL/Redis readiness probe.
        try:
            load_local(target, root=root)
            channel = getattr(app.state, "qq_p871_channel", None)
            if channel is None or channel.closed:
                raise Rejected("QQ_SANDBOX_NOT_READY")
            row = channel.store.db.execute(
                "SELECT value FROM meta WHERE key='namespace'"
            ).fetchone()
            if row is None or row[0] != "p87-mock-qq/1":
                raise Rejected("QQ_SANDBOX_NOT_READY")
        except (Rejected, sqlite3.Error):
            raise AppError(503, "QQ_SANDBOX_NOT_READY", "独立QQ测试环境尚未就绪。") from None
        return {
            "status": "isolated-qq-mock-model-ready",
            "paid_model_enabled": False,
            "shared_database": False,
            "redis_required": False,
        }

    @asynccontextmanager
    async def lifespan(app):
        async with original(app):
            path = folder / "qq-metadata.sqlite3"
            reopen = None
            if path.exists():
                _safe(path)
                with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as check:
                    reopen = check.execute("SELECT value FROM meta WHERE key='run'").fetchone()[0]
            store = MockStore(pepper, path=path, reopen_run=reopen)
            channel = None
            try:
                reader = ExistingPetContextReader(app.state.session_factory)
                if channel_factory is None:
                    adapter = OfficialQQAdapter(
                        QQWebhookProtocol(
                            options.credentials, validation_until=now() + 300 if validation else 0
                        ),
                        OfficialHTTP(
                            options.credentials,
                            allow_network=options.allow_network,
                            allow_send=options.allow_send,
                            transport=transport,
                        ),
                        now=now,
                    )
                    channel = OfficialSandboxPetChannel(
                        store,
                        reader,
                        MockModel(),
                        adapter,
                        now=now,
                        enable=True,
                    )
                else:
                    channel = channel_factory(store, reader)
                    if not isinstance(channel, OfficialSandboxPetChannel):
                        raise Rejected("QQ_SANDBOX_CHANNEL_REQUIRED")
                if not store.db.execute(
                    "SELECT 1 FROM bots WHERE id=?", (options.credentials.app_id,)
                ).fetchone():
                    store.add_bot(options.credentials.app_id)
                app.state.qq_p871_channel = channel
                install_qq_routes(
                    app,
                    channel,
                    enabled=True,
                    enroll_sandbox_accounts=True,
                    receive_callback=receive_callback,
                )
                yield
            finally:
                if channel is not None:
                    await channel.close()
                store.close()

    app.router.lifespan_context = lifespan
    return app
