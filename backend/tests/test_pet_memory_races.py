"""Pet-local provider input, replay and privacy barriers using an observing Mock."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, update
from test_chat import run_one
from test_memory_api import account, use_account
from test_memory_api import command as legacy_command
from test_memory_api import create_item as create_legacy_memory
from test_memory_api import enable as enable_legacy
from test_memory_injection import entries, open_client
from test_memory_injection import injection_context as injection_context
from test_pet_memory import command, create, enable, path, pet_chat, prefs
from test_pets import create as create_pet

from app.modules.companion.models import ChatGeneration, ChatGenerationEvent
from app.modules.memory.models import MemoryGenerationRef
from app.modules.pets.memory_runtime import PetGenerationMemoryRuntime
from app.modules.pets.models import PetGenerationContext, PetMemory
from app.modules.users.models import User
from tests.auth_helpers import csrf


def terminal(client, pet, session, turn):
    run_one(client)
    url = f"/api/v1/pets/{pet}/sessions/{session['id']}/generations/" + turn["generation"]["id"]
    result = client.get(url)
    assert result.status_code == 200 and result.json()["generation"]["state"] == "completed", (
        result.text
    )
    return url


def test_pet_default_off_still_supplies_persona_without_legacy_memory(injection_context):
    _, _, c, spy = injection_context
    account(c)
    enable_legacy(c)
    create_legacy_memory(c, content="我喜欢简短自然的交流，代号LEGACY_PRIVATE。")
    pet = create_pet(c, name="小青")["pet_id"]
    session, turn = pet_chat(c, pet)
    terminal(c, pet, session, turn)
    messages, prompt = spy.calls[-1]
    assert entries(messages) == []
    assert "LEGACY_PRIVATE" not in json.dumps(messages, ensure_ascii=False)
    assert "小青" in prompt
    assert not prefs(c, pet)["long_term_memory_enabled"]


def test_legacy_privacy_removal_does_not_cancel_or_fence_a_pet(injection_context):
    engine, _, c, spy = injection_context
    account(c)
    enable_legacy(c)
    legacy = create_legacy_memory(c, content="我喜欢简短自然的交流，代号LEGACY_PRIVATE。")
    pet = create_pet(c)["pet_id"]
    session, turn = pet_chat(c, pet)
    result = legacy_command(
        c,
        "DELETE",
        "/items/" + legacy["id"],
        {
            "expected_version": legacy["version"],
        },
    )
    assert result.status_code == 204
    with engine.connect() as db:
        assert (
            db.scalar(
                select(ChatGeneration.state).where(
                    ChatGeneration.id == UUID(turn["generation"]["id"])
                )
            )
            == "queued"
        )
    terminal(c, pet, session, turn)
    assert entries(spy.calls[-1][0]) == []
    assert prefs(c, pet)["privacy_epoch"] == "0"


def test_account_disabled_after_acceptance_never_dispatches_pet_provider(
    injection_context,
    monkeypatch,
):
    engine, _, c, spy = injection_context
    identity, _ = account(c)
    pet = create_pet(c)["pet_id"]
    session, turn = pet_chat(c, pet)
    original = PetGenerationMemoryRuntime.before_provider
    reached, release = Event(), Event()

    async def paused(runtime, state):
        reached.set()
        assert await asyncio.to_thread(release.wait, 15)
        return await original(runtime, state)

    monkeypatch.setattr(PetGenerationMemoryRuntime, "before_provider", paused)
    with ThreadPoolExecutor(max_workers=1) as pool:
        job = pool.submit(c.portal.call, c.app.state.chat_runner.run_once)
        try:
            assert reached.wait(15), "Generation did not reach account-state barrier"
            with engine.begin() as db:
                db.execute(
                    update(User)
                    .where(User.id == UUID(identity["id"]))
                    .values(
                        status="disabled",
                    )
                )
        finally:
            release.set()
        assert job.result(timeout=15)
    assert spy.constructed == 0
    with engine.connect() as db:
        row = db.execute(
            select(ChatGeneration.state, ChatGeneration.__table__.c.memory_snapshot_at).where(
                ChatGeneration.id == UUID(turn["generation"]["id"])
            )
        ).one()
        assert row.state == "cancelled" and row.memory_snapshot_at is None


def test_spy_provider_gets_only_current_pet_and_owner_grants(injection_context):
    engine, _, c, spy = injection_context
    _, cookies = account(c)
    a, b = create_pet(c, name="小青")["pet_id"], create_pet(c, name="小白")["pet_id"]
    enable(c, a)
    enable(c, b)
    own = create(c, a, content="我喜欢简短自然的交流，代号PET_A_PRIVATE。")
    create(c, b, content="我喜欢简短自然的交流，代号PET_B_PRIVATE。")
    c.cookies.clear()
    account(c, "pet-spy-other@example.com")
    other = create_pet(c)["pet_id"]
    enable(c, other)
    create(c, other, content="我喜欢简短自然的交流，代号OTHER_OWNER_PRIVATE。")
    use_account(c, cookies)
    session, turn = pet_chat(c, a)
    url = terminal(c, a, session, turn)
    sent = entries(spy.calls[-1][0])
    assert [item["memory_id"] for item in sent] == [own["id"]]
    serialized = json.dumps(spy.calls[-1], ensure_ascii=False)
    assert "PET_A_PRIVATE" in serialized
    assert "PET_B_PRIVATE" not in serialized and "OTHER_OWNER_PRIVATE" not in serialized
    assert "小青" in spy.calls[-1][1]
    with engine.connect() as db:
        ctx = (
            db.execute(
                select(PetGenerationContext.__table__).where(
                    PetGenerationContext.generation_id == UUID(turn["generation"]["id"])
                )
            )
            .mappings()
            .one()
        )
        assert ctx["pet_id"] == UUID(a) and ctx["memory_refs"][0]["memory_id"] == own["id"]
        assert db.scalar(select(func.count()).select_from(MemoryGenerationRef)) == 0
        before = db.scalar(select(func.count()).select_from(PetMemory))
    calls = spy.constructed
    replay = c.get(url + "/events", headers={"Last-Event-ID": turn["generation"]["id"] + ":1"})
    assert replay.status_code == 200
    assert spy.constructed == calls
    with engine.connect() as db:
        assert db.scalar(select(func.count()).select_from(PetMemory)) == before


def test_deleted_memory_is_excluded_from_same_pet_historical_context(injection_context):
    _, _, c, spy = injection_context
    account(c)
    a, b = create_pet(c)["pet_id"], create_pet(c)["pet_id"]
    enable(c, a)
    item = create(c, a, content="我喜欢简短自然的交流，代号DELETED_MEMORY_SECRET。")
    spy.reply = "【Mock】DELETED_MEMORY_SECRET 原先的合成回复。"
    a_session, a_turn = pet_chat(c, a)
    terminal(c, a, a_session, a_turn)
    spy.reply = "【Mock】SIBLING_HISTORY_KEEP 另一只宠物的历史。"
    b_session, b_turn = pet_chat(c, b)
    terminal(c, b, b_session, b_turn)
    assert (
        command(
            c,
            a,
            "DELETE",
            "/items/" + item["id"],
            {
                "expected_version": item["version"],
            },
        ).status_code
        == 204
    )
    spy.reply = "【Mock】新的合成回复。"
    for pet, session in [(a, a_session), (b, b_session)]:
        response = c.post(
            f"/api/v1/pets/{pet}/sessions/{session['id']}/messages",
            json={
                "content": "继续简短自然地聊聊。",
                "client_message_id": str(uuid4()),
            },
            headers={**csrf(c), "Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == 202, response.text
        terminal(c, pet, session, response.json())
        actual_input = json.dumps(spy.calls[-1], ensure_ascii=False)
        assert "DELETED_MEMORY_SECRET" not in actual_input
        if pet == b:
            assert "SIBLING_HISTORY_KEEP" in actual_input
    # The context barrier does not erase the user's historical chat messages.
    history = c.get(f"/api/v1/pets/{a}/sessions/{a_session['id']}/messages")
    assert history.status_code == 200
    assert "DELETED_MEMORY_SECRET" in history.text


@pytest.mark.parametrize("action", ["delete", "disable", "revoke"])
def test_pet_privacy_change_at_dispatch_cancels_only_current_pet(
    injection_context,
    monkeypatch,
    action,
):
    engine, settings, c, spy = injection_context
    account(c)
    a, b = create_pet(c)["pet_id"], create_pet(c)["pet_id"]
    enable(c, a)
    item = create(c, a)
    session, turn = pet_chat(c, a)
    # A second pet's queued job is deliberately retained through the privacy change.
    _, sibling = pet_chat(c, b)
    original = PetGenerationMemoryRuntime.before_provider
    reached, release = Event(), Event()

    async def paused(runtime, state):
        reached.set()
        assert await asyncio.to_thread(release.wait, 15)
        return await original(runtime, state)

    monkeypatch.setattr(PetGenerationMemoryRuntime, "before_provider", paused)
    cookies = type(c.cookies)(c.cookies)
    with ThreadPoolExecutor(max_workers=1) as pool:
        job = pool.submit(c.portal.call, c.app.state.chat_runner.run_once)
        try:
            assert reached.wait(15), "Generation did not reach dispatch barrier"
            with open_client(settings) as second:
                second.cookies.update(cookies)
                if action == "disable":
                    response = command(
                        second,
                        a,
                        "PATCH",
                        "/preferences",
                        {
                            "long_term_memory_enabled": False,
                            "expected_version": prefs(second, a)["version"],
                        },
                    )
                    assert response.status_code == 200, response.text
                else:
                    suffix = "/items/" + item["id"] + ("/revocations" if action == "revoke" else "")
                    response = command(
                        second,
                        a,
                        "POST" if action == "revoke" else "DELETE",
                        suffix,
                        {"expected_version": item["version"]},
                    )
                    assert response.status_code == (200 if action == "revoke" else 204), (
                        response.text
                    )
        finally:
            release.set()
        assert job.result(timeout=15)
    assert spy.constructed == 0
    with engine.connect() as db:
        assert (
            db.scalar(
                select(ChatGeneration.state).where(
                    ChatGeneration.id == UUID(turn["generation"]["id"])
                )
            )
            == "cancelled"
        )
        assert (
            db.scalar(
                select(ChatGeneration.state).where(
                    ChatGeneration.id == UUID(sibling["generation"]["id"])
                )
            )
            == "queued"
        )
        assert list(
            db.scalars(
                select(ChatGenerationEvent.event_type)
                .where(ChatGenerationEvent.generation_id == UUID(turn["generation"]["id"]))
                .order_by(ChatGenerationEvent.event_sequence)
            )
        ) == ["start", "cancelled"]
    assert c.get(path(b, "/preferences")).json()["privacy_epoch"] == "0"
