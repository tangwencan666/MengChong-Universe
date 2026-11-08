"""Opt-in P4-B acceptance with real PostgreSQL, graph runtime and observing Mock.

The database must already be created and migrated by the coordinating operator.
This suite neither migrates nor cleans databases; all synthetic evidence remains.
"""

import asyncio
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from threading import Event
from time import monotonic
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf
from pydantic import SecretStr, ValidationError
from sqlalchemy import create_engine, event, func, inspect, select, text, update
from sqlalchemy.engine import make_url
from test_memory_api import CONSENT, PREFIX, account, command, create_item, enable, preferences
from test_memory_injection import (
    CHAT,
    FACT,
    OTHER_FACT,
    QUERY,
    InjectionSpy,
    create_chat_session,
    entries,
    memory_blocks,
    open_client,
    references,
    run_chat,
    runtime_class,
    send_chat,
)

from app.agent.chat_runner import ChatRunner
from app.core.config import Settings
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.companion.service import ChatService
from app.modules.memory.budget import mock_count_messages
from app.modules.memory.models import (
    Memory,
    MemoryConsentEvent,
    MemoryGenerationRef,
    MemoryPreferences,
    MemorySource,
)
from app.modules.memory.service import MemoryService

TEST_KEY = "p4b-pg-tests-only-stable-hmac-not-a-production-secret"
pytestmark = pytest.mark.skipif(
    not os.environ.get("WEIBIYE_P4B_TEST_DATABASE_URL"),
    reason="Requires strictly isolated WEIBIYE_P4B_TEST_DATABASE_URL; no development fallback",
)


@pytest.fixture(scope="module")
def p4b_postgres_database():
    url = make_url(os.environ["WEIBIYE_P4B_TEST_DATABASE_URL"])
    assert url.drivername in {"postgresql", "postgresql+psycopg"}
    assert not url.query
    assert (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
    assert re.fullmatch(r"weibiye_p4b_test_[0-9a-f]{32}", url.database or ""), (
        "Refusing a database without the exact isolated P4-B name"
    )
    url = url.set(drivername="postgresql+psycopg")
    engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
    try:
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            assert db.scalar(text("SELECT current_database()")) == url.database
            assert db.scalar(text("SELECT current_user")) == "weibiye"
            assert db.scalar(text("SELECT system_identifier::text FROM pg_control_system()")) == (
                "7703042374370492450"
            )
            assert db.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == [
                "0005"
            ]
            assert len(set(inspect(db).get_table_names()) - {"alembic_version"}) == 26
        yield engine, url.render_as_string(hide_password=False)
    finally:
        engine.dispose()


@pytest.fixture
def p4b_pg(p4b_postgres_database, monkeypatch):
    engine, url = p4b_postgres_database
    settings = Settings(
        environment="test",
        database_url=SecretStr(url),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        llm_provider="mock",
        real_llm_enabled=False,
        memory_management_enabled=True,
        memory_injection_enabled=True,
        memory_hmac_key=SecretStr(TEST_KEY),
        chat_runner_enabled=False,
        frontend_origin="http://testserver",
        cors_origins=["http://testserver"],
    )
    spy = InjectionSpy()
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: spy)
    run = uuid4().hex
    with ExitStack() as stack:
        clients, owners = [], []
        for label in ("a", "b"):
            client = stack.enter_context(open_client(settings))
            identity, _ = account(client, email=f"p4bpg-{run}-{label}@example.com")
            clients.append(client)
            owners.append(UUID(identity["id"]))
        assert owners[0] != owners[1]
        yield engine, settings, clients, owners, spy


def owner_memory_counts(engine, owner):
    with engine.connect() as db:
        return {
            model.__tablename__: db.scalar(
                select(func.count()).select_from(model).where(model.owner_id == owner)
            )
            for model in (Memory, MemoryConsentEvent, MemorySource, MemoryGenerationRef)
        }


def preview_source(client):
    session_id = create_chat_session(client, title="P4BPG explicit message source")["id"]
    accepted = send_chat(client, session_id, content=FACT)
    message_id = accepted["user_message"]["id"]
    response = command(
        client,
        "POST",
        "/previews",
        {
            "session_id": session_id,
            "message_ids": [message_id],
            "expected_preferences_version": preferences(client)["version"],
            "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["persisted"] is False and data["candidates"]
    return session_id, message_id, data


def confirm_source(client, session_id, message_id, preview):
    item = preview["candidates"][0]
    response = command(
        client,
        "POST",
        "/items",
        {
            "title": item["title"],
            "content": item["content"],
            "category": item["category"],
            "expected_preferences_version": preferences(client)["version"],
            "consent": CONSENT,
            "source": {
                "kind": "chat_message",
                "session_id": session_id,
                "message_ids": [message_id],
                "preview_token": preview["preview_token"],
            },
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["item"]


def test_pg_preview_is_ephemeral_and_confirmed_source_reaches_real_graph(p4b_pg, monkeypatch):
    engine, _, (client, _), (owner, _), spy = p4b_pg
    enable(client)
    before = owner_memory_counts(engine, owner)
    source_session, source_message, preview = preview_source(client)
    assert owner_memory_counts(engine, owner) == before
    memory = confirm_source(client, source_session, source_message, preview)
    assert owner_memory_counts(engine, owner)["memories"] == before["memories"] + 1
    observed = []
    runtime = runtime_class()
    original = runtime.retrieve_memory

    async def real_retrieve(runtime_self, state):
        observed.append(1)
        return await original(runtime_self, state)

    monkeypatch.setattr(runtime, "retrieve_memory", real_retrieve)
    _, accepted, path = run_chat(client)
    assert observed == [1] and spy.constructed == spy.closed == 1
    injected = entries(spy.calls[-1][0])
    assert [entry["memory_id"] for entry in injected] == [memory["id"]]
    assert injected[0]["content"] == memory["content"]
    assert injected[0]["source_refs"] == [
        {"kind": "chat_message", "session_id": source_session, "message_id": source_message}
    ]
    provenance = client.get(f"{PREFIX}/items/{memory['id']}/sources")
    assert provenance.status_code == 200
    assert provenance.json()["items"][0]["availability"] == "available"
    public = client.get(path + "/memory-refs")
    assert public.status_code == 200 and public.json()["items"] == [
        {
            "memory_id": memory["id"],
            "memory_version": memory["version"],
            "availability": "available",
        }
    ]
    assert FACT not in public.text
    assert len(references(engine, accepted["generation"]["id"])) == 1


def test_pg_two_accounts_cannot_mix_sources_inputs_or_generation_refs(p4b_pg):
    engine, _, (first, second), _, spy = p4b_pg
    enable(first)
    source_session, source_message, preview = preview_source(first)
    memory_a = confirm_source(first, source_session, source_message, preview)
    _, accepted_a, path_a = run_chat(first)
    enable(second)
    memory_b = create_item(second, content=OTHER_FACT)
    _, accepted_b, _ = run_chat(second)
    assert [entry["memory_id"] for entry in entries(spy.calls[-1][0])] == [memory_b["id"]]
    assert FACT not in repr(spy.calls[-1])
    assert second.get(path_a + "/memory-refs").status_code == 404
    assert second.get(f"{PREFIX}/items/{memory_a['id']}/sources").status_code == 404
    mixed = command(
        second,
        "POST",
        "/previews",
        {
            "session_id": source_session,
            "message_ids": [source_message],
            "expected_preferences_version": preferences(second)["version"],
            "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
        },
    )
    assert mixed.status_code == 404
    assert {
        str(ref["memory_id"]) for ref in references(engine, accepted_a["generation"]["id"])
    } == {memory_a["id"]}
    assert {
        str(ref["memory_id"]) for ref in references(engine, accepted_b["generation"]["id"])
    } == {memory_b["id"]}


@pytest.mark.parametrize("action", ["delete", "disable", "expiry"])
def test_pg_privacy_change_prevents_injection_and_old_fact_repetition(p4b_pg, action):
    engine, _, (client, _), (owner, _), spy = p4b_pg
    enable(client)
    memory = create_item(client, content=FACT)
    spy.reply = "【Mock 测试】此前合成转述：" + FACT
    session_id, _, _ = run_chat(client)
    if action == "delete":
        changed = command(
            client, "DELETE", f"/items/{memory['id']}", {"expected_version": memory["version"]}
        )
        assert changed.status_code == 204
    elif action == "disable":
        changed = command(
            client,
            "PATCH",
            "/preferences",
            {"long_term_memory_enabled": False, "expected_version": preferences(client)["version"]},
        )
        assert changed.status_code == 200
    else:
        with engine.begin() as db:
            db.execute(
                update(Memory)
                .where(Memory.id == UUID(memory["id"]), Memory.owner_id == owner)
                .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
            )
    spy.reply = "【Mock 测试】后续合成回复。"
    _, accepted, _ = run_chat(client, session_id=session_id)
    assert entries(spy.calls[-1][0]) == []
    assert FACT not in repr(spy.calls[-1])
    assert spy.calls[-1][0] == [{"role": "user", "content": QUERY}]
    assert references(engine, accepted["generation"]["id"]) == []
    with engine.connect() as db:
        pref = db.execute(
            select(MemoryPreferences.privacy_epoch, MemoryPreferences.context_epoch_floor).where(
                MemoryPreferences.user_id == owner
            )
        ).one()
        assert pref.privacy_epoch == pref.context_epoch_floor and pref.privacy_epoch > 0


def test_pg_sse_replay_does_not_retrieve_preview_save_or_dispatch_again(p4b_pg, monkeypatch):
    engine, _, (client, _), (owner, _), spy = p4b_pg
    enable(client)
    session, message, preview = preview_source(client)
    confirm_source(client, session, message, preview)
    runtime = runtime_class()
    original = runtime.retrieve_memory
    retrieved = []

    async def observed(runtime_self, state):
        retrieved.append(1)
        return await original(runtime_self, state)

    monkeypatch.setattr(runtime, "retrieve_memory", observed)
    _, _, path = run_chat(client)
    before = owner_memory_counts(engine, owner)
    body = client.get(path + "/events")
    assert body.status_code == 200 and "event: completed" in body.text
    cursor = next(line[4:] for line in body.text.splitlines() if line.startswith("id: "))
    replay = client.get(path + "/events", headers={"Last-Event-ID": cursor})
    assert replay.status_code == 200 and "event: completed" in replay.text
    assert f"id: {cursor}\n" not in replay.text
    assert retrieved == [1] and spy.constructed == 1
    assert owner_memory_counts(engine, owner) == before


def test_pg_budget_refs_match_the_exact_spy_input_and_skip_oversized_fact(p4b_pg):
    engine, _, (client, _), _, spy = p4b_pg
    enable(client)
    memory = create_item(client, content=FACT)
    too_large = "后端岗位实践目标。" * 90
    long_memory = create_item(client, content=too_large)
    _, accepted, _ = run_chat(client)
    messages, system = spy.calls[-1]
    assert [entry["memory_id"] for entry in entries(messages)] == [memory["id"]]
    assert too_large not in repr(spy.calls[-1])
    refs = references(engine, accepted["generation"]["id"])
    assert len(refs) == 1 and refs[0]["counter_version"] == "mock-token-v1"
    assert sum(ref["used_tokens"] for ref in refs) == sum(
        mock_count_messages([block]) for block, _ in memory_blocks(messages)
    )
    assert mock_count_messages(messages, system_prompt=system) + 512 + 256 <= 32768
    assert client.get(f"{PREFIX}/items/{long_memory['id']}").json()["content"] == too_large
    with engine.connect() as db:
        assert (
            db.scalar(
                select(ChatGeneration.__table__.c.memory_snapshot_at).where(
                    ChatGeneration.id == UUID(accepted["generation"]["id"])
                )
            )
            is not None
        )


def test_pg_feature_off_preserves_p3_chat_and_unknown_provider_is_not_accepted(p4b_pg):
    engine, settings, (client, _), _, spy = p4b_pg
    enable(client)
    create_item(client, content=FACT)
    with pytest.raises(ValidationError):
        Settings(**(settings.model_dump() | {"llm_provider": "unknown"}))
    disabled = Settings(**(settings.model_dump() | {"memory_injection_enabled": False}))
    cookies = type(client.cookies)(client.cookies)
    with open_client(disabled) as plain:
        plain.cookies.update(cookies)
        _, accepted, _ = run_chat(plain)
        assert entries(spy.calls[-1][0]) == [] and FACT not in repr(spy.calls[-1])
        assert references(engine, accepted["generation"]["id"]) == []


@pytest.mark.parametrize("action", ["delete", "revoke", "disable"])
def test_pg_injection_off_cannot_dispatch_stale_history_after_cross_app_privacy_commit(
    p4b_pg, monkeypatch, action
):
    engine, settings, (privacy, _), _, spy = p4b_pg
    enable(privacy)
    disabled = Settings(**(settings.model_dump() | {"memory_injection_enabled": False}))
    cookies = type(privacy.cookies)(privacy.cookies)
    with open_client(disabled) as worker:
        worker.cookies.update(cookies)
        session_id, _, _ = run_chat(worker, content=FACT)
        memory = create_item(privacy, content=FACT)
        accepted = send_chat(worker, session_id, content=QUERY)
        generation_id = UUID(accepted["generation"]["id"])
        loaded, release = Event(), Event()
        original_load = ChatRunner._load_context
        prior_calls = spy.constructed
        assert prior_calls == 1

        async def pause_after_context(runner, claim):
            messages = await original_load(runner, claim)
            if runner is worker.app.state.chat_runner:
                assert FACT in repr(messages) and entries(messages) == []
                loaded.set()
                assert await asyncio.to_thread(release.wait, 30)
            return messages

        async def hold_renewal(*_args):
            # The final dispatch guard must work without the periodic lease poll.
            await asyncio.Event().wait()

        monkeypatch.setattr(ChatRunner, "_load_context", pause_after_context)
        monkeypatch.setattr(worker.app.state.chat_runner, "_renew", hold_renewal)
        with ThreadPoolExecutor(max_workers=1) as threads:
            work = threads.submit(worker.portal.call, worker.app.state.chat_runner.run_once)
            try:
                assert loaded.wait(30), "Worker never loaded the ordinary historical context"
                assert generation_id not in privacy.app.state.chat_runner._active
                if action == "disable":
                    response = command(
                        privacy,
                        "PATCH",
                        "/preferences",
                        {
                            "long_term_memory_enabled": False,
                            "expected_version": preferences(privacy)["version"],
                        },
                    )
                else:
                    response = command(
                        privacy,
                        "DELETE" if action == "delete" else "POST",
                        f"/items/{memory['id']}" + ("/revocations" if action == "revoke" else ""),
                        {"expected_version": memory["version"]},
                    )
                assert response.status_code == (204 if action == "delete" else 200)
                # The separate application's committed privacy barrier precedes dispatch.
                release.set()
                assert work.result(timeout=30)
            finally:
                release.set()
        assert spy.constructed == prior_calls and spy.closed == prior_calls
        assert references(engine, str(generation_id)) == []
        with engine.connect() as db:
            journal = db.execute(
                select(ChatGenerationEvent.event_type, ChatGenerationEvent.payload)
                .where(ChatGenerationEvent.generation_id == generation_id)
                .order_by(ChatGenerationEvent.event_sequence)
            ).all()
            assert [row[0] for row in journal] == ["start", "cancelled"]
            assert journal[-1][1]["reason"] == "memory_policy_changed"
            assistant = db.execute(
                select(ChatMessage.content, ChatMessage.status).where(
                    ChatMessage.id == UUID(accepted["assistant_message"]["id"])
                )
            ).one()
            assert tuple(assistant) == ("", "cancelled")


@pytest.mark.parametrize("action", ["delete", "source_delete"])
def test_pg_retrieved_memory_cannot_dispatch_after_blocking_privacy_commit(
    p4b_pg, monkeypatch, action
):
    engine, settings, (client, _), (owner, _), spy = p4b_pg
    enable(client)
    source_session, source_message, preview = preview_source(client)
    memory = confirm_source(client, source_session, source_message, preview)
    target = create_chat_session(client, title="P4BPG separate target session")["id"]
    accepted = send_chat(client, target, content=QUERY)
    generation_id = UUID(accepted["generation"]["id"])
    reached_guard, release_guard, privacy_holds, release_privacy, guard_requested_lock = (
        Event() for _ in range(5)
    )
    backends = {}
    runtime = runtime_class()
    original_guard = runtime.before_provider
    original_advance = MemoryService.advance
    original_lock_user = ChatService.lock_user

    async def paused_guard(runtime_self, state):
        assert [hit.candidate.id for hit in state["memory_budget"].selected_hits] == [
            UUID(memory["id"])
        ]
        assert spy.constructed == 0
        reached_guard.set()
        assert await asyncio.to_thread(release_guard.wait, 30)
        return await original_guard(runtime_self, state)

    async def pause_with_owner_lock(db):
        backends["privacy"] = await db.scalar(text("SELECT pg_backend_pid()"))
        privacy_holds.set()
        assert await asyncio.to_thread(release_privacy.wait, 30)

    async def paused_advance(service, db, preference, *, removal=False):
        if action == "delete" and service.owner == owner and removal:
            await pause_with_owner_lock(db)
        return await original_advance(service, db, preference, removal=removal)

    async def paused_source_lock(service, db):
        value = await original_lock_user(service, db)
        if (
            action == "source_delete"
            and service.owner == owner
            and service.request.method == "DELETE"
        ):
            await pause_with_owner_lock(db)
        return value

    monkeypatch.setattr(runtime, "before_provider", paused_guard)
    monkeypatch.setattr(MemoryService, "advance", paused_advance)
    monkeypatch.setattr(ChatService, "lock_user", paused_source_lock)

    def observe_guard_lock(connection, _cursor, statement, _parameters, _context, _many):
        task = asyncio.current_task()
        if task and task.get_name() == "private-chat-lease":
            return
        normalized = " ".join(statement.lower().replace('"', "").split())
        if " from users " in normalized and "for update" in normalized:
            backends["guard"] = connection.connection.driver_connection.info.backend_pid
            guard_requested_lock.set()

    worker_engine = client.app.state.engine.sync_engine
    cookies = type(client.cookies)(client.cookies)

    def privacy_command():
        with open_client(settings) as other:
            other.cookies.update(cookies)
            if action == "delete":
                return command(
                    other,
                    "DELETE",
                    f"/items/{memory['id']}",
                    {"expected_version": memory["version"]},
                )
            return other.delete(CHAT + f"/sessions/{source_session}", headers=csrf(other))

    try:
        with ThreadPoolExecutor(max_workers=2) as threads:
            work = threads.submit(client.portal.call, client.app.state.chat_runner.run_once)
            try:
                assert reached_guard.wait(30), "Real graph never reached the dispatch guard"
                privacy = threads.submit(privacy_command)
                assert privacy_holds.wait(30), "Privacy command did not acquire owner locks"
                event.listen(worker_engine, "before_cursor_execute", observe_guard_lock)
                release_guard.set()
                assert guard_requested_lock.wait(30), "Dispatch never requested User FOR UPDATE"
                blocked = False
                deadline = monotonic() + 20
                with engine.connect() as probe:
                    probe.execute(text("SET TRANSACTION READ ONLY"))
                    while monotonic() < deadline:
                        pids = probe.scalar(
                            text("SELECT pg_blocking_pids(:pid)"), {"pid": backends["guard"]}
                        )
                        if backends["privacy"] in pids:
                            blocked = True
                            break
                assert blocked, "Dispatch was not actually blocked by the privacy transaction"
                release_privacy.set()
                assert privacy.result(timeout=30).status_code == 204
                assert work.result(timeout=30)
            finally:
                release_guard.set()
                release_privacy.set()
    finally:
        if event.contains(worker_engine, "before_cursor_execute", observe_guard_lock):
            event.remove(worker_engine, "before_cursor_execute", observe_guard_lock)
        release_guard.set()
        release_privacy.set()
    assert spy.constructed == 0 and references(engine, str(generation_id)) == []
    with engine.connect() as db:
        assert (
            db.scalar(
                select(ChatGeneration.state).where(
                    ChatGeneration.id == generation_id, ChatGeneration.owner_id == owner
                )
            )
            == "cancelled"
        )
        journal = db.execute(
            select(ChatGenerationEvent.event_type, ChatGenerationEvent.payload)
            .where(ChatGenerationEvent.generation_id == generation_id)
            .order_by(ChatGenerationEvent.event_sequence)
        ).all()
        assert [row[0] for row in journal] == ["start", "cancelled"]
        assert journal[-1][1]["reason"] == "memory_policy_changed"
        assistant = db.execute(
            select(ChatMessage.content, ChatMessage.status).where(
                ChatMessage.id == UUID(accepted["assistant_message"]["id"])
            )
        ).one()
        assert tuple(assistant) == ("", "cancelled")
    if action == "source_delete":
        state = client.get(f"{PREFIX}/items/{memory['id']}")
        assert state.status_code == 200 and state.json()["status"] == "revoked"
        sources = client.get(f"{PREFIX}/items/{memory['id']}/sources")
        assert sources.json()["items"][0]["availability"] == "source_deleted"
