import importlib.util
from datetime import UTC, datetime
from io import StringIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, event, insert, inspect, select, text, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError
from sqlalchemy.schema import CreateIndex, CreateTable

from app.core.config import get_settings
from app.db.base import Base
from app.modules.companion.models import (
    AICompanion,
    ChatGeneration,
    ChatGenerationEvent,
    ChatMessage,
    ChatPreferences,
)
from app.modules.companion.schemas import CreateSession, SendMessage, SessionView

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def migrated_chat(tmp_path, monkeypatch):
    # Only this test's newly-created temporary SQLite file is ever opened.
    url = f"sqlite:///{(tmp_path / 'chat-migration.db').as_posix()}"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", url)
    get_settings.cache_clear()
    config = Config(str(BACKEND / "alembic.ini"))
    command.upgrade(config, "0003")
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def enforce_foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

    identifiers = {
        key: uuid4()
        for key in (
            "owner",
            "other",
            "companion",
            "other_companion",
            "session",
            "empty",
            "other_session",
            "user_message",
            "assistant_message",
            "system_message",
            "other_message",
            "memory",
            "wallet",
            "usage",
        )
    }
    with engine.begin() as db:
        for key in ("owner", "other"):
            db.execute(
                text(
                    "INSERT INTO users (id,email,password_hash,display_name) "
                    "VALUES (:id,:email,'preserved-hash','preserved')"
                ),
                {"id": identifiers[key].hex, "email": f"{key}@migration.invalid"},
            )
        for key, owner in (("companion", "owner"), ("other_companion", "other")):
            db.execute(
                text(
                    "INSERT INTO ai_companions (id,owner_id,name,persona,prompt_version) "
                    "VALUES (:id,:owner,'legacy','legacy persona','v1')"
                ),
                {"id": identifiers[key].hex, "owner": identifiers[owner].hex},
            )
        for key, owner, companion in (
            ("session", "owner", "companion"),
            ("empty", "owner", "companion"),
            ("other_session", "other", "other_companion"),
        ):
            db.execute(
                text(
                    "INSERT INTO chat_sessions (id,owner_id,companion_id,title,created_at) "
                    "VALUES (:id,:owner,:companion,'legacy title','2020-01-01 00:00:00')"
                ),
                {
                    "id": identifiers[key].hex,
                    "owner": identifiers[owner].hex,
                    "companion": identifiers[companion].hex,
                },
            )
        for key, role, sequence, owner, session in (
            ("system_message", "system", 0, "owner", "session"),
            ("user_message", "user", 4, "owner", "session"),
            ("assistant_message", "assistant", 7, "owner", "session"),
            ("other_message", "user", 0, "other", "other_session"),
        ):
            db.execute(
                text(
                    "INSERT INTO chat_messages "
                    "(id,owner_id,session_id,sequence,role,content,provider,"
                    "created_at) VALUES (:id,:owner,:session,:sequence,:role,:content,"
                    "'legacy-provider','2020-02-03 04:05:06')"
                ),
                {
                    "id": identifiers[key].hex,
                    "owner": identifiers[owner].hex,
                    "session": identifiers[session].hex,
                    "sequence": sequence,
                    "role": role,
                    "content": f"preserved {role} 正文",
                },
            )
        db.execute(
            text(
                "INSERT INTO memories (id,owner_id,source_session_id,content,consent_granted_at) "
                "VALUES (:id,:owner,:session,'preserved memory','2020-02-03 04:05:06')"
            ),
            {
                "id": identifiers["memory"].hex,
                "owner": identifiers["owner"].hex,
                "session": identifiers["session"].hex,
            },
        )
        db.execute(
            text("INSERT INTO wallets (id,owner_id) VALUES (:id,:owner)"),
            {"id": identifiers["wallet"].hex, "owner": identifiers["owner"].hex},
        )
        db.execute(
            text(
                "INSERT INTO usage_records (id,wallet_id,owner_id,session_id,provider,model,"
                "input_tokens,output_tokens,idempotency_key) VALUES (:id,:wallet,:owner,:session,"
                "'legacy-provider','legacy-model',1,2,'preserved-usage-key')"
            ),
            {
                "id": identifiers["usage"].hex,
                "wallet": identifiers["wallet"].hex,
                "owner": identifiers["owner"].hex,
                "session": identifiers["session"].hex,
            },
        )
    command.upgrade(config, "head")
    try:
        yield engine, identifiers, config
    finally:
        engine.dispose()
        get_settings.cache_clear()


def test_forward_chat_upgrade_preserves_history_and_references(migrated_chat):
    engine, ids, config = migrated_chat
    command.check(config)
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
        assert len(set(inspect(db).get_table_names()) - {"alembic_version"}) == 34
        assert db.execute(text("PRAGMA foreign_key_check")).all() == []
        rows = db.execute(
            text(
                "SELECT id,role,content,provider,sequence,status,completed_at "
                "FROM chat_messages WHERE session_id=:id ORDER BY sequence"
            ),
            {"id": ids["session"].hex},
        ).all()
        assert [row[:5] for row in rows] == [
            (ids["system_message"].hex, "system", "preserved system 正文", "legacy-provider", 0),
            (ids["user_message"].hex, "user", "preserved user 正文", "legacy-provider", 4),
            (
                ids["assistant_message"].hex,
                "assistant",
                "preserved assistant 正文",
                "legacy-provider",
                7,
            ),
        ]
        assert all(row[5:] == ("completed", "2020-02-03 04:05:06") for row in rows)
        session = db.execute(
            text(
                "SELECT next_message_sequence,last_message_at,last_activity_at,version,create_key,"
                "create_fingerprint FROM chat_sessions WHERE id=:id"
            ),
            {"id": ids["session"].hex},
        ).one()
        assert session == (8, "2020-02-03 04:05:06", "2020-02-03 04:05:06", 1, None, None)
        empty = db.execute(
            text(
                "SELECT next_message_sequence,last_message_at,last_activity_at FROM chat_sessions "
                "WHERE id=:id"
            ),
            {"id": ids["empty"].hex},
        ).one()
        assert empty == (0, None, "2020-01-01 00:00:00")
        assert db.scalar(text("SELECT content FROM memories")) == "preserved memory"
        assert db.scalar(text("SELECT idempotency_key FROM usage_records")) == "preserved-usage-key"
        assert db.scalar(text("SELECT password_hash FROM users LIMIT 1")) == "preserved-hash"
        assert db.scalar(text("SELECT count(*) FROM chat_preferences")) == 0
        assert db.scalar(text("SELECT count(*) FROM ai_companions WHERE is_default")) == 0


def test_chat_database_rejects_duplicate_active_terminal_and_foreign_owner(migrated_chat):
    engine, ids, _ = migrated_chat

    def persist(model, **values):
        with engine.begin() as db:
            db.execute(insert(model), values)

    def rejected(model, **values):
        with pytest.raises(IntegrityError):
            persist(model, **values)

    def message(sequence, role="assistant", **extra):
        values = dict(
            id=uuid4(),
            owner_id=ids["owner"],
            session_id=ids["session"],
            sequence=sequence,
            role=role,
            content="",
            status="queued",
            provider="mock",
        )
        values.update(extra)
        return values

    assistant = message(8)
    second_assistant = message(9)
    persist(ChatMessage, **assistant)
    persist(ChatMessage, **second_assistant)
    rejected(ChatMessage, **message(10, "user"))
    client_message_id = uuid4()
    user = message(
        10, "user", status="completed", provider=None, client_message_id=client_message_id
    )
    persist(ChatMessage, **user)
    rejected(
        ChatMessage,
        **message(
            11, "user", status="completed", provider=None, client_message_id=client_message_id
        ),
    )

    def generation(**extra):
        values = dict(
            id=uuid4(),
            owner_id=ids["owner"],
            session_id=ids["session"],
            user_message_id=ids["user_message"],
            assistant_message_id=assistant["id"],
            operation="send",
            idempotency_key=str(uuid4()),
            request_fingerprint="a" * 64,
            provider="mock",
            prompt_version="companion-v1",
            state="queued",
        )
        values.update(extra)
        return values

    first = generation()
    persist(ChatGeneration, **first)
    rejected(ChatGeneration, **generation(assistant_message_id=second_assistant["id"]))
    with engine.begin() as db:
        db.execute(
            update(ChatGeneration)
            .where(ChatGeneration.id == first["id"])
            .values(state="completed", finished_at=datetime.now(UTC))
        )
    rejected(
        ChatGeneration,
        **generation(
            assistant_message_id=second_assistant["id"], user_message_id=ids["other_message"]
        ),
    )
    rejected(
        ChatGeneration,
        **generation(
            assistant_message_id=second_assistant["id"],
            operation="retry",
            retry_of_generation_id=first["id"],
            user_message_id=user["id"],
        ),
    )
    rejected(
        ChatGeneration, **generation(assistant_message_id=second_assistant["id"], state="completed")
    )
    second = generation(assistant_message_id=second_assistant["id"])
    persist(ChatGeneration, **second)

    event_values = dict(
        owner_id=ids["owner"],
        session_id=ids["session"],
        generation_id=first["id"],
        payload={"content": "persisted"},
    )
    persist(ChatGenerationEvent, event_sequence=2, event_type="completed", **event_values)
    rejected(ChatGenerationEvent, event_sequence=3, event_type="cancelled", **event_values)
    rejected(ChatGenerationEvent, event_sequence=1, event_type="delta", **event_values)
    rejected(
        ChatGenerationEvent,
        event_sequence=4,
        event_type="delta",
        **{**event_values, "owner_id": ids["other"]},
    )
    rejected(ChatPreferences, user_id=ids["owner"], dismissed_session_id=ids["session"])
    rejected(
        ChatPreferences,
        user_id=ids["owner"],
        dismissed_session_id=ids["session"],
        source_message_id=ids["other_message"],
        summary_version="foreign",
    )
    persist(
        ChatPreferences,
        user_id=ids["owner"],
        dismissed_session_id=ids["session"],
        source_message_id=ids["user_message"],
        summary_version="own",
    )
    persist(AICompanion, owner_id=ids["owner"], name="default", persona="mock", is_default=True)
    rejected(AICompanion, owner_id=ids["owner"], name="duplicate", persona="mock", is_default=True)
    with engine.connect() as db:
        assert db.scalar(select(ChatPreferences.recent_topic_enabled)) is False


def test_chat_migration_is_forward_only():
    path = BACKEND / "migrations/versions/0004_chat_persistence.py"
    spec = importlib.util.spec_from_file_location("chat_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with pytest.raises(RuntimeError, match="downgrade is prohibited"):
        migration.downgrade()


def test_postgres_chat_ddl_contains_partial_uniqueness_and_owner_references():
    dialect = postgresql.dialect()
    table = ChatGeneration.__table__
    ddl = str(CreateTable(table).compile(dialect=dialect))
    assert "FOREIGN KEY(user_message_id, session_id, owner_id)" in ddl
    assert "FOREIGN KEY(assistant_message_id, session_id, owner_id)" in ddl
    assert "FOREIGN KEY(retry_of_generation_id, session_id, owner_id, user_message_id)" in ddl
    active_index = next(
        index for index in table.indexes if index.name == "uq_chat_generations_active_session"
    )
    assert "WHERE state IN ('queued','running','cancel_requested')" in str(
        CreateIndex(active_index).compile(dialect=dialect)
    )
    terminal_index = next(
        index
        for index in ChatGenerationEvent.__table__.indexes
        if index.name == "uq_chat_generation_events_terminal"
    )
    assert "WHERE event_type IN ('completed','error','cancelled')" in str(
        CreateIndex(terminal_index).compile(dialect=dialect)
    )
    assert len(Base.metadata.tables) == 34


def test_chat_migration_emits_forward_postgres_sql_without_connecting(monkeypatch):
    monkeypatch.setenv(
        "WEIBIYE_DATABASE_URL",
        "postgresql+psycopg://unused:unused@127.0.0.1:1/weibiye_sql_only",
    )
    get_settings.cache_clear()
    sql = StringIO()
    config = Config(str(BACKEND / "alembic.ini"), output_buffer=sql)
    try:
        command.upgrade(config, "0003:0004", sql=True)
    finally:
        get_settings.cache_clear()
    output = sql.getvalue()
    assert "CREATE TABLE chat_generations" in output
    assert "CREATE TABLE chat_generation_events" in output
    assert "CREATE TABLE chat_preferences" in output
    assert "ALTER TABLE chat_messages ALTER COLUMN provider DROP NOT NULL" in output
    assert "UPDATE chat_sessions SET last_message_at" in output
    assert "CREATE UNIQUE INDEX uq_chat_generations_active_session" in output
    assert "CREATE UNIQUE INDEX uq_chat_generation_events_terminal" in output
    assert "DROP TABLE" not in output
    assert "DELETE FROM" not in output
    assert "TRUNCATE" not in output


def test_chat_request_unicode_and_output_utc_contract():
    from pydantic import ValidationError

    assert CreateSession(title=" \r\n标题\r ").title == "标题"
    command = SendMessage(client_message_id=uuid4(), content=" \r\n你好\r世界\r\n ")
    assert command.content == "你好\n世界"
    assert len(SendMessage(client_message_id=uuid4(), content="😀" * 4000).content) == 4000
    for content in ("😀" * 4001, "\ud800", " \r\n ", "cannot store\x00null"):
        with pytest.raises(ValidationError):
            SendMessage(client_message_id=uuid4(), content=content)
    with pytest.raises(ValidationError):
        SendMessage(client_message_id=uuid4(), content="hello", owner_id=str(uuid4()))
    view = SessionView(
        id=uuid4(),
        companion_id=uuid4(),
        title="UTC",
        version=1,
        created_at=datetime(2020, 1, 1),
        updated_at=datetime(2020, 1, 1, tzinfo=UTC),
        last_activity_at=datetime(2020, 1, 1),
        last_message_at=None,
    )
    assert view.model_dump(mode="json")["created_at"] == "2020-01-01T00:00:00Z"
    assert isinstance(UUID(view.model_dump(mode="json")["id"]), UUID)
