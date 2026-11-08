from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app.core.config import get_settings


def test_forward_upgrade_preserves_existing_user(tmp_path, monkeypatch):
    database = tmp_path / "preserve.db"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", f"sqlite:///{database.as_posix()}")
    get_settings.cache_clear()
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.upgrade(config, "0001")
    engine = create_engine(f"sqlite:///{database.as_posix()}")
    user_id = uuid4().hex
    with engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO users (id,email,password_hash,display_name) "
                "VALUES (:id,'preserved@example.com','test-hash','preserved')"
            ),
            {"id": user_id},
        )
    command.upgrade(config, "head")
    command.check(config)
    with engine.connect() as db:
        row = db.execute(
            text("SELECT id,email,password_hash,display_name,email_verified_at FROM users")
        ).one()
        assert row == (user_id, "preserved@example.com", "test-hash", "preserved", None)
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
        assert {"auth_sessions", "email_verifications"} <= set(inspect(db).get_table_names())
    engine.dispose()
    get_settings.cache_clear()


def test_guard_refuses_a_non_dedicated_database_without_connecting(monkeypatch):
    from scripts.upgrade_auth import main

    monkeypatch.setenv("WEIBIYE_DATABASE_URL", "sqlite:///unused-never-created.db")
    monkeypatch.setattr("sys.argv", ["upgrade_auth.py", "--expected-cluster-id", "unused"])
    with pytest.raises(SystemExit, match="Unexpected migration target"):
        main()


def test_runtime_migration_guard_does_not_depend_on_assertions():
    from scripts.upgrade_auth import require

    with pytest.raises(SystemExit, match="unsafe"):
        require(False, "unsafe")


def test_recovery_upgrade_preserves_a_p2_user_and_session(tmp_path, monkeypatch):
    database = tmp_path / "recovery-preserve.db"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", f"sqlite:///{database.as_posix()}")
    get_settings.cache_clear()
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.upgrade(config, "0002")
    engine = create_engine(f"sqlite:///{database.as_posix()}")
    user_id, session_id = uuid4().hex, uuid4().hex
    with engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO users (id,email,password_hash,display_name) "
                "VALUES (:id,'preserve-recovery@example.com','unchanged-hash','preserved')"
            ),
            {"id": user_id},
        )
        db.execute(
            text(
                "INSERT INTO auth_sessions (id,user_id,token_hash,csrf_hash,"
                "expires_at,last_seen_at) "
                "VALUES (:id,:user,:token,:csrf,'2099-01-01','2026-11-01')"
            ),
            {"id": session_id, "user": user_id, "token": "a" * 64, "csrf": "b" * 64},
        )
    command.upgrade(config, "0003")
    with engine.connect() as db:
        assert (
            db.scalar(text("SELECT password_hash FROM users WHERE id=:id"), {"id": user_id})
            == "unchanged-hash"
        )
        assert (
            db.scalar(text("SELECT token_hash FROM auth_sessions WHERE id=:id"), {"id": session_id})
            == "a" * 64
        )
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0003"
        assert db.scalar(text("SELECT count(*) FROM password_resets")) == 0
    command.upgrade(config, "head")
    command.check(config)
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
        assert (
            db.scalar(text("SELECT password_hash FROM users WHERE id=:id"), {"id": user_id})
            == "unchanged-hash"
        )
        assert (
            db.scalar(text("SELECT token_hash FROM auth_sessions WHERE id=:id"), {"id": session_id})
            == "a" * 64
        )
    engine.dispose()
    get_settings.cache_clear()
