"""Literal, owner-scoped previews and short-lived provenance receipts; no real services."""

import base64
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import event, func, insert, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.errors import AppError
from app.core.security import Principal
from app.db import models  # noqa: F401
from app.db.base import Base
from app.modules.companion.models import AICompanion, ChatMessage, ChatSession
from app.modules.memory.models import Memory, MemoryConsentEvent, MemoryOperation, MemorySource
from app.modules.memory.previews import PreviewRequest, preview_selected, validate_chat_source
from app.modules.memory.schemas import Source
from app.modules.users.models import User

KEY = b"p4b-preview-tests-only-stable-secret-not-production"
AT = datetime(2026, 11, 1, 11, 0, tzinfo=UTC)
TEXTS = [
    "我希望做后端开发。",
    "我喜欢简短自然的交流。",
    "下周还有一个未完成的事项。",
    "我有一次实习经历。",
    "请记住普通事项。",
]


@pytest.fixture
async def preview_database(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'previews.sqlite'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner, other = uuid4(), uuid4()
    principal = Principal(owner, session_id=uuid4())
    session_id, other_session = uuid4(), uuid4()
    companion, other_companion = uuid4(), uuid4()
    ids, assistant_id, foreign_id = [uuid4() for _ in TEXTS], uuid4(), uuid4()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        # This fixture represents the legacy P4 schema capability explicitly;
        # source checks must read real revision metadata rather than bypass it.
        await connection.execute(
            text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)")
        )
        await connection.execute(text("INSERT INTO alembic_version VALUES ('0005')"))
    async with factory() as db, db.begin():
        for user_id in [owner, other]:
            await db.execute(
                insert(User).values(
                    id=user_id,
                    email=f"preview-{user_id.hex}@example.com",
                    password_hash="synthetic-non-login-hash",
                    display_name="preview fixture",
                )
            )
        for user_id, cid, sid in [
            (owner, companion, session_id),
            (other, other_companion, other_session),
        ]:
            await db.execute(
                insert(AICompanion).values(
                    id=cid,
                    owner_id=user_id,
                    name="synthetic",
                    persona="synthetic",
                )
            )
            await db.execute(
                insert(ChatSession).values(
                    id=sid,
                    owner_id=user_id,
                    companion_id=cid,
                    title="synthetic preview",
                    next_message_sequence=6 if user_id == owner else 1,
                )
            )
        for sequence, (identifier, content) in enumerate(zip(ids, TEXTS, strict=True)):
            await db.execute(
                insert(ChatMessage).values(
                    id=identifier,
                    owner_id=owner,
                    session_id=session_id,
                    sequence=sequence,
                    role="user",
                    content=content,
                    status="completed",
                )
            )
        await db.execute(
            insert(ChatMessage).values(
                id=assistant_id,
                owner_id=owner,
                session_id=session_id,
                sequence=5,
                role="assistant",
                content="Mock assistant output is not a user fact.",
                status="completed",
                provider="mock",
            )
        )
        await db.execute(
            insert(ChatMessage).values(
                id=foreign_id,
                owner_id=other,
                session_id=other_session,
                sequence=0,
                role="user",
                content="另一个账户的合成内容。",
                status="completed",
            )
        )
    pref = SimpleNamespace(long_term_memory_enabled=True, version=1, privacy_epoch=7)
    try:
        yield SimpleNamespace(
            engine=engine,
            factory=factory,
            principal=principal,
            pref=pref,
            session_id=session_id,
            other_session=other_session,
            ids=ids,
            assistant_id=assistant_id,
            foreign_id=foreign_id,
        )
    finally:
        await engine.dispose()


def request(data, ids=None, **changes):
    return PreviewRequest.model_validate(
        {
            "session_id": data.session_id,
            "message_ids": ids or data.ids,
            "expected_preferences_version": 1,
            "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
        }
        | changes
    )


async def make_preview(data, ids=None):
    async with data.factory() as db:
        return await preview_selected(
            db, data.principal, request(data, ids), data.pref, key=KEY, at=AT
        )


def source(data, token, ids=None, **changes):
    return Source.model_validate(
        {
            "kind": "chat_message",
            "session_id": data.session_id,
            "message_ids": ids or [data.ids[0]],
            "preview_token": token,
        }
        | changes
    )


async def validate(data, receipt, *, at=AT, principal=None, pref=None, key=KEY):
    async with data.factory() as db:
        return await validate_chat_source(
            db, principal or data.principal, receipt, pref or data.pref, key=key, at=at
        )


async def test_preview_is_literal_bounded_and_does_not_persist(preview_database):
    data = preview_database
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement.lstrip().split()[0].upper())

    event.listen(data.engine.sync_engine, "before_cursor_execute", record)
    try:
        result = await make_preview(data, list(reversed(data.ids)))
    finally:
        event.remove(data.engine.sync_engine, "before_cursor_execute", record)
    assert result["persisted"] is False
    assert result["extractor_version"] == "local-excerpt/1"
    assert len(result["preview_token"]) <= 2048
    assert len(result["candidates"]) == 3
    assert statements and set(statements) == {"SELECT"}
    assert [item["content"] for item in result["candidates"]] == TEXTS[:3]
    assert [item["source_refs"][0]["message_id"] for item in result["candidates"]] == [
        str(identifier) for identifier in data.ids[:3]
    ]
    assert len({item["candidate_id"] for item in result["candidates"]}) == 3
    decoded = json.loads(base64.urlsafe_b64decode(result["preview_token"].split(".")[0] + "=="))
    assert all(content not in json.dumps(decoded, ensure_ascii=False) for content in TEXTS)
    assert datetime.fromisoformat(result["expires_at"]) - AT == timedelta(minutes=5)
    async with data.factory() as db:
        for model in [Memory, MemorySource, MemoryConsentEvent, MemoryOperation]:
            assert await db.scalar(select(func.count()).select_from(model)) == 0


@pytest.mark.parametrize("confirmed", [False, 1, "true", None])
def test_preview_requires_real_boolean_confirmation(confirmed):
    with pytest.raises(ValidationError):
        PreviewRequest.model_validate(
            {
                "session_id": uuid4(),
                "message_ids": [uuid4()],
                "expected_preferences_version": 1,
                "consent": {"confirmed": confirmed, "notice_version": "memory-preview/1"},
            }
        )


def test_preview_rejects_duplicate_or_unbounded_selection():
    identifier = uuid4()
    for identifiers in [[], [identifier, identifier], [uuid4() for _ in range(6)]]:
        with pytest.raises(ValidationError):
            PreviewRequest.model_validate(
                {
                    "session_id": uuid4(),
                    "message_ids": identifiers,
                    "expected_preferences_version": 1,
                    "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
                }
            )


@pytest.mark.parametrize("pref", [None, SimpleNamespace(long_term_memory_enabled=False)])
async def test_disabled_memory_cannot_preview(preview_database, pref):
    data = preview_database
    with pytest.raises(AppError) as error:
        async with data.factory() as db:
            await preview_selected(db, data.principal, request(data), pref, key=KEY, at=AT)
    assert error.value.status == 409 and error.value.code == "MEMORY_DISABLED"


async def test_preference_version_and_authenticated_session_are_required(preview_database):
    data = preview_database
    async with data.factory() as db:
        with pytest.raises(AppError) as mismatch:
            await preview_selected(
                db,
                data.principal,
                request(data, expected_preferences_version=2),
                data.pref,
                key=KEY,
                at=AT,
            )
        assert mismatch.value.code == "PREFERENCES_CONFLICT"
        with pytest.raises(AppError) as anonymous:
            await preview_selected(
                db, Principal(data.principal.user_id), request(data), data.pref, key=KEY, at=AT
            )
        assert anonymous.value.status == 401


@pytest.mark.parametrize("selection", ["foreign", "assistant", "missing", "mixed"])
async def test_only_selected_owned_user_messages_are_available(preview_database, selection):
    data = preview_database
    identifiers = {
        "foreign": [data.foreign_id],
        "assistant": [data.assistant_id],
        "missing": [uuid4()],
        "mixed": [data.ids[0], data.foreign_id],
    }[selection]
    with pytest.raises(AppError) as error:
        await make_preview(data, identifiers)
    assert error.value.status == 404 and error.value.code == "RESOURCE_NOT_FOUND"


async def test_preview_checks_sensitive_sources_outside_first_three_candidates(preview_database):
    data = preview_database
    async with data.factory() as db, db.begin():
        await db.execute(
            update(ChatMessage)
            .where(ChatMessage.id == data.ids[4])
            .values(content="请记住密码是 synthetic-never-a-real-password。")
        )
    with pytest.raises(AppError) as error:
        await make_preview(data)
    assert error.value.status == 422 and error.value.code == "SENSITIVE_MEMORY_REJECTED"
    assert "synthetic-never-a-real-password" not in error.value.message


async def test_candidate_truncation_is_visible_and_original_is_unchanged(preview_database):
    data = preview_database
    long = "普通的合成事项。" * 150
    async with data.factory() as db, db.begin():
        await db.execute(
            update(ChatMessage).where(ChatMessage.id == data.ids[0]).values(content=long)
        )
    item = (await make_preview(data, [data.ids[0]]))["candidates"][0]
    assert len(item["content"]) == 1000 and item["content"].endswith("…")
    assert long.startswith(item["content"][:-1])
    assert len(item["summary"]) == 240 and item["summary"].endswith("…")
    async with data.factory() as db:
        assert (
            await db.scalar(select(ChatMessage.content).where(ChatMessage.id == data.ids[0]))
            == long
        )


async def test_signed_selection_allows_only_nonempty_owned_subsets(preview_database):
    data = preview_database
    preview = await make_preview(data)
    rows = await validate(data, source(data, preview["preview_token"], [data.ids[3], data.ids[0]]))
    assert [row.id for row in rows] == [data.ids[0], data.ids[3]]


async def test_receipt_cannot_expand_to_an_unselected_owned_message(preview_database):
    data = preview_database
    preview = await make_preview(data, [data.ids[0]])
    with pytest.raises(AppError) as error:
        await validate(data, source(data, preview["preview_token"], [data.ids[1]]))
    assert error.value.status == 409 and error.value.code == "PREVIEW_STALE"


@pytest.mark.parametrize("change", ["signature", "key", "auth_session", "epoch", "version"])
async def test_receipt_binds_key_session_and_current_preferences(preview_database, change):
    data = preview_database
    preview = await make_preview(data)
    token = preview["preview_token"]
    principal, pref, key = data.principal, data.pref, KEY
    if change == "signature":
        token = token[:-1] + ("0" if token[-1] != "0" else "1")
    elif change == "key":
        key = b"another-local-test-only-key-0000000000000000"
    elif change == "auth_session":
        principal = Principal(principal.user_id, session_id=uuid4())
    elif change == "epoch":
        pref = SimpleNamespace(long_term_memory_enabled=True, version=1, privacy_epoch=8)
    elif change == "version":
        pref = SimpleNamespace(long_term_memory_enabled=True, version=2, privacy_epoch=7)
    with pytest.raises(AppError) as error:
        await validate(data, source(data, token), principal=principal, pref=pref, key=key)
    assert error.value.status == 409 and error.value.code == "PREVIEW_STALE"


@pytest.mark.parametrize("offset", [timedelta(microseconds=-1), timedelta(minutes=5)])
async def test_receipt_has_an_exact_five_minute_validity_window(preview_database, offset):
    data = preview_database
    preview = await make_preview(data)
    with pytest.raises(AppError) as error:
        await validate(data, source(data, preview["preview_token"]), at=AT + offset)
    assert error.value.code == "PREVIEW_STALE"


async def test_changes_to_signed_but_unsubmitted_source_invalidate_confirmation(preview_database):
    data = preview_database
    preview = await make_preview(data)
    async with data.factory() as db, db.begin():
        await db.execute(
            update(ChatMessage)
            .where(ChatMessage.id == data.ids[4])
            .values(content="修改后的合成普通事项。")
        )
    with pytest.raises(AppError) as error:
        await validate(data, source(data, preview["preview_token"], [data.ids[0]]))
    assert error.value.code == "PREVIEW_STALE"


async def test_deleted_source_session_is_not_recovered_from_receipt(preview_database):
    data = preview_database
    preview = await make_preview(data)
    async with data.factory() as db, db.begin():
        await db.execute(
            update(ChatSession).where(ChatSession.id == data.session_id).values(deleted_at=AT)
        )
    with pytest.raises(AppError) as error:
        await validate(data, source(data, preview["preview_token"]))
    assert error.value.status == 404


async def test_cross_owner_source_is_rejected_before_receipt_checks(preview_database):
    data = preview_database
    preview = await make_preview(data)
    receipt = source(
        data, preview["preview_token"], [data.foreign_id], session_id=data.other_session
    )
    with pytest.raises(AppError) as error:
        await validate(data, receipt)
    assert error.value.status == 404 and error.value.code == "RESOURCE_NOT_FOUND"
