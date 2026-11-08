"""Finite pet SSE replay, terminal-event and active-provider cancellation checks."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, update
from test_chat_stream import parse_frames
from test_pet_chat import Spy, account, cmd, pet, send, session
from test_pet_chat import pet_client as pet_client

from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.pets.models import PetChatBinding


def generation_path(pet_id, session_id, generation_id):
    return f"/pets/{pet_id}/sessions/{session_id}/generations/{generation_id}"


def test_pet_sse_replay_is_exclusive_and_does_not_recreate_messages(pet_client, monkeypatch):
    client, engine = pet_client
    spy = Spy()
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: spy)
    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    assert client.portal.call(client.app.state.chat_runner.run_once)
    path = "/api/v1" + generation_path(one["pet_id"], chat["id"], accepted["generation"]["id"])
    response = client.get(path + "/events")
    assert response.status_code == 200, response.text
    frames = parse_frames(response.text)
    assert [frame["event"] for frame in frames] == ["start", "delta", "completed"]
    for index, frame in enumerate(frames, 1):
        assert frame["id"] == accepted["generation"]["id"] + ":" + str(index)
        assert frame["data"]["pet_id"] == one["pet_id"]
        assert frame["data"]["sequence"] == index
        resumed = client.get(path + "/events", headers={"Last-Event-ID": frame["id"]})
        assert [part["id"] for part in parse_frames(resumed.text)] == [
            part["id"] for part in frames[index:]
        ]
    assert len(spy.calls) == spy.closed == 1
    with engine.connect() as db:
        assert db.scalar(select(func.count()).select_from(ChatMessage)) == 2
        assert db.scalar(select(func.count()).select_from(ChatGeneration)) == 1
        assert db.scalar(select(func.count()).select_from(ChatGenerationEvent)) == 3


@pytest.mark.parametrize("terminal", ["error", "cancelled"])
def test_terminal_events_always_include_the_pet(pet_client, monkeypatch, terminal):
    client, _ = pet_client

    class Failing:
        name = "mock"

        async def stream(self, messages, prompt):
            raise RuntimeError("private-provider-error")
            yield "unreachable"

    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: Failing())
    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    path = generation_path(one["pet_id"], chat["id"], accepted["generation"]["id"])
    if terminal == "cancelled":
        assert cmd(client, "POST", path + "/cancel", {}).status_code == 200
    else:
        assert client.portal.call(client.app.state.chat_runner.run_once)
    response = client.get("/api/v1" + path + "/events")
    frames = parse_frames(response.text)
    assert frames[-1]["event"] == terminal
    assert sum(frame["event"] in ("completed", "error", "cancelled") for frame in frames) == 1
    assert all(frame["data"]["pet_id"] == one["pet_id"] for frame in frames)
    assert "private-provider-error" not in response.text


@pytest.mark.parametrize("action", ["cancel", "delete", "archive", "disabled"])
def test_pet_active_provider_is_closed_and_no_late_delta_can_commit(
    pet_client, monkeypatch, action
):
    client, engine = pet_client
    waiting, committed, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    runner = client.app.state.chat_runner
    original_flush = runner._flush

    async def observe(claim, text):
        await original_flush(claim, text)
        committed.set()

    monkeypatch.setattr(runner, "_flush", observe)

    class Holding:
        name = "mock"

        async def stream(self, messages, prompt):
            try:
                yield "committed fragment " * 40
                waiting.set()
                await asyncio.Event().wait()
                yield "late forbidden fragment"
            finally:
                closed.set()

    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: Holding())

    async def signal(event):
        await asyncio.wait_for(event.wait(), 8)

    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    task = client.portal.start_task_soon(runner.run_once)
    try:
        client.portal.call(signal, waiting)
        client.portal.call(signal, committed)
        path = generation_path(one["pet_id"], chat["id"], accepted["generation"]["id"])
        if action == "cancel":
            assert cmd(client, "POST", path + "/cancel", {}).status_code in (200, 202)
        elif action == "delete":
            assert (
                cmd(client, "DELETE", f"/pets/{one['pet_id']}/sessions/{chat['id']}").status_code
                == 204
            )
        elif action == "disabled":
            from app.modules.users.models import User

            with engine.begin() as db:
                db.execute(update(User).values(status="disabled"))
                assert db.scalar(select(User.status)) == "disabled"
        else:
            assert (
                cmd(
                    client, "POST", f"/pets/{one['pet_id']}/archive", {"expected_version": 1}
                ).status_code
                == 200
            )
        task.result(timeout=10)
        client.portal.call(signal, closed)
        with engine.connect() as db:
            assert (
                db.scalar(
                    select(ChatGeneration.state).where(
                        ChatGeneration.id == UUID(accepted["generation"]["id"])
                    )
                )
                == "cancelled"
            )
            content = db.scalar(
                select(ChatMessage.content).where(
                    ChatMessage.id == UUID(accepted["assistant_message"]["id"])
                )
            )
            assert content == "committed fragment " * 40
            terminal_count = db.scalar(
                select(func.count())
                .select_from(ChatGenerationEvent)
                .where(
                    ChatGenerationEvent.generation_id == UUID(accepted["generation"]["id"]),
                    ChatGenerationEvent.event_type.in_(("completed", "error", "cancelled")),
                )
            )
            assert terminal_count == 1
    finally:
        if not task.done():
            task.cancel()


def test_corrupt_pet_payload_fails_closed_and_releases_stream_slot(pet_client):
    client, engine = pet_client
    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    path = generation_path(one["pet_id"], chat["id"], accepted["generation"]["id"])
    assert cmd(client, "POST", path + "/cancel", {}).status_code == 200
    with engine.begin() as db:
        payload = db.scalar(
            select(ChatGenerationEvent.payload).where(
                ChatGenerationEvent.generation_id == UUID(accepted["generation"]["id"]),
                ChatGenerationEvent.event_sequence == 1,
            )
        )
        payload["pet_id"] = str(uuid4())
        db.execute(
            update(ChatGenerationEvent)
            .where(
                ChatGenerationEvent.generation_id == UUID(accepted["generation"]["id"]),
                ChatGenerationEvent.event_sequence == 1,
            )
            .values(payload=payload)
        )
    frames = parse_frames(client.get("/api/v1" + path + "/events").text)
    assert len(frames) == 1 and frames[0]["data"]["scope"] == "connection"
    assert frames[0]["data"]["error"]["code"] == "STREAM_UNAVAILABLE"
    assert all(not slots for slots in client.app.state.chat_streams.values())


def test_concurrent_identical_pet_send_accepts_only_one_generation(pet_client):
    client, engine = pet_client
    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    key, message_id = str(uuid4()), str(uuid4())
    from auth_helpers import csrf

    headers = csrf(client) | {"Idempotency-Key": key}
    body = {"client_message_id": message_id, "content": "same input"}
    path = f"/api/v1/pets/{one['pet_id']}/sessions/{chat['id']}/messages"

    def request():
        return client.post(path, json=body, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: request(), range(2)))
    assert [response.status_code for response in responses] == [202, 202]
    assert responses[0].json()["generation"]["id"] == responses[1].json()["generation"]["id"]
    assert {response.json()["idempotent_replay"] for response in responses} == {False, True}
    with engine.connect() as db:
        assert db.scalar(select(func.count()).select_from(ChatGeneration)) == 1
        assert db.scalar(select(func.count()).select_from(ChatMessage)) == 2


def test_mismatched_internal_companion_binding_is_inaccessible(pet_client, monkeypatch):
    client, engine = pet_client
    spy = Spy()
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: spy)
    account(client)
    one, other = pet(client), pet(client, "Other")
    chat = session(client, one["pet_id"])
    with engine.begin() as db:
        db.execute(
            update(PetChatBinding)
            .where(PetChatBinding.session_id == UUID(chat["id"]))
            .values(pet_id=UUID(other["pet_id"]))
        )
    for pet_id in [one["pet_id"], other["pet_id"]]:
        assert client.get(f"/api/v1/pets/{pet_id}/sessions/{chat['id']}").status_code == 404
    assert client.get("/api/v1/companion/sessions/" + chat["id"]).status_code == 404
