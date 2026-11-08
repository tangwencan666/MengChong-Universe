"""Guarded local desktop chat: read-only preflight, explicit single-process serve.

Never creates/migrates storage, reads .env, or makes a model request during checks.
The operator supplies an existing isolated PostgreSQL database in process env.
"""

import argparse
import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.db.capabilities import require_capability
from app.db.session import build_database

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".verification" / "desktop-chat"
SCHEMA = "weibiye-local-desktop-chat/1"
IDENTITY_FIELDS = ("database", "database_port", "cluster", "redis_port", "redis_db", "redis_run_id")


class StartupBlocked(Exception):
    pass


def require(condition):
    if not condition:
        raise StartupBlocked


def endpoints(settings, environ):
    require("WEIBIYE_DATABASE_URL" in environ)
    database = make_url(settings.database_url.get_secret_value())
    require(
        settings.environment == "development"
        and settings.llm_provider == "mock"
        and settings.dev_deepseek_pet_id is None
        and settings.dev_deepseek_pet_owner_id is None
        and (not settings.real_llm_enabled or settings.local_deepseek_pets)
        and database.drivername == "postgresql+psycopg"
        and database.host == "127.0.0.1"
        and type(database.port) is int
        and re.fullmatch(
            r"weibiye_(?:p6_desktop_test|desktop_local)_[a-f0-9]{32}", database.database or ""
        )
    )
    cache = urlsplit(settings.redis_url.get_secret_value())
    require(
        cache.scheme == "redis"
        and cache.hostname == "127.0.0.1"
        and cache.port is not None
        and not cache.query
        and not cache.fragment
        and re.fullmatch(r"/(?:[0-9]|1[0-5])", cache.path)
    )
    return database, cache


async def probe(settings, environ):
    database, cache_url = endpoints(settings, environ)
    engine, factory = build_database(settings.database_url.get_secret_value())
    cache = Redis.from_url(
        settings.redis_url.get_secret_value(),
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=3,
    )
    try:
        async with asyncio.timeout(12):
            async with factory() as db, db.begin():
                await db.execute(text("SET TRANSACTION READ ONLY"))
                require(await db.scalar(text("SELECT current_database()")) == database.database)
                await require_capability(db, "pets", verify_schema=True)
                cluster = str(
                    await db.scalar(text("SELECT system_identifier FROM pg_control_system()"))
                )
                for binding in settings.local_deepseek_pets:
                    active = await db.scalar(
                        text(
                            "SELECT count(*) FROM pets p JOIN users u ON p.owner_id=u.id "
                            "WHERE p.id=:pet AND p.owner_id=:owner AND p.status!='archived' "
                            "AND u.status='active'"
                        ),
                        {"pet": binding.pet_id, "owner": binding.owner_id},
                    )
                    require(active == 1)
            info = await cache.info("server")
            run_id = info.get("run_id")
            require(bool(re.fullmatch(r"[a-f0-9]{40}", run_id or "")))
            return {
                "database": database.database,
                "database_port": database.port,
                "cluster": cluster,
                "redis_port": cache_url.port,
                "redis_db": int(cache_url.path[1:]),
                "redis_run_id": run_id,
            }
    finally:
        await cache.aclose()
        await engine.dispose()


def load_target(source, now=None):
    source = Path(source).resolve()
    require(source.is_relative_to(OUT.resolve()) and source.name == "target.json")
    require(source.stat().st_size <= 8192)
    value = json.loads(source.read_text(encoding="utf-8"))
    require(
        value.get("schema") == SCHEMA
        and re.fullmatch(r"[a-f0-9]{32}", value.get("run_id", ""))
        and source.parent.name == "prepared-" + value["run_id"]
        and all(key in value for key in IDENTITY_FIELDS)
        and (now or datetime.now(UTC)) < datetime.fromisoformat(value["expires_at"])
    )
    ports = [value.get("backend_port"), value.get("ui_port")]
    require(
        all(
            type(port) is int and 1024 <= port <= 65535 and port not in {25433, 26380}
            for port in ports
        )
        and ports[0] != ports[1]
    )
    return value


def verify_target(target, identity):
    require(all(target[key] == identity.get(key) for key in IDENTITY_FIELDS))


def prepare_target(identity, backend_port, ui_port):
    require(
        all(
            type(p) is int and 1024 <= p <= 65535 and p not in {25433, 26380}
            for p in [backend_port, ui_port]
        )
        and backend_port != ui_port
    )
    run_id = uuid4().hex
    now = datetime.now(UTC)
    target = {
        "schema": SCHEMA,
        "run_id": run_id,
        **identity,
        "backend_port": backend_port,
        "ui_port": ui_port,
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(hours=24)).isoformat(),
    }
    folder = OUT / ("prepared-" + run_id)
    folder.mkdir(parents=True, exist_ok=False)
    with (folder / "target.json").open("x", encoding="utf-8") as stream:
        json.dump(target, stream, indent=2)
    return folder / "target.json"


class ScopedRedis:
    """Only this target's TTL keys; never flush/delete another app's keys."""

    def __init__(self, cache, prefix):
        self.cache, self.prefix = cache, prefix

    async def ping(self):
        return await self.cache.ping()

    async def get(self, key):
        return await self.cache.get(self.prefix + key)

    async def set(self, key, value, **options):
        require(options.get("ex", 0) > 0)
        return await self.cache.set(self.prefix + key, value, **options)

    async def eval(self, script, numkeys, *arguments):
        require(type(numkeys) is int and numkeys > 0 and len(arguments) >= numkeys)
        return await self.cache.eval(
            script,
            numkeys,
            *(self.prefix + key for key in arguments[:numkeys]),
            *arguments[numkeys:],
        )

    async def zrem(self, key, *members):
        return await self.cache.zrem(self.prefix + key, *members)


def local_app(settings, target):
    from app.main import create_app

    app = create_app(settings)
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        try:
            verify_target(target, await probe(settings, os.environ))
        except Exception:
            raise StartupBlocked("Desktop dependency identity changed") from None
        async with original(application):
            scoped = ScopedRedis(
                application.state.redis, "weibiye:desktop-chat:" + target["run_id"] + ":"
            )
            application.state.redis = scoped
            if application.state.auth_store.cache is not None:
                application.state.auth_store.cache = scoped
            yield

    app.router.lifespan_context = lifespan
    return app


def summary(settings, status, target=None):
    return {
        "status": status,
        "model": settings.deepseek_model,
        "key_visible": bool(
            settings.deepseek_api_key and settings.deepseek_api_key.get_secret_value().strip()
        ),
        "real_enabled": bool(settings.local_deepseek_pets),
        "bound_pet_count": len(settings.local_deepseek_pets),
        "max_requests_this_launch": settings.local_deepseek_max_requests,
        "memory_injected_for_real_model": False,
        "model_requests_made_by_check": 0,
        **({"target": str(target)} if target else {}),
    }


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "DESKTOP_CHAT_OPTIONS_BLOCKED: 请查看 --help；密钥仅放在进程环境。\n")


def main(argv=None):
    parser = Parser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare-target", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--check-config", action="store_true")
    mode.add_argument("--serve", action="store_true")
    parser.add_argument("--target", type=Path)
    parser.add_argument("--backend-port", type=int, default=38336)
    parser.add_argument("--ui-port", type=int, default=35336)
    parser.add_argument("--confirm-paid-requests", type=int, default=0)
    args = parser.parse_args(argv)
    serving = False
    try:
        settings = Settings()
        if args.check_config:
            print(
                json.dumps(
                    summary(settings, "DESKTOP_CHAT_CONFIG_ONLY")
                    | {
                        "database_explicitly_selected": "WEIBIYE_DATABASE_URL" in os.environ,
                        "dependencies_checked": False,
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        require(not args.prepare_target or args.target is None)
        if args.prepare_target:
            with asyncio.Runner(loop_factory=new_event_loop) as runner:
                identity = runner.run(probe(settings, os.environ))
            target = prepare_target(identity, args.backend_port, args.ui_port)
            print(
                json.dumps(
                    summary(settings, "DESKTOP_CHAT_TARGET_PREPARED", target), ensure_ascii=False
                )
            )
            return 0
        require(args.target is not None)
        target = load_target(args.target)
        settings = Settings.model_validate(
            settings.model_dump()
            | {
                "deepseek_api_key": settings.deepseek_api_key,
                "frontend_origin": f"http://127.0.0.1:{target['ui_port']}",
                "cors_origins": [f"http://127.0.0.1:{target['ui_port']}"],
            }
        )
        if args.serve:
            require(args.confirm_paid_requests == settings.local_deepseek_max_requests)
        with asyncio.Runner(loop_factory=new_event_loop) as runner:
            verify_target(target, runner.run(probe(settings, os.environ)))
        print(
            json.dumps(
                summary(settings, "DESKTOP_CHAT_PREFLIGHT_OK", args.target), ensure_ascii=False
            )
        )
        if args.serve:
            import uvicorn

            serving = True
            uvicorn.run(
                local_app(settings, target),
                host="127.0.0.1",
                port=target["backend_port"],
                loop="app.core.event_loop:new_event_loop",
                access_log=False,
                proxy_headers=False,
                log_level="warning",
                workers=1,
                limit_concurrency=64,
            )
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        # Never format Settings, database URLs, credentials or SDK/driver errors.
        print(
            json.dumps(
                {
                    "status": "DESKTOP_CHAT_STOPPED_WITH_ERROR"
                    if serving
                    else "DESKTOP_CHAT_STARTUP_BLOCKED",
                    "model_requests": None if serving else 0,
                    "message": "聊天服务遇到问题，请检查本地配置与依赖；不会自动重试模型。"
                    if serving
                    else "配置、隔离目标或依赖检查失败；未启动聊天服务。",
                },
                ensure_ascii=False,
            )
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
