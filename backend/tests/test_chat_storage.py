"""Unmigrated chat storage must fail honestly without changing auth or upgrading itself."""

from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError
from sqlalchemy import create_engine, inspect, text

from app.core.config import Settings, get_settings
from app.core.event_loop import new_event_loop
from app.main import create_app
from tests.auth_helpers import csrf, login, register


def test_p25_storage_auth_works_but_private_chat_returns_503_without_migration(
    tmp_path, monkeypatch
):
    path = tmp_path / "still-p25.db"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", f"sqlite:///{path.as_posix()}")
    get_settings.cache_clear()
    command.upgrade(Config(str(Path(__file__).resolve().parents[1] / "alembic.ini")), "0003")
    settings = Settings(
        environment="test",
        database_url=SecretStr(f"sqlite+aiosqlite:///{path.as_posix()}"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        chat_runner_enabled=False,
        llm_provider="mock",
        real_llm_enabled=False,
        cors_origins=["http://testserver"],
    )
    engine = create_engine(f"sqlite:///{path.as_posix()}")
    try:
        with TestClient(
            create_app(settings),
            backend_options={"loop_factory": new_event_loop},
            headers={"Origin": "http://testserver"},
        ) as client:
            assert register(client).status_code == 202
            assert login(client).status_code == 200
            assert client.get("/api/v1/auth/me").status_code == 200
            for response in (
                client.get("/api/v1/companion/sessions"),
                client.post(
                    "/api/v1/companion/sessions",
                    json={},
                    headers={**csrf(client), "Idempotency-Key": str(uuid4())},
                ),
            ):
                assert response.status_code == 503
                assert response.json()["error"]["code"] == "CHAT_STORAGE_UNAVAILABLE"
        with engine.connect() as db:
            assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0003"
            assert db.scalar(text("SELECT count(*) FROM chat_sessions")) == 0
            assert "chat_generations" not in inspect(db).get_table_names()
    finally:
        engine.dispose()
        get_settings.cache_clear()


def test_chat_lease_and_execution_capacity_configuration_is_bounded():
    with pytest.raises(ValidationError):
        Settings(chat_lease_seconds=3, chat_renew_seconds=3)
    with pytest.raises(ValidationError):
        Settings(chat_max_running=5)
