"""Opt-in chat acceptance against an explicitly isolated PostgreSQL database.

Each HTTP request and background operation uses its own committed connection.
Test identities and messages remain as evidence; constraint-only probes roll back
their own local transaction. No database/schema creation, downgrade, or deletion.
"""

import asyncio
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf, login, register
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, func, insert, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from app.agent.chat_runner import ChatRunner, _Claim, _FenceLost, _Identity
from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.db.capabilities import GENERATION_MEMORY_COLUMNS
from app.main import create_app
from app.modules.companion.models import (
    ChatGeneration,
    ChatGenerationEvent,
    ChatMessage,
    ChatSession,
)

PREFIX = "/api/v1/companion"
EXPECTED_CLUSTER = "7703042374370492450"
# This suite intentionally remains on 0004. Inspect every original generation
# column without selecting P4-only columns from the shared model metadata.
V4_GENERATION_COLUMNS = tuple(
    column
    for column in ChatGeneration.__table__.columns
    if column.name not in GENERATION_MEMORY_COLUMNS
)
pytestmark = pytest.mark.skipif(
    not os.environ.get("WEIBIYE_CHAT_TEST_DATABASE_URL"),
    reason=("Requires authorized isolated WEIBIYE_CHAT_TEST_DATABASE_URL; no dev DB fallback"),
)


@pytest.fixture(scope="module")
def postgres_chat_database():
    url = make_url(os.environ["WEIBIYE_CHAT_TEST_DATABASE_URL"])
    assert url.drivername in {"postgresql", "postgresql+psycopg"}, "Unexpected test DB driver"
    assert not url.query, "Database connection query overrides are not allowed"
    assert (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye"), (
        "Unexpected isolated test database target"
    )
    assert re.fullmatch(r"weibiye_p3_test_[0-9a-f]+", url.database or ""), (
        "Refusing to use a database without the isolated P3 test name"
    )
    url = url.set(drivername="postgresql+psycopg")
    engine = create_engine(url, pool_pre_ping=True)
    try:
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            assert db.scalar(text("SELECT current_database()")) == url.database
            assert db.scalar(text("SELECT system_identifier::text FROM pg_control_system()")) == (
                EXPECTED_CLUSTER
            )
            assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0004"
        yield engine, url.render_as_string(hide_password=False)
    finally:
        engine.dispose()


@pytest.fixture
def postgres_chat(postgres_chat_database):
    engine, database_url = postgres_chat_database
    settings = Settings(
        environment="test",
        database_url=SecretStr(database_url),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        llm_provider="mock",
        real_llm_enabled=False,
        auth_store_backend="memory",
        rate_limit_backend="memory",
        chat_runner_enabled=False,
        cors_origins=["http://testserver"],
        frontend_origin="http://testserver",
    )
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        email = f"p3-pg-{uuid4().hex}@example.com"
        assert register(client, email=email).status_code == 202
        response = login(client, email=email)
        assert response.status_code == 200, response.text
        owner = UUID(response.json()["id"])
        try:
            yield engine, client, owner
        finally:
            # End only this test identity's tasks, preserving all database evidence.
            with engine.connect() as db:
                active = db.execute(
                    select(ChatGeneration.session_id, ChatGeneration.id).where(
                        ChatGeneration.owner_id == owner,
                        ChatGeneration.state.in_(("queued", "running", "cancel_requested")),
                    )
                ).all()
            for session_id, generation_id in active:
                _command(
                    client, "POST", f"/sessions/{session_id}/generations/{generation_id}/cancel"
                )


def _command(client, method, path, payload=None, *, key=None, headers=None):
    request_headers = dict(headers) if headers is not None else csrf(client)
    if key is not None:
        request_headers["Idempotency-Key"] = key
    if payload is None and method == "POST":
        payload = {}
    return client.request(method, PREFIX + path, json=payload, headers=request_headers)


def _session(client):
    response = _command(client, "POST", "/sessions", {"title": "PG acceptance"}, key=str(uuid4()))
    assert response.status_code == 201, response.text
    return response.json()["session"]


def _send(
    client,
    session_id,
    *,
    content="真实独立连接的本地 Mock 测试",
    key=None,
    client_id=None,
    headers=None,
):
    return _command(
        client,
        "POST",
        f"/sessions/{session_id}/messages",
        {
            "content": content,
            "client_message_id": client_id or str(uuid4()),
        },
        key=key or str(uuid4()),
        headers=headers,
    )


def _accepted(client, session_id):
    response = _send(client, session_id)
    assert response.status_code == 202, response.text
    return response.json()


def _parallel(first, second):
    barrier = Barrier(2)

    def invoke(action):
        barrier.wait(timeout=10)
        return action()

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(invoke, action) for action in (first, second)]
        return [future.result(timeout=30) for future in pending]


def _running_claim(engine, accepted, *, content):
    """Represent a paused worker with an independently committed live lease."""
    generation_id = UUID(accepted["generation"]["id"])
    with engine.begin() as db:
        generation = (
            db.execute(select(*V4_GENERATION_COLUMNS).where(ChatGeneration.id == generation_id))
            .mappings()
            .one()
        )
        assert generation["state"] == "queued"
        lease_version = generation["lease_version"] + 1
        db.execute(
            update(ChatGeneration)
            .where(ChatGeneration.id == generation_id)
            .values(
                state="running",
                started_at=datetime.now(UTC),
                lease_version=lease_version,
                lease_expires_at=datetime.now(UTC) + timedelta(seconds=30),
            )
        )
        db.execute(
            update(ChatMessage)
            .where(ChatMessage.id == generation["assistant_message_id"])
            .values(status="streaming", content=content)
        )
    return _Claim(
        identity=_Identity(generation_id, generation["owner_id"], generation["session_id"]),
        lease_version=lease_version,
        provider=generation["provider"],
        model=generation["model"],
        prompt_version=generation["prompt_version"],
        context_message_ids=tuple(generation["context_message_ids"]),
        user_message_id=generation["user_message_id"],
    )


def test_postgres_same_idempotency_key_concurrently_accepts_exactly_one_pair(postgres_chat):
    engine, client, _ = postgres_chat
    session = _session(client)
    session_id = UUID(session["id"])
    key, client_id, headers = str(uuid4()), str(uuid4()), csrf(client)
    responses = _parallel(
        lambda: _send(client, session_id, key=key, client_id=client_id, headers=headers),
        lambda: _send(client, session_id, key=key, client_id=client_id, headers=headers),
    )
    assert [response.status_code for response in responses] == [202, 202]
    results = [response.json() for response in responses]
    assert results[0]["generation"]["id"] == results[1]["generation"]["id"]
    assert sorted(result["idempotent_replay"] for result in results) == [False, True]
    with engine.connect() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatMessage)
                .where(ChatMessage.session_id == session_id)
            )
            == 2
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatGeneration)
                .where(ChatGeneration.session_id == session_id)
            )
            == 1
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatGenerationEvent)
                .where(ChatGenerationEvent.session_id == session_id)
            )
            == 1
        )


def test_postgres_different_keys_racing_in_one_session_return_busy(postgres_chat):
    engine, client, _ = postgres_chat
    session_id = UUID(_session(client)["id"])
    headers = csrf(client)
    responses = _parallel(
        lambda: _send(client, session_id, headers=headers),
        lambda: _send(client, session_id, headers=headers),
    )
    assert sorted(response.status_code for response in responses) == [202, 409]
    rejected = next(response for response in responses if response.status_code == 409)
    assert rejected.json()["error"]["code"] == "GENERATION_IN_PROGRESS"
    with engine.connect() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatMessage)
                .where(ChatMessage.session_id == session_id)
            )
            == 2
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatGeneration)
                .where(ChatGeneration.session_id == session_id)
            )
            == 1
        )


def test_postgres_committed_acceptance_and_runner_are_visible_on_independent_connection(
    postgres_chat,
):
    engine, client, _ = postgres_chat
    session_id = UUID(_session(client)["id"])
    accepted = _accepted(client, session_id)
    generation_id = UUID(accepted["generation"]["id"])
    with engine.connect() as db:
        # This sync engine is independent of every HTTP and background AsyncSession.
        assert (
            db.scalar(select(ChatGeneration.state).where(ChatGeneration.id == generation_id))
            == "queued"
        )
        assert db.execute(
            select(ChatMessage.role, ChatMessage.status)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.sequence)
        ).all() == [
            ("user", "completed"),
            ("assistant", "queued"),
        ]
        assert db.execute(
            select(ChatGenerationEvent.event_sequence, ChatGenerationEvent.event_type).where(
                ChatGenerationEvent.generation_id == generation_id
            )
        ).all() == [
            (1, "start"),
        ]
    assert client.portal.call(client.app.state.chat_runner.run_once)
    with engine.connect() as db:
        generation = (
            db.execute(select(*V4_GENERATION_COLUMNS).where(ChatGeneration.id == generation_id))
            .mappings()
            .one()
        )
        assert generation["state"] == "completed" and generation["finished_at"] is not None
        assistant = db.execute(
            select(ChatMessage.content, ChatMessage.status).where(
                ChatMessage.id == UUID(accepted["assistant_message"]["id"])
            )
        ).one()
        assert assistant.status == "completed"
        assert "长期记忆" in assistant.content
        events = db.execute(
            select(
                ChatGenerationEvent.event_sequence,
                ChatGenerationEvent.event_type,
                ChatGenerationEvent.payload,
            )
            .where(ChatGenerationEvent.generation_id == generation_id)
            .order_by(ChatGenerationEvent.event_sequence)
        ).all()
        assert [event.event_sequence for event in events] == list(range(1, len(events) + 1))
        assert any(event.event_type == "delta" for event in events)
        assert events[-1].event_type == "completed"
        assert events[-1].payload["content"] == assistant.content
        assert generation["last_event_sequence"] == events[-1].event_sequence
        assert generation["usage"] is None


def test_postgres_enforces_partial_uniqueness_and_owner_composites(postgres_chat):
    engine, client, owner = postgres_chat
    session_id = UUID(_session(client)["id"])
    accepted = _accepted(client, session_id)
    generation_id = UUID(accepted["generation"]["id"])
    assistant_id = uuid4()
    with engine.connect() as db:
        transaction = db.begin()
        try:
            db.execute(
                insert(ChatMessage),
                dict(
                    id=assistant_id,
                    owner_id=owner,
                    session_id=session_id,
                    sequence=100,
                    role="assistant",
                    status="queued",
                    content="",
                    provider="mock",
                ),
            )
            original = (
                db.execute(select(*V4_GENERATION_COLUMNS).where(ChatGeneration.id == generation_id))
                .mappings()
                .one()
            )
            probe = {
                **original,
                "id": uuid4(),
                "assistant_message_id": assistant_id,
                "idempotency_key": str(uuid4()),
            }

            def refuses(table, values, expected_constraint):
                with pytest.raises(IntegrityError) as error, db.begin_nested():
                    db.execute(insert(table), values)
                assert expected_constraint in error.value.orig.diag.constraint_name

            refuses(ChatGeneration, probe, "uq_chat_generations_active_session")
            db.execute(
                update(ChatGeneration)
                .where(ChatGeneration.id == generation_id)
                .values(state="completed", finished_at=datetime.now(UTC))
            )
            refuses(ChatGeneration, {**probe, "id": uuid4(), "owner_id": uuid4()}, "fk_")
            event = dict(
                generation_id=generation_id,
                owner_id=owner,
                session_id=session_id,
                event_sequence=2,
                event_type="completed",
                payload={"content": "probe"},
            )
            db.execute(insert(ChatGenerationEvent), event)
            refuses(
                ChatGenerationEvent,
                {**event, "event_sequence": 3, "event_type": "cancelled"},
                "uq_chat_generation_events_terminal",
            )
            refuses(
                ChatGenerationEvent,
                {**event, "event_sequence": 4, "event_type": "delta", "owner_id": uuid4()},
                "fk_",
            )
        finally:
            transaction.rollback()
    with engine.connect() as db:
        assert (
            db.scalar(select(ChatGeneration.state).where(ChatGeneration.id == generation_id))
            == "queued"
        )
        assert db.scalar(select(ChatMessage.id).where(ChatMessage.id == assistant_id)) is None


def test_postgres_cancel_before_and_after_completion_preserves_one_terminal(postgres_chat):
    engine, client, _ = postgres_chat
    session_id = UUID(_session(client)["id"])
    cancelled = _accepted(client, session_id)
    cancelled_id = UUID(cancelled["generation"]["id"])
    path = f"/sessions/{session_id}/generations/{cancelled_id}/cancel"
    response = _command(client, "POST", path)
    assert response.status_code == 200, response.text
    assert response.json()["generation"]["state"] == "cancelled"
    assert not client.portal.call(client.app.state.chat_runner.run_once)
    completed = _accepted(client, session_id)
    completed_id = UUID(completed["generation"]["id"])
    assert client.portal.call(client.app.state.chat_runner.run_once)
    response = _command(client, "POST", f"/sessions/{session_id}/generations/{completed_id}/cancel")
    assert response.status_code == 200, response.text
    assert response.json()["generation"]["state"] == "completed"
    with engine.connect() as db:
        for generation_id, event_type in ((cancelled_id, "cancelled"), (completed_id, "completed")):
            terminal = db.scalars(
                select(ChatGenerationEvent.event_type).where(
                    ChatGenerationEvent.generation_id == generation_id,
                    ChatGenerationEvent.event_type.in_(("completed", "cancelled", "error")),
                )
            ).all()
            assert terminal == [event_type]


def test_postgres_expired_running_generation_fails_without_reinvoking_provider(
    postgres_chat, monkeypatch
):
    engine, client, _ = postgres_chat
    session_id = UUID(_session(client)["id"])
    accepted = _accepted(client, session_id)
    generation_id = UUID(accepted["generation"]["id"])
    with engine.begin() as db:
        db.execute(
            update(ChatGeneration)
            .where(ChatGeneration.id == generation_id)
            .values(
                state="running",
                started_at=datetime.now(UTC) - timedelta(seconds=30),
                lease_version=1,
                lease_expires_at=datetime.now(UTC) - timedelta(seconds=5),
            )
        )
        db.execute(
            update(ChatMessage)
            .where(ChatMessage.id == UUID(accepted["assistant_message"]["id"]))
            .values(status="streaming", content="已经提交的部分")
        )

    def forbidden_provider(*args, **kwargs):
        pytest.fail("An expired running generation must never call the provider again")

    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", forbidden_provider)
    assert client.portal.call(client.app.state.chat_runner.run_once)
    with engine.connect() as db:
        generation = db.execute(
            select(
                ChatGeneration.state, ChatGeneration.error_code, ChatGeneration.lease_version
            ).where(ChatGeneration.id == generation_id)
        ).one()
        assert generation.state == "failed" and generation.error_code == "SERVER_RESTARTED"
        assert generation.lease_version > 1
        assistant = db.execute(
            select(ChatMessage.content, ChatMessage.status).where(
                ChatMessage.id == UUID(accepted["assistant_message"]["id"])
            )
        ).one()
        assert assistant == ("已经提交的部分", "failed")
        assert db.scalars(
            select(ChatGenerationEvent.event_type)
            .where(ChatGenerationEvent.generation_id == generation_id)
            .order_by(ChatGenerationEvent.event_sequence)
        ).all() == ["start", "error"]


def test_postgres_stale_worker_cannot_append_or_finish_after_lease_replacement(postgres_chat):
    engine, client, _ = postgres_chat
    session_id = UUID(_session(client)["id"])
    accepted = _accepted(client, session_id)
    partial = "替换租约之前已保存的内容"
    stale = _running_claim(engine, accepted, content=partial)
    runner = client.app.state.chat_runner

    # A committed replacement lease must fence the paused worker while the task
    # remains running; checking only terminal state would miss this case.
    current = replace(stale, lease_version=stale.lease_version + 1)
    with engine.begin() as db:
        db.execute(
            update(ChatGeneration)
            .where(ChatGeneration.id == stale.identity.generation_id)
            .values(
                lease_version=current.lease_version,
                lease_expires_at=datetime.now(UTC) + timedelta(seconds=30),
            )
        )
    with pytest.raises(_FenceLost):
        client.portal.call(runner._flush, stale, "旧工作者迟到的增量")

    async def finish_stale():
        await runner._finish(stale, "completed", pending="旧工作者迟到的终态")

    client.portal.call(finish_stale)
    with engine.connect() as db:
        generation = db.execute(
            select(ChatGeneration.state, ChatGeneration.last_event_sequence).where(
                ChatGeneration.id == stale.identity.generation_id
            )
        ).one()
        assert generation == ("running", 1)
        assert (
            db.scalar(
                select(ChatMessage.content).where(
                    ChatMessage.id == UUID(accepted["assistant_message"]["id"])
                )
            )
            == partial
        )
        assert db.scalars(
            select(ChatGenerationEvent.event_type).where(
                ChatGenerationEvent.generation_id == stale.identity.generation_id
            )
        ).all() == ["start"]

    async def finish_current():
        successor = ChatRunner(client.app.state.session_factory, client.app.state.settings)
        await successor._flush(current, "新租约的增量")
        await successor._finish(current, "completed")

    client.portal.call(finish_current)
    client.portal.call(finish_stale)
    with engine.connect() as db:
        assistant = db.execute(
            select(ChatMessage.status, ChatMessage.content).where(
                ChatMessage.id == UUID(accepted["assistant_message"]["id"])
            )
        ).one()
        assert assistant == ("completed", partial + "新租约的增量")
        assert db.scalars(
            select(ChatGenerationEvent.event_type)
            .where(ChatGenerationEvent.generation_id == stale.identity.generation_id)
            .order_by(ChatGenerationEvent.event_sequence)
        ).all() == ["start", "delta", "completed"]


def test_postgres_concurrent_cancel_and_finish_commit_one_consistent_terminal(postgres_chat):
    engine, client, _ = postgres_chat
    session_id = UUID(_session(client)["id"])
    accepted = _accepted(client, session_id)
    partial, pending = "已经提交的部分", "与取消竞争的最后一段"
    claim = _running_claim(engine, accepted, content=partial)
    runner = client.app.state.chat_runner
    path = f"/sessions/{session_id}/generations/{claim.identity.generation_id}/cancel"
    headers = csrf(client)

    async def race():
        gate = asyncio.Barrier(2)

        async def finish():
            await asyncio.wait_for(gate.wait(), timeout=5)
            await runner._finish(claim, "completed", pending=pending)

        async def cancel():
            await asyncio.wait_for(gate.wait(), timeout=5)
            return await asyncio.to_thread(_command, client, "POST", path, headers=headers)

        _, response = await asyncio.wait_for(asyncio.gather(finish(), cancel()), timeout=15)
        return response

    response = client.portal.call(race)
    assert response.status_code in {200, 202}, response.text
    assert response.json()["generation"]["state"] in {
        "completed",
        "cancel_requested",
        "cancelled",
    }
    with engine.connect() as db:
        generation = db.execute(
            select(ChatGeneration.state, ChatGeneration.last_event_sequence).where(
                ChatGeneration.id == claim.identity.generation_id
            )
        ).one()
        assert generation.state in {"completed", "cancelled"}
        assistant = db.execute(
            select(ChatMessage.status, ChatMessage.content).where(
                ChatMessage.id == UUID(accepted["assistant_message"]["id"])
            )
        ).one()
        assert assistant.status == generation.state
        assert assistant.content == partial + (pending if generation.state == "completed" else "")
        events = db.execute(
            select(
                ChatGenerationEvent.event_sequence,
                ChatGenerationEvent.event_type,
                ChatGenerationEvent.payload,
            )
            .where(ChatGenerationEvent.generation_id == claim.identity.generation_id)
            .order_by(ChatGenerationEvent.event_sequence)
        ).all()
        terminal = [
            event for event in events if event.event_type in {"completed", "error", "cancelled"}
        ]
        assert len(terminal) == 1
        assert events[-1].event_type == generation.state
        assert events[-1].payload["content"] == assistant.content
        assert generation.last_event_sequence == events[-1].event_sequence
        assert [event.event_sequence for event in events] == list(range(1, len(events) + 1))


def test_postgres_concurrent_rename_uses_real_row_version_lock(postgres_chat):
    _, client, _ = postgres_chat
    session = _session(client)
    headers = csrf(client)

    def rename(title):
        return _command(
            client,
            "PATCH",
            f"/sessions/{session['id']}",
            {"title": title, "expected_version": session["version"]},
            headers=headers,
        )

    responses = _parallel(lambda: rename("窗口一"), lambda: rename("窗口二"))
    assert sorted(response.status_code for response in responses) == [200, 409]
    winner = next(response for response in responses if response.status_code == 200).json()
    loser = next(response for response in responses if response.status_code == 409).json()
    assert winner["version"] == session["version"] + 1
    assert loser["error"]["code"] == "VERSION_CONFLICT"
    detail = client.get(PREFIX + f"/sessions/{session['id']}")
    assert detail.status_code == 200
    assert detail.json()["title"] == winner["title"]


def test_postgres_independent_row_lock_blocks_command_until_released(postgres_chat):
    engine, client, _ = postgres_chat
    session = _session(client)
    headers = csrf(client)
    with (
        engine.connect() as lock_connection,
        engine.connect().execution_options(isolation_level="AUTOCOMMIT") as observer,
    ):
        transaction = lock_connection.begin()
        lock_connection.execute(
            select(ChatSession.id).where(ChatSession.id == UUID(session["id"])).with_for_update()
        ).one()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                _command,
                client,
                "PATCH",
                f"/sessions/{session['id']}",
                {"title": "独立连接释放之后", "expected_version": session["version"]},
                headers=headers,
            )
            try:
                deadline = time.monotonic() + 5
                waiting = False
                while time.monotonic() < deadline and not pending.done():
                    waiting = bool(
                        observer.scalar(
                            text(
                                "SELECT count(*) FROM pg_stat_activity "
                                "WHERE datname=current_database() AND pid <> pg_backend_pid() "
                                "AND wait_event_type='Lock'"
                            )
                        )
                    )
                    if waiting:
                        break
                    time.sleep(0.02)
                assert waiting, (
                    "HTTP command did not wait for the independently held PostgreSQL lock"
                )
                assert not pending.done()
            finally:
                transaction.rollback()
            response = pending.result(timeout=15)
    assert response.status_code == 200, response.text
    assert response.json()["title"] == "独立连接释放之后"
