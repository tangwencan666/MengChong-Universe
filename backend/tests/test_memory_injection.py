"""Real isolated SQLite/API/worker memory injection with an observing Mock provider.

Only the provider is replaced. Consent, sources, retrieval, graph hooks, budgeting,
reference persistence, chat commands, and replay execute the application code.
"""

import asyncio
import importlib
import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from threading import Event
from uuid import UUID

import pytest
from auth_helpers import csrf
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import func, select, update
from test_chat import create_session as create_chat_session
from test_chat import generation_path, run_one
from test_chat import send as send_chat
from test_memory_api import (
    CONSENT,
    PREFIX,
    account,
    command,
    correction_payload,
    create_item,
    enable,
    preferences,
)

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.memory.budget import mock_count_messages
from app.modules.memory.models import (
    Memory,
    MemoryConsentEvent,
    MemoryGenerationRef,
    MemoryPreferences,
    MemorySource,
)

CHAT = "/api/v1/companion"
FACT = "求职目标是后端研发，优先关注星河团队。"
OTHER_FACT = "求职目标是后端研发，优先关注青岚团队。"
QUERY = "想聊聊后端求职准备。"
TEST_KEY = "p4b-injection-tests-only-hmac-key-not-for-production"


class InjectionSpy:
    """Capture the exact provider boundary, without inferring any model understanding."""

    name = "mock"

    def __init__(self):
        self.calls = []
        self.reply = "【Mock 测试】合成回复。"
        self.constructed = 0
        self.closed = 0

    def stream(self, messages, system_prompt):
        self.constructed += 1
        self.calls.append((deepcopy(messages), system_prompt))
        reply = self.reply

        async def output():
            try:
                yield reply
                await asyncio.sleep(0)
            finally:
                self.closed += 1

        return output()


@contextmanager
def open_client(settings):
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        yield client


@pytest.fixture
def injection_context(auth_database, monkeypatch):
    engine, base = auth_database
    settings = Settings(
        **(
            base.model_dump()
            | {
                "memory_management_enabled": True,
                "memory_injection_enabled": True,
                "memory_hmac_key": SecretStr(TEST_KEY),
                "chat_runner_enabled": False,
                "llm_provider": "mock",
                "real_llm_enabled": False,
            }
        )
    )
    spy = InjectionSpy()
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: spy)
    with open_client(settings) as client:
        yield engine, settings, client, spy


def runtime_class():
    return importlib.import_module("app.modules.memory.injection").GenerationMemoryRuntime


def memory_blocks(messages):
    blocks = []
    for message in messages:
        try:
            data = json.loads(message["content"])
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict) and data.get("type") == "authorized_memory_data":
            assert message["role"] == "user"
            blocks.append((message, data))
    return blocks


def entries(messages):
    return [item for _, block in memory_blocks(messages) for item in block["items"]]


def run_chat(client, content=QUERY, *, session_id=None):
    session_id = session_id or create_chat_session(client)["id"]
    accepted = send_chat(client, session_id, content=content)
    run_one(client)
    path = CHAT + generation_path(session_id, accepted["generation"]["id"])
    snapshot = client.get(path)
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["generation"]["state"] == "completed", snapshot.text
    return session_id, accepted, path


def references(engine, generation_id):
    with engine.connect() as db:
        return list(
            db.execute(
                select(MemoryGenerationRef.__table__)
                .where(MemoryGenerationRef.generation_id == UUID(generation_id))
                .order_by(MemoryGenerationRef.rank)
            ).mappings()
        )


def memory_counts(engine):
    with engine.connect() as db:
        return {
            model.__tablename__: db.scalar(select(func.count()).select_from(model))
            for model in (Memory, MemoryConsentEvent, MemorySource, MemoryGenerationRef)
        }


def source_memory(client):
    source_session = create_chat_session(client, title="明确选择的消息来源")["id"]
    accepted = send_chat(client, source_session, content=FACT)
    selected = [accepted["user_message"]["id"]]
    preview = command(
        client,
        "POST",
        "/previews",
        {
            "session_id": source_session,
            "message_ids": selected,
            "expected_preferences_version": preferences(client)["version"],
            "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
        },
    )
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data["persisted"] is False and data["candidates"]
    candidate = data["candidates"][0]
    saved = command(
        client,
        "POST",
        "/items",
        {
            "title": candidate["title"],
            "content": candidate["content"],
            "category": candidate["category"],
            "expected_preferences_version": preferences(client)["version"],
            "consent": CONSENT,
            "source": {
                "kind": "chat_message",
                "session_id": source_session,
                "message_ids": selected,
                "preview_token": data["preview_token"],
            },
        },
    )
    assert saved.status_code == 201, saved.text
    return source_session, saved.json()["item"]


def test_default_disabled_policy_does_not_create_or_inject_memory(injection_context):
    engine, _, client, spy = injection_context
    account(client)
    assert not preferences(client)["long_term_memory_enabled"]
    before = memory_counts(engine)
    _, accepted, _ = run_chat(client)
    assert entries(spy.calls[-1][0]) == []
    assert memory_counts(engine) == before
    assert references(engine, accepted["generation"]["id"]) == []
    with engine.connect() as db:
        assert db.scalar(select(func.count()).select_from(MemoryPreferences)) == 0


def test_recent_topic_consent_alone_cannot_enable_memory(injection_context):
    engine, _, client, spy = injection_context
    identity, _ = account(client)
    response = client.patch(
        CHAT + "/preferences",
        json={
            "recent_topic_enabled": True,
            "expected_version": 0,
        },
        headers=csrf(client),
    )
    assert response.status_code == 200
    with engine.begin() as db:
        db.execute(
            Memory.__table__.insert().values(
                owner_id=UUID(identity["id"]),
                content=FACT,
                consent_granted_at=datetime.now(UTC),
            )
        )
    _, accepted, _ = run_chat(client)
    assert entries(spy.calls[-1][0]) == []
    assert FACT not in json.dumps(spy.calls[-1], ensure_ascii=False)
    assert not preferences(client)["long_term_memory_enabled"]
    assert references(engine, accepted["generation"]["id"]) == []


def test_spy_sees_confirmed_memory_and_refs_describe_exact_budgeted_input(injection_context):
    engine, _, client, spy = injection_context
    account(client)
    enable(client)
    item = create_item(client, content=FACT)
    _, accepted, path = run_chat(client)
    assert spy.constructed == spy.closed == 1
    messages, prompt = spy.calls[-1]
    injected = entries(messages)
    assert [entry["memory_id"] for entry in injected] == [item["id"]]
    assert injected[0]["version"] == item["version"]
    assert injected[0]["content"] == FACT and injected[0]["source_refs"]
    assert FACT not in prompt
    assert messages[-1] == {"role": "user", "content": QUERY}
    assert all(message["role"] in {"user", "assistant"} for message in messages)
    refs = references(engine, accepted["generation"]["id"])
    assert len(refs) == 1 and str(refs[0]["memory_id"]) == item["id"]
    assert refs[0]["memory_version"] == item["version"]
    assert refs[0]["counter_version"] == "mock-token-v1" and refs[0]["used_tokens"] > 0
    assert sum(row["used_tokens"] for row in refs) == sum(
        mock_count_messages([block]) for block, _ in memory_blocks(messages)
    )
    assert FACT not in repr(refs)
    public_refs = client.get(path + "/memory-refs")
    assert public_refs.status_code == 200
    assert public_refs.json()["items"] == [
        {
            "memory_id": item["id"],
            "memory_version": item["version"],
            "availability": "available",
        }
    ]
    assert FACT not in public_refs.text


def test_sse_replay_never_retrieves_saves_or_calls_provider_again(injection_context, monkeypatch):
    engine, _, client, spy = injection_context
    runtime = runtime_class()
    original = runtime.retrieve_memory
    calls = []

    async def observed(runtime_self, state):
        calls.append(1)
        return await original(runtime_self, state)

    monkeypatch.setattr(runtime, "retrieve_memory", observed)
    account(client)
    enable(client)
    create_item(client, content=FACT)
    _, _, path = run_chat(client)
    before = memory_counts(engine)
    response = client.get(path + "/events")
    assert response.status_code == 200 and "event: completed" in response.text
    first_id = next(line[4:] for line in response.text.splitlines() if line.startswith("id: "))
    replay = client.get(path + "/events", headers={"Last-Event-ID": first_id})
    assert replay.status_code == 200 and "event: completed" in replay.text
    assert f"id: {first_id}\n" not in replay.text
    assert len(calls) == spy.constructed == 1
    assert memory_counts(engine) == before


def test_distinct_accounts_have_distinct_actual_provider_inputs_and_refs(injection_context):
    engine, settings, client, spy = injection_context
    account(client, email="injection-a@example.com")
    enable(client)
    first = create_item(client, content=FACT)
    _, accepted_a, path_a = run_chat(client)
    with open_client(settings) as other:
        account(other, email="injection-b@example.com")
        enable(other)
        second = create_item(other, content=OTHER_FACT)
        _, accepted_b, _ = run_chat(other)
        assert [entry["memory_id"] for entry in entries(spy.calls[-1][0])] == [second["id"]]
        assert FACT not in json.dumps(spy.calls[-1], ensure_ascii=False)
        assert other.get(path_a + "/memory-refs").status_code == 404
        assert {
            str(row["memory_id"]) for row in references(engine, accepted_b["generation"]["id"])
        } == {second["id"]}
    assert {
        str(row["memory_id"]) for row in references(engine, accepted_a["generation"]["id"])
    } == {first["id"]}


def test_correction_injects_new_version_without_reusing_old_fact(injection_context):
    engine, _, client, spy = injection_context
    account(client)
    enable(client)
    item = create_item(client, content=FACT)
    session_id, _, _ = run_chat(client)
    edited = command(
        client,
        "PATCH",
        f"/items/{item['id']}",
        correction_payload(client, item, content=OTHER_FACT),
    )
    assert edited.status_code == 200
    _, accepted, _ = run_chat(client, session_id=session_id)
    injected = entries(spy.calls[-1][0])
    assert [entry["content"] for entry in injected] == [OTHER_FACT]
    assert FACT not in json.dumps(spy.calls[-1], ensure_ascii=False)
    assert (
        references(engine, accepted["generation"]["id"])[0]["memory_version"]
        == edited.json()["version"]
    )


@pytest.mark.parametrize("action", ["delete", "revoke", "disable"])
def test_privacy_change_blocks_injection_and_old_assistant_repetition(injection_context, action):
    engine, _, client, spy = injection_context
    account(client)
    enable(client)
    item = create_item(client, content=FACT)
    spy.reply = "【Mock 测试】上一轮合成转述：" + FACT
    session_id, _, path = run_chat(client)
    if action == "delete":
        response = command(
            client, "DELETE", f"/items/{item['id']}", {"expected_version": item["version"]}
        )
        assert response.status_code == 204
    elif action == "revoke":
        response = command(
            client,
            "POST",
            f"/items/{item['id']}/revocations",
            {"expected_version": item["version"]},
        )
        assert response.status_code == 200
    else:
        response = command(
            client,
            "PATCH",
            "/preferences",
            {
                "long_term_memory_enabled": False,
                "expected_version": preferences(client)["version"],
            },
        )
        assert response.status_code == 200
    spy.reply = "【Mock 测试】后续合成回复。"
    _, accepted, _ = run_chat(client, session_id=session_id)
    assert entries(spy.calls[-1][0]) == []
    assert FACT not in json.dumps(spy.calls[-1], ensure_ascii=False)
    assert spy.calls[-1][0] == [{"role": "user", "content": QUERY}]
    assert references(engine, accepted["generation"]["id"]) == []
    if action == "delete":
        public_refs = client.get(path + "/memory-refs")
        assert public_refs.status_code == 200
        assert public_refs.json()["items"][0]["availability"] == "unavailable"
        assert FACT not in public_refs.text


def test_expiry_between_acceptance_and_execution_cancels_old_snapshot(injection_context):
    engine, _, client, spy = injection_context
    account(client)
    enable(client)
    item = create_item(client, content=FACT)
    session_id = create_chat_session(client)["id"]
    accepted = send_chat(client, session_id, content=QUERY)
    with engine.begin() as db:
        db.execute(
            update(Memory)
            .where(Memory.id == UUID(item["id"]))
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    client.portal.call(client.app.state.chat_runner.run_once)
    snapshot = client.get(CHAT + generation_path(session_id, accepted["generation"]["id"]))
    assert snapshot.status_code == 200 and snapshot.json()["generation"]["state"] == "cancelled"
    assert spy.constructed == 0
    assert client.get(f"{PREFIX}/items/{item['id']}").json()["status"] == "expired"
    _, later, _ = run_chat(client, session_id=session_id)
    assert entries(spy.calls[-1][0]) == []
    assert references(engine, later["generation"]["id"]) == []


def test_deleted_source_in_another_session_cancels_queued_injection(injection_context):
    engine, _, client, spy = injection_context
    account(client)
    enable(client)
    source_session, item = source_memory(client)
    target_session = create_chat_session(client, title="另一个聊天窗口")["id"]
    accepted = send_chat(client, target_session, content=QUERY)
    deleted = client.delete(CHAT + f"/sessions/{source_session}", headers=csrf(client))
    assert deleted.status_code == 204
    client.portal.call(client.app.state.chat_runner.run_once)
    snapshot = client.get(CHAT + generation_path(target_session, accepted["generation"]["id"]))
    assert snapshot.status_code == 200 and snapshot.json()["generation"]["state"] == "cancelled"
    assert spy.constructed == 0
    detail = client.get(f"{PREFIX}/items/{item['id']}")
    assert detail.status_code == 200 and detail.json()["status"] == "revoked"
    source = client.get(f"{PREFIX}/items/{item['id']}/sources")
    assert source.status_code == 200
    assert source.json()["items"][0]["availability"] == "source_deleted"
    assert references(engine, accepted["generation"]["id"]) == []


def test_an_over_budget_fact_is_skipped_whole_not_truncated_into_input(injection_context):
    engine, _, client, spy = injection_context
    account(client)
    enable(client)
    content = "后端岗位实践目标。" * 90
    item = create_item(client, content=content)
    _, accepted, _ = run_chat(client)
    assert entries(spy.calls[-1][0]) == []
    assert content not in json.dumps(spy.calls[-1], ensure_ascii=False)
    assert references(engine, accepted["generation"]["id"]) == []
    assert client.get(f"{PREFIX}/items/{item['id']}").json()["content"] == content


def test_actual_input_budget_drops_only_complete_oldest_pairs(injection_context):
    _, _, client, spy = injection_context
    account(client)
    enable(client)
    create_item(client, content=FACT)
    session_id = create_chat_session(client)["id"]
    old_replies = []
    for index in range(4):
        reply = f"【Mock 测试】HISTORY_{index}:" + "旧轮次资料。" * 500
        old_replies.append(reply)
        spy.reply = reply
        run_chat(client, content=f"后端岗位准备第{index}轮。", session_id=session_id)
    spy.reply = "【Mock 测试】预算后的合成回复。"
    run_chat(client, content=QUERY, session_id=session_id)
    messages, prompt = spy.calls[-1]
    assert mock_count_messages(messages, system_prompt=prompt) + 512 + 256 <= 32768
    assert old_replies[0] not in [message["content"] for message in messages]
    assert old_replies[-1] in [message["content"] for message in messages]
    ordinary = [message for message in messages if not memory_blocks([message])]
    assert ordinary[-1] == {"role": "user", "content": QUERY}
    assert len(ordinary) % 2 == 1
    assert all(
        message["role"] == ("user" if index % 2 == 0 else "assistant")
        for index, message in enumerate(ordinary)
    )


@pytest.mark.parametrize("action", ["delete", "disable"])
def test_privacy_change_at_final_provider_guard_prevents_dispatch(
    injection_context, monkeypatch, action
):
    engine, settings, client, spy = injection_context
    account(client)
    enable(client)
    item = create_item(client, content=FACT)
    session_id = create_chat_session(client)["id"]
    accepted = send_chat(client, session_id, content=QUERY)
    runtime = runtime_class()
    original = runtime.before_provider
    reached, release = Event(), Event()

    async def paused(runtime_self, state):
        reached.set()
        assert await asyncio.to_thread(release.wait, 15)
        return await original(runtime_self, state)

    monkeypatch.setattr(runtime, "before_provider", paused)
    captured_cookies = type(client.cookies)(client.cookies)
    with ThreadPoolExecutor(max_workers=1) as workers:
        future = workers.submit(client.portal.call, client.app.state.chat_runner.run_once)
        try:
            assert reached.wait(15), "Worker never reached the final provider guard"
            with open_client(settings) as other:
                other.cookies.update(captured_cookies)
                if action == "delete":
                    response = command(
                        other,
                        "DELETE",
                        f"/items/{item['id']}",
                        {"expected_version": item["version"]},
                    )
                    assert response.status_code == 204
                else:
                    response = command(
                        other,
                        "PATCH",
                        "/preferences",
                        {
                            "long_term_memory_enabled": False,
                            "expected_version": preferences(other)["version"],
                        },
                    )
                    assert response.status_code == 200
        finally:
            release.set()
        assert future.result(timeout=15)
    assert spy.constructed == 0 and references(engine, accepted["generation"]["id"]) == []
    with engine.connect() as db:
        assert (
            db.scalar(
                select(ChatGeneration.state).where(
                    ChatGeneration.id == UUID(accepted["generation"]["id"])
                )
            )
            == "cancelled"
        )
        types = list(
            db.scalars(
                select(ChatGenerationEvent.event_type)
                .where(ChatGenerationEvent.generation_id == UUID(accepted["generation"]["id"]))
                .order_by(ChatGenerationEvent.event_sequence)
            )
        )
        assert types == ["start", "cancelled"]
        assistant = db.execute(
            select(ChatMessage.content, ChatMessage.status).where(
                ChatMessage.id == UUID(accepted["assistant_message"]["id"])
            )
        ).one()
        assert tuple(assistant) == ("", "cancelled")


@pytest.mark.parametrize("action", ["delete", "revoke", "disable"])
def test_injection_disabled_still_rechecks_privacy_after_loading_history(
    injection_context, monkeypatch, action
):
    engine, configured, _, spy = injection_context
    settings = Settings(
        **(
            configured.model_dump()
            | {
                "memory_injection_enabled": False,
                "chat_lease_seconds": 60,
                "chat_renew_seconds": 10,
            }
        )
    )
    with open_client(settings) as client:
        account(client)
        enable(client)
        item = create_item(client, content=FACT)
        session_id, _, _ = run_chat(client, content=FACT)
        before_dispatches = spy.constructed
        accepted = send_chat(client, session_id, content=QUERY)
        runner = client.app.state.chat_runner
        original_load = runner._load_context
        reached, release = Event(), Event()

        async def loaded_then_paused(claim):
            messages = await original_load(claim)
            assert FACT in [message["content"] for message in messages[:-1]]
            reached.set()
            assert await asyncio.to_thread(release.wait, 15)
            return messages

        async def hold_renewal(*_args):
            # Exercise the final dispatch fence itself, independently from the
            # periodic renewal task noticing a cross-process privacy commit.
            await asyncio.Event().wait()

        monkeypatch.setattr(runner, "_load_context", loaded_then_paused)
        monkeypatch.setattr(runner, "_renew", hold_renewal)
        cookies = type(client.cookies)(client.cookies)
        with ThreadPoolExecutor(max_workers=1) as workers:
            future = workers.submit(client.portal.call, runner.run_once)
            try:
                assert reached.wait(15), "Worker never loaded the pre-revocation history"
                with open_client(settings) as other:
                    other.cookies.update(cookies)
                    assert not other.app.state.chat_runner._active
                    if action == "disable":
                        changed = command(
                            other,
                            "PATCH",
                            "/preferences",
                            {
                                "long_term_memory_enabled": False,
                                "expected_version": preferences(other)["version"],
                            },
                        )
                        assert changed.status_code == 200
                    else:
                        changed = command(
                            other,
                            "DELETE" if action == "delete" else "POST",
                            f"/items/{item['id']}" + ("/revocations" if action == "revoke" else ""),
                            {"expected_version": item["version"]},
                        )
                        assert changed.status_code == (204 if action == "delete" else 200)
            finally:
                release.set()
            assert future.result(timeout=15)
        assert spy.constructed == before_dispatches
        assert spy.calls[before_dispatches:] == []
        assert references(engine, accepted["generation"]["id"]) == []
        with engine.connect() as db:
            journal = db.execute(
                select(ChatGenerationEvent.event_type, ChatGenerationEvent.payload)
                .where(ChatGenerationEvent.generation_id == UUID(accepted["generation"]["id"]))
                .order_by(ChatGenerationEvent.event_sequence)
            ).all()
            assert [event[0] for event in journal] == ["start", "cancelled"]
            assert journal[-1][1]["reason"] == "memory_policy_changed"
            assistant = db.execute(
                select(ChatMessage.content, ChatMessage.status).where(
                    ChatMessage.id == UUID(accepted["assistant_message"]["id"])
                )
            ).one()
            assert tuple(assistant) == ("", "cancelled")
