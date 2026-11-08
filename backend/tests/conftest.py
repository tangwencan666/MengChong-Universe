from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine

from app.core.config import Settings, get_settings
from app.core.event_loop import new_event_loop
from app.main import create_app


@pytest.fixture
def settings():
    return Settings(
        environment="test",
        database_url=SecretStr("sqlite+aiosqlite:///:memory:"),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        llm_provider="mock",
        real_llm_enabled=False,
        rate_limit_backend="memory",
        auth_store_backend="memory",
    )


@pytest.fixture
def client(settings):
    with TestClient(
        create_app(settings),
        raise_server_exceptions=False,
        backend_options={"loop_factory": new_event_loop},
    ) as client:
        yield client


BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def auth_database(tmp_path, monkeypatch):
    database = tmp_path / "auth.db"
    url = f"sqlite:///{database.as_posix()}"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", url)
    get_settings.cache_clear()
    command.upgrade(Config(str(BACKEND / "alembic.ini")), "head")
    engine = create_engine(url)
    settings = Settings(
        environment="test",
        database_url=SecretStr(f"sqlite+aiosqlite:///{database.as_posix()}"),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        cors_origins=["http://testserver"],
    )
    yield engine, settings
    engine.dispose()
    get_settings.cache_clear()


@pytest.fixture
def auth_client(auth_database):
    _, settings = auth_database
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        yield client
