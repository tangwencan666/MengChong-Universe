"""Compatibility and policy fences use only explicitly isolated temporary SQLite files."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import (
    ForeignKeyConstraint,
    MetaData,
    UniqueConstraint,
    create_engine,
    inspect,
    select,
    text,
    update,
)

from app.agent.memory_boundary import invalidate_owner_generations
from app.agent.providers import PrivateMockLLM
from app.core.config import Settings, get_settings
from app.core.event_loop import new_event_loop
from app.db import capabilities
from app.db.base import Base
from app.db.capabilities import (
    SchemaUnavailable,
    require_capability,
    require_enabled_capabilities,
)
from app.db.session import build_database
from app.main import create_app
from app.modules.companion.models import ChatGeneration
from app.modules.memory.models import MemoryPreferences
from app.modules.users.models import User
from tests.auth_helpers import csrf, login, register

BACKEND = Path(__file__).resolve().parents[1]


def migrate_file(path, revision, monkeypatch):
    url = f"sqlite:///{path.as_posix()}"
    monkeypatch.setenv("WEIBIYE_DATABASE_URL", url)
    get_settings.cache_clear()
    config = Config(str(BACKEND / "alembic.ini"))
    command.upgrade(config, revision)
    get_settings.cache_clear()
    return create_engine(url)


async def check_capability(path, capability, *, settings=None):
    engine, factory = build_database(f"sqlite+aiosqlite:///{path.as_posix()}")
    try:
        async with factory() as db:
            if settings is not None:
                return await require_enabled_capabilities(db, settings)
            return await require_capability(db, capability)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("revision", ["0004", "0005", "0006"])
def test_explicit_chat_capabilities_on_both_real_migrations(tmp_path, monkeypatch, revision):
    path = tmp_path / f"schema-{revision}.db"
    engine = migrate_file(path, revision, monkeypatch)
    try:
        assert asyncio.run(check_capability(path, "chat")) == revision
        if revision == "0004":
            with pytest.raises(SchemaUnavailable):
                asyncio.run(check_capability(path, "memory"))
            assert "memory_epoch" not in {
                column["name"] for column in inspect(engine).get_columns("chat_generations")
            }
        else:
            assert asyncio.run(check_capability(path, "memory")) == revision
    finally:
        engine.dispose()


@pytest.mark.parametrize("versions", [["0003"], ["0007"], [], ["0004", "0005"]])
def test_unexpected_or_multiple_heads_are_not_allowed(tmp_path, monkeypatch, versions):
    path = tmp_path / "untrusted-revision.db"
    engine = migrate_file(path, "0004", monkeypatch)
    try:
        # Only this temporary file's version metadata is varied; no downgrade executes.
        with engine.begin() as db:
            db.execute(text("DELETE FROM alembic_version"))
            for revision in versions:
                db.execute(
                    text("INSERT INTO alembic_version(version_num) VALUES (:revision)"),
                    {"revision": revision},
                )
        with pytest.raises(SchemaUnavailable):
            asyncio.run(check_capability(path, "chat"))
    finally:
        engine.dispose()


def test_known_revision_without_required_index_is_rejected(tmp_path):
    path = tmp_path / "incomplete-manifest.db"
    metadata = MetaData(naming_convention=Base.metadata.naming_convention)
    for table in Base.metadata.tables.values():
        table.to_metadata(metadata)
    session_table = metadata.tables["chat_sessions"]
    omitted = next(
        index
        for index in session_table.indexes
        if index.name == "ix_chat_sessions_owner_activity_visible"
    )
    session_table.indexes.remove(omitted)
    engine = create_engine(f"sqlite:///{path.as_posix()}")
    try:
        metadata.create_all(engine)
        with engine.begin() as db:
            db.execute(text("CREATE TABLE alembic_version(version_num VARCHAR(32) PRIMARY KEY)"))
            db.execute(text("INSERT INTO alembic_version VALUES ('0005')"))
        with pytest.raises(SchemaUnavailable):
            asyncio.run(check_capability(path, "chat"))
    finally:
        engine.dispose()


@pytest.mark.parametrize("kind", ["foreign_key_constraint", "unique_constraint"])
def test_same_name_but_wrong_constraint_relationship_is_rejected(tmp_path, kind):
    path = tmp_path / f"wrong-{kind}.db"
    metadata = MetaData(naming_convention=Base.metadata.naming_convention)
    for table in Base.metadata.tables.values():
        table.to_metadata(metadata)
    sessions = metadata.tables["chat_sessions"]
    original = next(
        constraint
        for constraint in sessions.constraints
        if constraint.__visit_name__ == kind and len(constraint.columns) == 2
    )
    sessions.constraints.remove(original)
    if kind == "foreign_key_constraint":
        sessions.append_constraint(
            ForeignKeyConstraint(
                ["companion_id", "owner_id"], ["users.id", "users.id"], name=original.name
            )
        )
    else:
        sessions.append_constraint(UniqueConstraint("owner_id", "title", name=original.name))
    engine = create_engine(f"sqlite:///{path.as_posix()}")
    try:
        metadata.create_all(engine)
        with engine.begin() as db:
            db.execute(text("CREATE TABLE alembic_version(version_num VARCHAR(32) PRIMARY KEY)"))
            db.execute(text("INSERT INTO alembic_version VALUES ('0005')"))
        with pytest.raises(SchemaUnavailable):
            asyncio.run(check_capability(path, "chat"))
    finally:
        engine.dispose()


def test_manifest_cache_is_engine_local_and_strict_failure_clears_it(tmp_path, monkeypatch):
    path = tmp_path / "cached-manifest.db"
    sync_engine = migrate_file(path, "0005", monkeypatch)
    calls = 0
    allow = True
    original = capabilities._manifest_matches

    def manifest(connection, revision):
        nonlocal calls
        calls += 1
        return allow and original(connection, revision)

    monkeypatch.setattr(capabilities, "_manifest_matches", manifest)

    async def exercise():
        nonlocal allow
        engine, factory = build_database(f"sqlite+aiosqlite:///{path.as_posix()}")
        try:
            for _ in range(3):
                async with factory() as db:
                    assert await require_capability(db, "chat") == "0005"
            assert calls == 1
            async with factory() as db:
                assert await require_capability(db, "memory", verify_schema=True) == "0005"
            assert calls == 2
            allow = False
            async with factory() as db:
                with pytest.raises(SchemaUnavailable):
                    await require_capability(db, "chat", verify_schema=True)
            async with factory() as db:
                with pytest.raises(SchemaUnavailable):
                    await require_capability(db, "chat")
            assert calls == 4
            allow = True
            assert await check_capability(path, "chat") == "0005"
            assert calls == 5
        finally:
            await engine.dispose()

    try:
        asyncio.run(exercise())
    finally:
        sync_engine.dispose()


def test_revision_change_invalidates_cached_manifest(tmp_path, monkeypatch):
    path = tmp_path / "revision-change.db"
    sync_engine = migrate_file(path, "0004", monkeypatch)

    async def exercise():
        engine, factory = build_database(f"sqlite+aiosqlite:///{path.as_posix()}")
        try:
            async with factory() as db:
                assert await require_capability(db, "chat") == "0004"
            # Claiming a newer revision without the corresponding DDL cannot reuse V4 approval.
            with sync_engine.begin() as db:
                db.execute(text("UPDATE alembic_version SET version_num='0005'"))
            async with factory() as db:
                with pytest.raises(SchemaUnavailable):
                    await require_capability(db, "chat")
        finally:
            await engine.dispose()

    try:
        asyncio.run(exercise())
    finally:
        sync_engine.dispose()


def test_enabling_memory_on_0004_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "unsupported-feature.db"
    engine = migrate_file(path, "0004", monkeypatch)
    try:
        with pytest.raises(SchemaUnavailable):
            asyncio.run(
                check_capability(
                    path, "memory", settings=SimpleNamespace(memory_management_enabled=True)
                )
            )
    finally:
        engine.dispose()


@pytest.mark.parametrize("revision", ["0004", "0005"])
def test_chat_acceptance_worker_history_and_ready_remain_compatible(
    tmp_path, monkeypatch, revision
):
    path = tmp_path / f"real-chat-{revision}.db"
    engine = migrate_file(path, revision, monkeypatch)
    settings = Settings(
        environment="test",
        database_url=SecretStr(f"sqlite+aiosqlite:///{path.as_posix()}"),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        cors_origins=["http://testserver"],
        chat_runner_enabled=False,
        real_llm_enabled=False,
        llm_provider="mock",
    )
    try:
        with TestClient(
            create_app(settings),
            backend_options={"loop_factory": new_event_loop},
            headers={"Origin": "http://testserver"},
        ) as client:

            async def ping():
                return True

            monkeypatch.setattr(client.app.state.redis, "ping", ping)
            assert client.get("/health/ready").status_code == 200
            assert register(client, email=f"schema-{revision}@example.com").status_code == 202
            assert login(client, email=f"schema-{revision}@example.com").status_code == 200
            session = client.post(
                "/api/v1/companion/sessions",
                json={},
                headers={**csrf(client), "Idempotency-Key": str(uuid4())},
            )
            assert session.status_code == 201, session.text
            session_id = session.json()["session"]["id"]
            accepted = client.post(
                f"/api/v1/companion/sessions/{session_id}/messages",
                json={"client_message_id": str(uuid4()), "content": "schema compatibility probe"},
                headers={**csrf(client), "Idempotency-Key": str(uuid4())},
            )
            assert accepted.status_code == 202, accepted.text
            assert client.portal.call(client.app.state.chat_runner.run_once)
            history = client.get(f"/api/v1/companion/sessions/{session_id}/messages")
            assert history.status_code == 200
            assert [message["status"] for message in history.json()["items"]] == [
                "completed",
                "completed",
            ]
            generation_id = UUID(accepted.json()["generation"]["id"])
            with engine.connect() as db:
                # Mapper SELECT deliberately remains V4 on both schemas.
                assert (
                    db.execute(
                        select(ChatGeneration.id).where(ChatGeneration.id == generation_id)
                    ).scalar_one()
                    == generation_id
                )
                if revision == "0005":
                    assert (
                        db.scalar(
                            select(ChatGeneration.__table__.c.memory_epoch).where(
                                ChatGeneration.id == generation_id
                            )
                        )
                        == 0
                    )
    finally:
        engine.dispose()
        get_settings.cache_clear()


def test_policy_changes_cancel_queued_work_and_fence_derived_history(auth_database, monkeypatch):
    engine, settings = auth_database
    settings = settings.model_copy(update={"chat_runner_enabled": False})
    captured = []

    class CaptureMock(PrivateMockLLM):
        async def stream(self, messages, system_prompt):
            captured.append(messages)
            async for chunk in super().stream(messages, system_prompt):
                yield chunk

    monkeypatch.setattr(
        "app.agent.chat_runner.build_private_provider", lambda *_args: CaptureMock()
    )
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        assert register(client, email="epoch-owner@example.com").status_code == 202
        identity = login(client, email="epoch-owner@example.com")
        assert identity.status_code == 200
        owner = UUID(identity.json()["id"])
        session = client.post(
            "/api/v1/companion/sessions",
            json={},
            headers={**csrf(client), "Idempotency-Key": str(uuid4())},
        ).json()["session"]["id"]

        def send_message(content):
            response = client.post(
                f"/api/v1/companion/sessions/{session}/messages",
                json={"client_message_id": str(uuid4()), "content": content},
                headers={**csrf(client), "Idempotency-Key": str(uuid4())},
            )
            assert response.status_code == 202, response.text
            return response.json()

        first = send_message("old source before privacy barrier")
        assert client.portal.call(client.app.state.chat_runner.run_once)
        queued = send_message("queued before privacy barrier")

        async def privacy_change():
            async with client.app.state.session_factory() as db, db.begin():
                await db.scalar(select(User).where(User.id == owner).with_for_update())
                db.add(
                    MemoryPreferences(
                        user_id=owner,
                        long_term_memory_enabled=False,
                        version=1,
                        privacy_epoch=1,
                        context_epoch_floor=1,
                        last_revision=1,
                    )
                )
                await db.flush()
                cancelled = await invalidate_owner_generations(db, owner)
                assert cancelled == [UUID(queued["generation"]["id"])]

        client.portal.call(privacy_change)
        assert not client.portal.call(client.app.state.chat_runner.run_once)
        snapshot = client.get(
            f"/api/v1/companion/sessions/{session}/generations/{queued['generation']['id']}"
        )
        assert snapshot.json()["generation"]["state"] == "cancelled"
        events = client.get(
            f"/api/v1/companion/sessions/{session}/generations/{queued['generation']['id']}/events"
        )
        assert events.status_code == 200 and "memory_policy_changed" in events.text
        with engine.begin() as db:
            # A legacy NULL is epoch zero even if message timestamps are unchanged.
            db.execute(
                update(ChatGeneration.__table__)
                .where(ChatGeneration.id == UUID(first["generation"]["id"]))
                .values(memory_epoch=None)
            )
        current = send_message("current input after privacy barrier")
        with engine.connect() as db:
            ids = db.scalar(
                select(ChatGeneration.context_message_ids).where(
                    ChatGeneration.id == UUID(current["generation"]["id"])
                )
            )
            assert ids == [current["user_message"]["id"]]
        assert client.portal.call(client.app.state.chat_runner.run_once)
        assert captured[-1] == [{"role": "user", "content": "current input after privacy barrier"}]
        with engine.begin() as db:
            # An additive change advances epoch, not the destructive-history floor.
            db.execute(
                update(MemoryPreferences)
                .where(MemoryPreferences.user_id == owner)
                .values(privacy_epoch=2, last_revision=2)
            )
        later = send_message("another current input")
        with engine.connect() as db:
            ids = db.scalar(
                select(ChatGeneration.context_message_ids).where(
                    ChatGeneration.id == UUID(later["generation"]["id"])
                )
            )
            assert ids == [
                current["user_message"]["id"],
                current["assistant_message"]["id"],
                later["user_message"]["id"],
            ]
        assert client.portal.call(client.app.state.chat_runner.run_once)
