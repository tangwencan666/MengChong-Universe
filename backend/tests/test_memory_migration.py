"""Temporary SQLite migration tests plus PostgreSQL DDL, never the development DB."""

import importlib.util
from datetime import UTC, datetime, timedelta
from io import StringIO
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, event, inspect, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.base import Base
from app.db.capabilities import PET_TABLES
from app.modules.companion.models import ChatGeneration
from app.modules.memory.models import Memory, MemoryConsentEvent, MemorySource

BACKEND = Path(__file__).resolve().parents[1]


def snapshot(db, old=None):
    inspector = inspect(db)
    result = {}
    for name in sorted(old or inspector.get_table_names()):
        if name == "alembic_version":
            continue
        columns = old[name][0] if old else [c["name"] for c in inspector.get_columns(name)]
        quoted = db.dialect.identifier_preparer.quote_identifier
        query = "SELECT " + ",".join(quoted(c) for c in columns) + " FROM " + quoted(name)
        result[name] = (columns, sorted(tuple(row) for row in db.exec_driver_sql(query)))
    return result


@pytest.fixture
def migrated_memory(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'isolated-memory-migration.db').as_posix()}"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", url)
    get_settings.cache_clear()
    config = Config(str(BACKEND / "alembic.ini"))
    command.upgrade(config, "0004")
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

    ids = {
        key: uuid4()
        for key in ["owner", "other", "companion", "session", "user", "assistant", "legacy"]
    }
    with engine.begin() as db:
        for key in ["owner", "other"]:
            db.execute(
                text(
                    "INSERT INTO users(id,email,password_hash,display_name) VALUES "
                    "(:id,:email,'test-only-hash','migration test')"
                ),
                {"id": ids[key].hex, "email": f"{key}@memory-migration.invalid"},
            )
        db.execute(
            text(
                "INSERT INTO ai_companions(id,owner_id,name,persona) VALUES "
                "(:id,:owner,'fixture','fixture')"
            ),
            {"id": ids["companion"].hex, "owner": ids["owner"].hex},
        )
        db.execute(
            text(
                "INSERT INTO chat_sessions(id,owner_id,companion_id,title) VALUES "
                "(:id,:owner,:companion,'preserved chat')"
            ),
            {
                "id": ids["session"].hex,
                "owner": ids["owner"].hex,
                "companion": ids["companion"].hex,
            },
        )
        for key, role, sequence, status in [
            ("user", "user", 0, "completed"),
            ("assistant", "assistant", 1, "queued"),
        ]:
            db.execute(
                text(
                    "INSERT INTO "
                    "chat_messages(id,owner_id,session_id,role,sequence,status,content) VALUES "
                    "(:id,:owner,:session,:role,:sequence,:status,'preserved fixture')"
                ),
                {
                    "id": ids[key].hex,
                    "owner": ids["owner"].hex,
                    "session": ids["session"].hex,
                    "role": role,
                    "sequence": sequence,
                    "status": status,
                },
            )
        db.execute(
            text(
                "INSERT INTO memories(id,owner_id,source_session_id,content,consent_granted_at)"
                " VALUES (:id,:owner,:session,'preserved legacy memory','2025-01-01 00:00:00')"
            ),
            {"id": ids["legacy"].hex, "owner": ids["owner"].hex, "session": ids["session"].hex},
        )
        db.execute(
            text(
                "INSERT INTO "
                "auth_sessions(id,user_id,token_hash,csrf_hash,expires_at,last_seen_at) VALUES "
                "(:id,:owner,:token,:csrf,'2035-01-01 00:00:00','2025-01-01 00:00:00')"
            ),
            {"id": uuid4().hex, "owner": ids["owner"].hex, "token": "a" * 64, "csrf": "b" * 64},
        )
        db.execute(
            text("INSERT INTO wallets(id,owner_id) VALUES (:id,:owner)"),
            {"id": uuid4().hex, "owner": ids["owner"].hex},
        )
    statements = []

    @event.listens_for(engine, "before_cursor_execute")
    def capture_statement(conn, cursor, statement, parameters, context, executemany):
        if "chat_generations" in statement:
            statements.append(statement)

    with Session(engine) as db, db.begin():
        generation = ChatGeneration(
            owner_id=ids["owner"],
            session_id=ids["session"],
            user_message_id=ids["user"],
            assistant_message_id=ids["assistant"],
            operation="send",
            idempotency_key="preserved-generation-key",
            request_fingerprint="c" * 64,
            provider="mock",
            model=None,
            prompt_version="v1",
            context_message_ids=[str(ids["user"])],
        )
        db.add(generation)
        db.flush()
        ids["generation"] = generation.id
        assert (
            db.scalar(select(ChatGeneration).where(ChatGeneration.id == generation.id))
            is generation
        )
    assert statements and all(
        "memory_epoch" not in sql and "memory_snapshot_at" not in sql for sql in statements
    )
    assert not any(
        name.startswith("memory_") for name in ChatGeneration.__mapper__.column_attrs.keys()
    )
    with engine.connect() as db:
        before = snapshot(db)
    command.upgrade(config, "0005")
    try:
        yield engine, ids, before, config
    finally:
        engine.dispose()
        get_settings.cache_clear()


def test_forward_memory_upgrade_preserves_all_original_data_and_versions(migrated_memory):
    engine, ids, before, config = migrated_memory
    # This fixture deliberately stops at the frozen 0005 schema. The 0006
    # additive pet manifest is verified separately by test_pet_migration.
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0005"
        assert len(inspect(db).get_table_names()) - 1 == 26
        assert snapshot(db, before) == before
        assert db.exec_driver_sql("PRAGMA foreign_key_check").all() == []
        legacy = db.execute(
            text(
                "SELECT content,status,active_consent_id,category,expires_at FROM memories "
                "WHERE id=:id"
            ),
            {"id": ids["legacy"].hex},
        ).one()
        assert legacy == ("preserved legacy memory", "legacy_unconfirmed", None, None, None)
        assert db.scalar(text("SELECT count(*) FROM memory_preferences")) == 0
        assert db.scalar(text("SELECT count(*) FROM memory_consent_events")) == 0
        assert db.scalar(text("SELECT memory_epoch FROM chat_generations")) is None
        assert (
            compare_metadata(
                MigrationContext.configure(
                    db,
                    opts={
                        "compare_type": True,
                        "include_object": lambda obj, name, kind, reflected, compare_to: (
                            kind != "table" or name not in PET_TABLES
                        ),
                    },
                ),
                Base.metadata,
            )
            == []
        )


def seed_manual(engine, owner):
    memory_id, event_id = uuid4(), uuid4()
    now = datetime.now(UTC)
    with engine.begin() as db:
        db.execute(
            Memory.__table__.insert().values(
                id=memory_id,
                owner_id=owner,
                content="confirmed synthetic fact",
                consent_granted_at=now,
                title="goal",
                category="career_goal",
                expires_at=now + timedelta(days=90),
            )
        )
        db.execute(
            MemoryConsentEvent.__table__.insert().values(
                id=event_id,
                owner_id=owner,
                revision=1,
                action="confirmed",
                memory_id=memory_id,
                memory_version=1,
                policy_version="memory-policy/1",
                notice_version="memory-notice/1",
                privacy_epoch=1,
            )
        )
        db.execute(
            Memory.__table__.update()
            .where(Memory.id == memory_id)
            .values(status="active", active_consent_id=event_id)
        )
        db.execute(
            MemorySource.__table__.insert().values(
                id=uuid4(), owner_id=owner, memory_id=memory_id, kind="manual"
            )
        )
    return memory_id, event_id


def test_active_grant_is_atomic_and_correct_version_is_required(migrated_memory):
    engine, ids, _, _ = migrated_memory
    memory_id, event_id = seed_manual(engine, ids["owner"])
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            Memory.__table__.update().where(Memory.id == memory_id).values(active_consent_id=None)
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(Memory.__table__.update().where(Memory.id == memory_id).values(version=2))
    new_event = uuid4()
    with engine.begin() as db:
        db.execute(
            MemoryConsentEvent.__table__.insert().values(
                id=new_event,
                owner_id=ids["owner"],
                revision=2,
                action="corrected",
                memory_id=memory_id,
                memory_version=2,
                policy_version="memory-policy/1",
                notice_version="memory-notice/1",
                privacy_epoch=2,
            )
        )
        db.execute(
            Memory.__table__.update()
            .where(Memory.id == memory_id)
            .values(content="corrected synthetic fact", version=2, active_consent_id=new_event)
        )
    with engine.connect() as db:
        assert db.scalar(select(Memory.version).where(Memory.id == memory_id)) == 2
        assert (
            db.scalar(select(Memory.active_consent_id).where(Memory.id == memory_id)) == new_event
        )


def test_cross_owner_consent_and_source_are_rejected(migrated_memory):
    engine, ids, _, _ = migrated_memory
    memory_id, _ = seed_manual(engine, ids["owner"])
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            MemoryConsentEvent.__table__.insert().values(
                id=uuid4(),
                owner_id=ids["other"],
                revision=1,
                action="confirmed",
                memory_id=memory_id,
                memory_version=1,
                policy_version="memory-policy/1",
                notice_version="memory-notice/1",
                privacy_epoch=1,
            )
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            MemorySource.__table__.insert().values(
                id=uuid4(),
                owner_id=ids["other"],
                memory_id=memory_id,
                kind="chat_message",
                session_id=ids["session"],
                message_id=ids["user"],
                source_message_version=1,
            )
        )


def test_nullable_composite_id_shapes_do_not_bypass_checks(migrated_memory):
    engine, ids, _, _ = migrated_memory
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            MemoryConsentEvent.__table__.insert().values(
                id=uuid4(),
                owner_id=ids["owner"],
                revision=1,
                action="revoked",
                memory_id=ids["legacy"],
                memory_version=None,
                privacy_epoch=1,
            )
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            MemorySource.__table__.insert().values(
                id=uuid4(),
                owner_id=ids["owner"],
                memory_id=ids["legacy"],
                kind="chat_message",
                session_id=ids["session"],
                message_id=ids["user"],
                source_message_version=None,
            )
        )


def test_deleted_memory_requires_body_erasure(migrated_memory):
    engine, ids, _, _ = migrated_memory
    memory_id, _ = seed_manual(engine, ids["owner"])
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            Memory.__table__.update()
            .where(Memory.id == memory_id)
            .values(status="deleted", active_consent_id=None, deleted_at=datetime.now(UTC))
        )
    with engine.begin() as db:
        db.execute(
            Memory.__table__.update()
            .where(Memory.id == memory_id)
            .values(
                status="deleted",
                active_consent_id=None,
                deleted_at=datetime.now(UTC),
                content="",
                title="",
                summary="",
            )
        )


def test_postgresql_forward_ddl_has_no_destructive_business_operation(monkeypatch):
    monkeypatch.setenv(
        "WEIBIYE_DATABASE_URL", "postgresql+psycopg://unused:unused@127.0.0.1:1/never_connected"
    )
    get_settings.cache_clear()
    output = StringIO()
    try:
        command.upgrade(
            Config(str(BACKEND / "alembic.ini"), output_buffer=output), "0004:0005", sql=True
        )
    finally:
        get_settings.cache_clear()
    ddl = output.getvalue()
    assert ddl.count("CREATE TABLE ") == 5
    assert "UPDATE alembic_version" in ddl and "'0005'" in ddl
    assert "DROP TABLE" not in ddl and "DELETE FROM" not in ddl and "TRUNCATE" not in ddl
    assert "ADD COLUMN memory_epoch BIGINT" in ddl
    assert "DEFAULT 'active'" not in ddl
    assert "now()" not in "\n".join(line for line in ddl.splitlines() if "CREATE INDEX" in line)


def test_generation_mapper_remains_a_v4_projection():
    compiled = str(select(ChatGeneration).compile(dialect=postgresql.dialect()))
    assert "memory_epoch" not in compiled and "memory_snapshot_at" not in compiled
    assert {"memory_epoch", "memory_context_not_before", "memory_snapshot_at"}.issubset(
        ChatGeneration.__table__.columns.keys()
    )


def test_memory_migration_refuses_downgrade():
    path = BACKEND / "migrations/versions/0005_memory_foundation.py"
    spec = importlib.util.spec_from_file_location("forward_only_memory_snapshot", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "0004" and module.revision == "0005"
    with pytest.raises(NotImplementedError, match="forward-only"):
        module.downgrade()
