from datetime import UTC, datetime, timedelta
from io import StringIO
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.db import models  # noqa: F401
from app.db.base import Base
from app.modules.community.models import Post, PostLike, Report
from app.modules.companion.models import AICompanion, ChatMessage, ChatSession
from app.modules.memory.models import Memory
from app.modules.users.models import User
from app.modules.wallet.models import UsageRecord, Wallet, WalletReservation, WalletTransaction

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def migrated_database(tmp_path, monkeypatch):
    # New test-owned path only. No existing database is ever downgraded or reset.
    url = f"sqlite:///{tmp_path.as_posix()}/foundation.db"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", url)
    get_settings.cache_clear()
    config = Config(str(ROOT / "alembic.ini"))
    command.upgrade(config, "head")
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def sqlite_foreign_keys(dbapi_connection, connection_record):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    yield engine, config
    engine.dispose()
    get_settings.cache_clear()


def seed_users(connection):
    first, second = uuid4(), uuid4()
    connection.execute(
        User.__table__.insert(),
        [
            {
                "id": first,
                "email": "one@example.com",
                "password_hash": "not-a-password",
                "display_name": "one",
            },
            {
                "id": second,
                "email": "two@example.com",
                "password_hash": "not-a-password",
                "display_name": "two",
            },
        ],
    )
    return first, second


def test_forward_migration_and_metadata_drift(migrated_database):
    engine, config = migrated_database
    assert set(inspect(engine).get_table_names()) == set(Base.metadata.tables) | {"alembic_version"}
    assert len(Base.metadata.tables) == 34
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
    command.check(config)
    # Migrations are forward-only. Re-applying head is idempotent and preserves data.
    with engine.begin() as connection:
        seed_users(connection)
    command.upgrade(config, "head")
    command.check(config)
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
        assert len(connection.execute(User.__table__.select()).all()) == 2


def test_postgres_offline_migration_compiles(monkeypatch):
    monkeypatch.setenv(
        "WEIBIYE_DATABASE_URL", "postgresql+psycopg://unused@127.0.0.1/weibiye_compile"
    )
    get_settings.cache_clear()
    output = StringIO()
    config = Config(str(ROOT / "alembic.ini"))
    config.output_buffer = output
    command.upgrade(config, "head", sql=True)
    sql = output.getvalue()
    assert "CREATE TABLE wallet_transactions" in sql
    assert "TIMESTAMP WITH TIME ZONE" in sql and "UUID" in sql
    assert "BIGINT" in sql
    get_settings.cache_clear()


@pytest.mark.parametrize("balance,reserved", [(-1, 0), (1, 2), (1, -1)])
def test_wallet_balance_constraints(migrated_database, balance, reserved):
    engine, _ = migrated_database
    with engine.begin() as connection:
        first, _ = seed_users(connection)
        with pytest.raises(IntegrityError):
            connection.execute(
                Wallet.__table__.insert().values(
                    owner_id=first,
                    balance=balance,
                    reserved=reserved,
                )
            )


def test_idempotency_duplicate_likes_and_report_targets(migrated_database):
    engine, _ = migrated_database
    with engine.begin() as connection:
        first, _ = seed_users(connection)
        wallet_id, post_id = uuid4(), uuid4()
        connection.execute(Wallet.__table__.insert().values(id=wallet_id, owner_id=first))
        ledger = dict(
            wallet_id=wallet_id,
            kind="grant",
            delta=10,
            balance_after=10,
            idempotency_key="test-idempotency-01",
            request_fingerprint="a" * 64,
        )
        connection.execute(WalletTransaction.__table__.insert().values(**ledger))
        with pytest.raises(IntegrityError):
            connection.execute(WalletTransaction.__table__.insert().values(**ledger))
        connection.execute(
            Post.__table__.insert().values(
                id=post_id,
                owner_id=first,
                title="Demo",
                body="Fictional",
            )
        )
        connection.execute(PostLike.__table__.insert().values(post_id=post_id, owner_id=first))
        with pytest.raises(IntegrityError):
            connection.execute(PostLike.__table__.insert().values(post_id=post_id, owner_id=first))
        with pytest.raises(IntegrityError):
            connection.execute(Report.__table__.insert().values(reporter_id=first, reason="test"))


def test_private_relations_reject_cross_owner_references(migrated_database):
    engine, _ = migrated_database
    with engine.begin() as connection:
        first, second = seed_users(connection)
        companion_id, session_id = uuid4(), uuid4()
        connection.execute(
            AICompanion.__table__.insert().values(
                id=companion_id,
                owner_id=first,
                name="mock",
                persona="demo",
            )
        )
        with pytest.raises(IntegrityError):
            connection.execute(
                ChatSession.__table__.insert().values(
                    owner_id=second,
                    companion_id=companion_id,
                    title="forbidden",
                )
            )
        connection.execute(
            ChatSession.__table__.insert().values(
                id=session_id,
                owner_id=first,
                companion_id=companion_id,
                title="demo",
            )
        )
        with pytest.raises(IntegrityError):
            connection.execute(
                ChatMessage.__table__.insert().values(
                    owner_id=second,
                    session_id=session_id,
                    sequence=0,
                    role="user",
                    content="forbidden",
                    provider="mock",
                )
            )
        with pytest.raises(IntegrityError):
            connection.execute(
                Memory.__table__.insert().values(
                    owner_id=second,
                    source_session_id=session_id,
                    content="forbidden",
                    consent_granted_at=datetime.now(UTC),
                )
            )


def test_wallet_references_cannot_cross_accounts(migrated_database):
    engine, _ = migrated_database
    with engine.begin() as connection:
        first, second = seed_users(connection)
        wallet_a, wallet_b, reservation_id, usage_id, debit_id = [uuid4() for _ in range(5)]
        connection.execute(
            Wallet.__table__.insert(),
            [
                {"id": wallet_a, "owner_id": first},
                {"id": wallet_b, "owner_id": second},
            ],
        )
        connection.execute(
            WalletReservation.__table__.insert().values(
                id=reservation_id,
                wallet_id=wallet_a,
                amount=10,
                idempotency_key="test-reservation-01",
                request_fingerprint="a" * 64,
                expires_at=datetime.now(UTC) + timedelta(minutes=5),
            )
        )
        connection.execute(
            UsageRecord.__table__.insert().values(
                id=usage_id,
                wallet_id=wallet_a,
                owner_id=first,
                provider="mock",
                model="mock",
                input_tokens=1,
                output_tokens=1,
                idempotency_key="test-usage-01",
            )
        )
        base = dict(
            wallet_id=wallet_a,
            kind="debit",
            delta=-1,
            balance_after=0,
            idempotency_key="test-debit-01",
            request_fingerprint="a" * 64,
        )
        connection.execute(WalletTransaction.__table__.insert().values(id=debit_id, **base))
        for reference in ({"reservation_id": reservation_id}, {"usage_record_id": usage_id}):
            with pytest.raises(IntegrityError):
                connection.execute(
                    WalletTransaction.__table__.insert().values(
                        **{**base, "wallet_id": wallet_b, **reference},
                    )
                )
        with pytest.raises(IntegrityError):
            connection.execute(
                WalletTransaction.__table__.insert().values(
                    **{
                        **base,
                        "wallet_id": wallet_b,
                        "kind": "refund",
                        "delta": 1,
                        "original_transaction_id": debit_id,
                    },
                )
            )
