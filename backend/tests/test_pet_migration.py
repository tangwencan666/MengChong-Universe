"""0006 is additive and only ever exercised on temporary SQLite/PostgreSQL DDL."""

import asyncio
import hashlib
import importlib.util
from io import StringIO
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.db.base import Base
from app.db.capabilities import PET_TABLES, SchemaUnavailable, require_capability
from app.db.session import build_database

BACKEND = Path(__file__).resolve().parents[1]


def snapshot(db, names):
    inspector = inspect(db)
    result = {}
    for name in sorted(names):
        columns = inspector.get_columns(name)
        rows = db.exec_driver_sql('SELECT * FROM "' + name + '"').all()
        indexes = inspector.get_indexes(name)
        for index in indexes:
            # Inspector returns fresh TextClause instances for partial predicates.
            index["dialect_options"] = {
                key: str(value) for key, value in index.get("dialect_options", {}).items()
            }
        structure = {
            "columns": [(c["name"], str(c["type"]), c["nullable"], c["default"]) for c in columns],
            "pk": inspector.get_pk_constraint(name),
            "fk": inspector.get_foreign_keys(name),
            "uq": inspector.get_unique_constraints(name),
            "checks": inspector.get_check_constraints(name),
            "indexes": indexes,
        }
        result[name] = (
            structure,
            len(rows),
            hashlib.sha256(repr(sorted(map(tuple, rows))).encode()).hexdigest(),
        )
    return result


@pytest.fixture
def pet_migration(tmp_path, monkeypatch):
    path = tmp_path / "pet-migration-isolated.db"
    url = f"sqlite:///{path.as_posix()}"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", url)
    get_settings.cache_clear()
    config = Config(str(BACKEND / "alembic.ini"))
    command.upgrade(config, "0005")
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def fk_on(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

    ids = {key: uuid4().hex for key in ["owner", "other", "companion", "session", "memory"]}
    with engine.begin() as db:
        for owner in ["owner", "other"]:
            db.execute(
                text(
                    "INSERT INTO users(id,email,password_hash,display_name) VALUES (:id,:em"
                    "ail,'fixture-hash','fixture')"
                ),
                {"id": ids[owner], "email": owner + "@pet-migration.invalid"},
            )
        db.execute(
            text(
                "INSERT INTO ai_companions(id,owner_id,name,persona) VALUES (:id,:owner"
                ",'old companion','legacy')"
            ),
            {"id": ids["companion"], "owner": ids["owner"]},
        )
        db.execute(
            text(
                "INSERT INTO chat_sessions(id,owner_id,companion_id,title) VALUES (:id,"
                ":owner,:companion,'preserved legacy chat')"
            ),
            {"id": ids["session"], "owner": ids["owner"], "companion": ids["companion"]},
        )
        db.execute(
            text(
                "INSERT INTO memories(id,owner_id,content,consent_granted_at) VALUES (:"
                "id,:owner,'preserved legacy memory','2025-01-01')"
            ),
            {"id": ids["memory"], "owner": ids["owner"]},
        )
        old_names = set(inspect(db).get_table_names()) - {"alembic_version"}
        assert len(old_names) == 26
        before = snapshot(db, old_names)
    command.upgrade(config, "0006")
    try:
        yield engine, config, ids, before, path
    finally:
        engine.dispose()
        get_settings.cache_clear()


def test_pet_migration_preserves_all_legacy_schema_rows_and_hashes(pet_migration):
    engine, config, _, before, _ = pet_migration
    command.check(config)
    with engine.connect() as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
        tables = set(inspect(db).get_table_names()) - {"alembic_version"}
        assert len(tables) == 34 and tables - before.keys() == PET_TABLES
        assert snapshot(db, before.keys()) == before
        assert (
            compare_metadata(
                MigrationContext.configure(db, opts={"compare_type": True}), Base.metadata
            )
            == []
        )
        assert db.exec_driver_sql("PRAGMA foreign_key_check").all() == []
        assert db.execute(text("SELECT status,active_consent_id FROM memories")).one() == (
            "legacy_unconfirmed",
            None,
        )
        for name in PET_TABLES:
            assert db.scalar(text('SELECT count(*) FROM "' + name + '"')) == 0


def test_pet_constraints_refuse_cross_owner_and_cross_pet_sources(pet_migration):
    engine, _, ids, _, _ = pet_migration
    pet_a, pet_b, companion_a, companion_b, memory_b, message = [uuid4().hex for _ in range(6)]
    with engine.begin() as db:
        for companion in [companion_a, companion_b]:
            db.execute(
                text(
                    "INSERT INTO ai_companions(id,owner_id,name,persona,prompt_version) VAL"
                    "UES (:id,:owner,'new pet','pet persona','pet-v1')"
                ),
                {"id": companion, "owner": ids["owner"]},
            )
        for pet, companion in [(pet_a, companion_a), (pet_b, companion_b)]:
            db.execute(
                text(
                    "INSERT INTO pets(id,owner_id,companion_id,name,role_type,persona_confi"
                    "g,appearance_config,create_key,create_fingerprint) VALUES (:id,:owner,"
                    ":companion,'pet','cat','{}','{}',:id,:fingerprint)"
                ),
                {"id": pet, "owner": ids["owner"], "companion": companion, "fingerprint": "a" * 64},
            )
        db.execute(
            text(
                "INSERT INTO pet_chat_bindings(session_id,owner_id,pet_id) VALUES (:ses"
                "sion,:owner,:pet)"
            ),
            {"session": ids["session"], "owner": ids["owner"], "pet": pet_a},
        )
        db.execute(
            text(
                "INSERT INTO pet_memories(id,owner_id,pet_id,content,consent_granted_at"
                ") VALUES (:id,:owner,:pet,'fixture','2025-01-01')"
            ),
            {"id": memory_b, "owner": ids["owner"], "pet": pet_b},
        )
        db.execute(
            text(
                "INSERT INTO chat_messages(id,session_id,owner_id,role,content,sequence"
                ",status) VALUES (:id,:session,:owner,'user','fixture',0,'completed')"
            ),
            {"id": message, "session": ids["session"], "owner": ids["owner"]},
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO pets(id,owner_id,companion_id,name,role_type,persona_confi"
                "g,appearance_config,create_key,create_fingerprint) VALUES (:id,:owner,"
                ":companion,'pet','cat','{}','{}',:id,:fingerprint)"
            ),
            {
                "id": uuid4().hex,
                "owner": ids["other"],
                "companion": companion_a,
                "fingerprint": "b" * 64,
            },
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO pet_memory_sources(id,owner_id,pet_id,memory_id,kind,sessi"
                "on_id,message_id,source_message_version) VALUES (:id,:owner,:pet,:memo"
                "ry,'chat_message',:session,:message,1)"
            ),
            {
                "id": uuid4().hex,
                "owner": ids["owner"],
                "pet": pet_b,
                "memory": memory_b,
                "session": ids["session"],
                "message": message,
            },
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO pet_memory_consents(id,owner_id,pet_id,revision,action,mem"
                "ory_id,memory_version,policy_version,notice_version,privacy_epoch) VAL"
                "UES (:id,:owner,:pet,1,'confirmed',:memory,1,'policy','notice',1)"
            ),
            {"id": uuid4().hex, "owner": ids["owner"], "pet": pet_a, "memory": memory_b},
        )


def test_pet_capability_is_explicit_and_legacy_capabilities_remain(pet_migration):
    _, _, _, _, path = pet_migration

    async def check():
        engine, factory = build_database(f"sqlite+aiosqlite:///{path.as_posix()}")
        try:
            async with factory() as db:
                assert await require_capability(db, "chat") == "0006"
                assert await require_capability(db, "memory") == "0006"
                assert await require_capability(db, "pets") == "0006"
                await db.execute(text("UPDATE alembic_version SET version_num='0005'"))
                assert await require_capability(db, "chat") == "0005"
                assert await require_capability(db, "memory") == "0005"
                with pytest.raises(SchemaUnavailable):
                    await require_capability(db, "pets")
                await db.rollback()
        finally:
            await engine.dispose()

    asyncio.run(check())


def test_pet_forward_postgresql_ddl_adds_only_new_tables(monkeypatch):
    monkeypatch.setenv(
        "WEIBIYE_DATABASE_URL", "postgresql+psycopg://unused:unused@127.0.0.1:1/weibiye_sql_only"
    )
    get_settings.cache_clear()
    output = StringIO()
    try:
        command.upgrade(
            Config(str(BACKEND / "alembic.ini"), output_buffer=output), "0005:0006", sql=True
        )
    finally:
        get_settings.cache_clear()
    ddl = output.getvalue()
    assert ddl.count("CREATE TABLE ") == 8
    assert "DROP " not in ddl and "DELETE " not in ddl and "TRUNCATE " not in ddl
    assert "ALTER TABLE pet_memories ADD CONSTRAINT" in ddl
    assert "FOREIGN KEY(session_id, owner_id, pet_id)" in ddl
    assert "FOREIGN KEY(active_consent_id, id, owner_id, pet_id, version)" in ddl
    assert "UPDATE alembic_version SET version_num='0006'" in ddl
    for legacy in ["users", "ai_companions", "chat_sessions", "chat_messages", "memories"]:
        assert "ALTER TABLE " + legacy + " " not in ddl


def test_pet_migration_is_static_and_forward_only():
    path = BACKEND / "migrations/versions/0006_pet_scope.py"
    source = path.read_text(encoding="utf-8")
    assert "from app." not in source and "import app." not in source
    spec = importlib.util.spec_from_file_location("pet_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == "0006" and module.down_revision == "0005"
    with pytest.raises(RuntimeError, match="forward-only"):
        module.downgrade()
