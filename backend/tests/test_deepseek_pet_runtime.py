"""Actual DeepSeek SDK + pet worker over disposable SQLite and HTTPX MockTransport."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select, update
from test_chat_stream import parse_frames
from test_deepseek_provider import BytesStream, frame
from test_deepseek_provider import transport as transport
from test_memory_api import use_account
from test_memory_injection import open_client
from test_pet_chat import account, cmd, pet, send, session
from test_pet_memory import command, create, enable, prefs

from app.agent.chat_runner import _FenceLost, _MemoryContextUnavailable
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.memory.models import MemoryGenerationRef
from app.modules.pets.memory_runtime import PetGenerationMemoryRuntime
from app.modules.pets.models import PetGenerationContext
from app.modules.users.models import User


@pytest.fixture
def deepseek_pet(auth_database, transport, monkeypatch):
    engine, baseline = auth_database
    settings = baseline.model_copy(
        update={
            "environment": "development",
            "llm_provider": "deepseek",
            "real_llm_enabled": True,
            "deepseek_api_key": SecretStr("p8-pet-local-synthetic-key-only"),
            "deepseek_model": "deepseek-flash",
            "memory_management_enabled": True,
            "memory_hmac_key": SecretStr("p8-local-pet-memory-hmac-key-never-production"),
            "memory_injection_enabled": False,
            "chat_runner_enabled": False,
        }
    )
    control = {"hold": False, "streams": [], "started": asyncio.Event()}

    def upstream(_):
        chunks = [frame(control.get("prefix", "固定离线回复"))]
        if not control["hold"]:
            chunks.append(
                frame(
                    finish="stop",
                    usage={"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
                )
            )
        stream = BytesStream(chunks, hold=control["hold"])
        control["streams"].append(stream)
        control["started"].set()
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)

    records = transport(upstream)

    def forbid_retrieval(*args, **kwargs):
        pytest.fail("Real-provider chat must not retrieve, rank, or use Mock memory budgets")

    for name in ("eligible_candidates", "rank_memories", "assemble_budgeted_context"):
        monkeypatch.setattr("app.modules.pets.memory_runtime." + name, forbid_retrieval)
    with open_client(settings) as client:
        yield client, engine, settings, records, control


def endpoint(one, chat, accepted):
    return (
        f"/api/v1/pets/{one['pet_id']}/sessions/{chat['id']}/generations/"
        + accepted["generation"]["id"]
    )


def complete(client, one, chat, accepted):
    assert client.portal.call(client.app.state.chat_runner.run_once)
    result = client.get(endpoint(one, chat, accepted))
    assert result.status_code == 200, result.text
    assert result.json()["generation"]["state"] == "completed", result.text


def test_deepseek_pet_worker_keeps_owner_persona_history_and_empty_memory_refs(deepseek_pet):
    client, engine, _, records, control = deepseek_pet
    owner_cookies = account(client)
    a, b = pet(client, "月牙", "独立人格A"), pet(client, "白团", "独立人格B")
    enable(client, a["pet_id"])
    enable(client, b["pet_id"])
    create(client, a["pet_id"], content="我喜欢简短自然的交流，代号A_MEMORY_PRIVATE。")
    create(client, b["pet_id"], content="我喜欢简短自然的交流，代号B_MEMORY_PRIVATE。")
    client.cookies.clear()
    other_cookies = account(client, "p8-pet-other@example.com")
    other = pet(client, "其他用户宠物")
    enable(client, other["pet_id"])
    create(client, other["pet_id"], content="我喜欢简短自然的交流，代号OTHER_PRIVATE。")
    use_account(client, owner_cookies)
    a_chat, b_chat = session(client, a["pet_id"]), session(client, b["pet_id"])
    first = send(client, a["pet_id"], a_chat["id"], "A_CHAT_ONLY")
    complete(client, a, a_chat, first)
    second = send(client, b["pet_id"], b_chat["id"], "B_CHAT_ONLY")
    complete(client, b, b_chat, second)
    message_id, key = str(uuid4()), str(uuid4())
    follow_up = send(
        client, a["pet_id"], a_chat["id"], "A_FOLLOW_UP", key=key, message_id=message_id
    )
    complete(client, a, a_chat, follow_up)
    assert len(records["requests"]) == 3
    inputs = [json.loads(request.content) for request in records["requests"]]
    for value in inputs:
        private_input = json.dumps(value, ensure_ascii=False)
        assert "_PRIVATE" not in private_input and "authorized_memory_data" not in private_input
        assert value["model"] == "deepseek-flash"
    assert "月牙" in inputs[0]["messages"][0]["content"]
    assert "白团" not in inputs[0]["messages"][0]["content"]
    assert "白团" in inputs[1]["messages"][0]["content"]
    assert "A_CHAT_ONLY" not in json.dumps(inputs[1], ensure_ascii=False)
    assert "B_CHAT_ONLY" not in json.dumps(inputs[2], ensure_ascii=False)
    assert [entry["role"] for entry in inputs[2]["messages"]] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert inputs[2]["messages"][1]["content"] == "A_CHAT_ONLY"
    assert inputs[2]["messages"][2]["content"] == "固定离线回复"
    with engine.connect() as db:
        contexts = db.execute(select(PetGenerationContext.__table__)).mappings().all()
        assert len(contexts) == 3 and all(context["memory_refs"] == [] for context in contexts)
        assert db.scalar(select(func.count()).select_from(MemoryGenerationRef)) == 0
        assert all(
            value is not None
            for value in db.scalars(select(ChatGeneration.__table__.c.memory_snapshot_at))
        )
    # A repeat command/replay only reads the existing task; no new upstream request.
    repeat = send(client, a["pet_id"], a_chat["id"], "A_FOLLOW_UP", key=key, message_id=message_id)
    assert repeat["generation"]["id"] == follow_up["generation"]["id"]
    url = endpoint(a, a_chat, follow_up)
    frames = parse_frames(client.get(url + "/events").text)
    assert [item["event"] for item in frames] == ["start", "delta", "completed"]
    assert frames[-1]["data"]["usage"] == {"input_tokens": 20, "output_tokens": 5}
    assert client.get(url + "/events", headers={"Last-Event-ID": frames[-1]["id"]}).text == ""
    assert len(records["requests"]) == 3
    assert all(item.closed for item in control["streams"])
    assert all(item.is_closed for item in records["clients"])
    assert client.get(url.replace(a["pet_id"], b["pet_id"])).status_code == 404
    use_account(client, other_cookies)
    assert client.get(url).status_code == 404
    assert (
        client.get(f"/api/v1/pets/{a['pet_id']}/sessions/{a_chat['id']}/messages").status_code
        == 404
    )


@pytest.mark.parametrize(
    "action",
    [
        "delete",
        "revoke",
        "disable",
        "archive",
        "account_disabled",
        "delete_session",
        "persona",
        "pet",
    ],
)
def test_deepseek_dispatch_rechecks_privacy_and_pet_before_any_request(
    deepseek_pet, monkeypatch, action
):
    client, engine, settings, records, _ = deepseek_pet
    cookies = account(client)
    one, sibling = pet(client), pet(client, "另一只")
    enable(client, one["pet_id"])
    item = create(client, one["pet_id"])
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    original = PetGenerationMemoryRuntime.before_provider
    reached, release = Event(), Event()

    async def paused(runtime, state):
        reached.set()
        assert await asyncio.to_thread(release.wait, 15)
        if action == "pet":
            runtime.pet_id = UUID(sibling["pet_id"])
        return await original(runtime, state)

    monkeypatch.setattr(PetGenerationMemoryRuntime, "before_provider", paused)
    with ThreadPoolExecutor(max_workers=1) as pool:
        job = pool.submit(client.portal.call, client.app.state.chat_runner.run_once)
        try:
            assert reached.wait(15)
            if action in {"persona", "account_disabled"}:
                with engine.begin() as db:
                    if action == "persona":
                        db.execute(
                            update(PetGenerationContext)
                            .where(
                                PetGenerationContext.generation_id
                                == UUID(accepted["generation"]["id"])
                            )
                            .values(persona_snapshot={"name": "untrusted replacement"})
                        )
                    else:
                        db.execute(update(User).values(status="disabled"))
            elif action != "pet":
                with open_client(settings) as second:
                    second.cookies.update(cookies)
                    if action == "archive":
                        result = cmd(
                            second,
                            "POST",
                            f"/pets/{one['pet_id']}/archive",
                            {"expected_version": 1},
                        )
                        assert result.status_code == 200, result.text
                    elif action == "delete_session":
                        result = cmd(
                            second, "DELETE", f"/pets/{one['pet_id']}/sessions/{chat['id']}"
                        )
                        assert result.status_code == 204, result.text
                    elif action == "disable":
                        result = command(
                            second,
                            one["pet_id"],
                            "PATCH",
                            "/preferences",
                            {
                                "long_term_memory_enabled": False,
                                "expected_version": prefs(second, one["pet_id"])["version"],
                            },
                        )
                        assert result.status_code == 200, result.text
                    else:
                        result = command(
                            second,
                            one["pet_id"],
                            "POST" if action == "revoke" else "DELETE",
                            "/items/" + item["id"] + ("/revocations" if action == "revoke" else ""),
                            {"expected_version": item["version"]},
                        )
                        assert result.status_code == (200 if action == "revoke" else 204), (
                            result.text
                        )
        finally:
            release.set()
        assert job.result(timeout=15)
    assert records["requests"] == []
    with engine.connect() as db:
        row = db.execute(
            select(ChatGeneration.state, ChatGeneration.__table__.c.memory_snapshot_at).where(
                ChatGeneration.id == UUID(accepted["generation"]["id"])
            )
        ).one()
        assert row.state == "cancelled" and row.memory_snapshot_at is None


def test_real_memory_injection_still_fails_closed_and_cannot_be_reenabled_in_flight(deepseek_pet):
    client, _, settings, records, _ = deepseek_pet
    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    settings.memory_injection_enabled = True  # Internal bypass must also fail closed.
    assert client.portal.call(client.app.state.chat_runner.run_once)
    assert client.get(endpoint(one, chat, accepted)).json()["generation"]["state"] == "failed"
    assert records["requests"] == []
    runtime = PetGenerationMemoryRuntime(
        SimpleNamespace(settings=settings),
        SimpleNamespace(
            pet_id=UUID(one["pet_id"]),
            provider="deepseek",
            model="deepseek-flash",
            identity=SimpleNamespace(owner_id=uuid4()),
        ),
    )
    with pytest.raises(_MemoryContextUnavailable):
        runtime.plain_provider_context()


def test_deepseek_pet_cancellation_closes_sdk_and_retry_keeps_identity(deepseek_pet):
    client, engine, _, records, control = deepseek_pet
    account(client)
    one = pet(client, "月牙")
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    control["hold"] = True
    runner = client.app.state.chat_runner
    job = client.portal.start_task_soon(runner.run_once)

    async def wait_for_stream():
        async with asyncio.timeout(8):
            await control["started"].wait()
            await control["streams"][-1].waiting.wait()

    try:
        client.portal.call(wait_for_stream)
        url = endpoint(one, chat, accepted)
        assert cmd(client, "POST", url.removeprefix("/api/v1") + "/cancel", {}).status_code in (
            200,
            202,
        )
        assert job.result(timeout=10)
        assert control["streams"][-1].closed and records["clients"][-1].is_closed
        frames = parse_frames(client.get(url + "/events").text)
        assert frames[-1]["event"] == "cancelled"
        assert sum(value["event"] in {"completed", "cancelled", "error"} for value in frames) == 1
        control["hold"] = False
        retried = cmd(
            client,
            "POST",
            f"/pets/{one['pet_id']}/sessions/{chat['id']}/generations",
            {"retry_of_generation_id": accepted["generation"]["id"]},
            str(uuid4()),
        )
        assert retried.status_code == 202, retried.text
        complete(client, one, chat, retried.json())
        assert len(records["requests"]) == 2
        assert all(
            "月牙" in json.loads(request.content)["messages"][0]["content"]
            for request in records["requests"]
        )
        with engine.connect() as db:
            assert (
                db.scalar(
                    select(func.count()).select_from(ChatMessage).where(ChatMessage.role == "user")
                )
                == 1
            )
    finally:
        if not job.done():
            job.cancel()


def test_deepseek_cancel_after_committed_delta_fences_late_writes_and_other_sessions(
    deepseek_pet, monkeypatch
):
    client, engine, _, records, control = deepseek_pet
    account(client)
    one, sibling = pet(client, "月芽"), pet(client, "另一只宠物")
    chat, other_chat = session(client, one["pet_id"]), session(client, sibling["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    url = endpoint(one, chat, accepted)
    control["hold"] = True
    runner = client.app.state.chat_runner
    original_flush = runner._flush
    committed = asyncio.Event()
    claims = []

    async def observe_flush(claim, value):
        await original_flush(claim, value)
        claims.append(claim)
        committed.set()

    monkeypatch.setattr(runner, "_flush", observe_flush)
    job = client.portal.start_task_soon(runner.run_once)

    async def wait_for_visible_delta():
        async with asyncio.timeout(8):
            await control["started"].wait()
            await control["streams"][-1].waiting.wait()
            await committed.wait()

    try:
        client.portal.call(wait_for_visible_delta)
        before_cancel = client.get(url).json()
        assert before_cancel["generation"]["state"] == "running"
        assert before_cancel["assistant_message"]["content"] == "固定离线回复"
        assert cmd(client, "POST", url.removeprefix("/api/v1") + "/cancel", {}).status_code in (
            200,
            202,
        )
        assert job.result(timeout=10)
        saved = client.get(url).json()
        assert saved["generation"]["state"] == "cancelled"
        assert saved["assistant_message"]["status"] == "cancelled"
        assert saved["assistant_message"]["content"] == "固定离线回复"
        assert control["streams"][-1].closed and records["clients"][-1].is_closed

        async def late_producer():
            with pytest.raises(_FenceLost):
                await original_flush(claims[0], "禁止追加的迟到片段")
            await runner._finish(claims[0], "completed", pending="禁止追加的完成片段")
            await runner._finish(claims[0], "cancelled")

        client.portal.call(late_producer)
        assert cmd(client, "POST", url.removeprefix("/api/v1") + "/cancel", {}).status_code == 200
        assert client.get(url).json() == saved
        frames = parse_frames(client.get(url + "/events").text)
        assert [item["event"] for item in frames] == ["start", "delta", "cancelled"]
        assert frames[-1]["data"]["content"] == saved["assistant_message"]["content"]
        assert client.get(url + "/events", headers={"Last-Event-ID": frames[-1]["id"]}).text == ""
        other_history = f"/api/v1/pets/{sibling['pet_id']}/sessions/{other_chat['id']}/messages"
        assert client.get(other_history).json()["items"] == []
        assert client.get(url.replace(chat["id"], other_chat["id"])).status_code == 404
        assert client.get(url.replace(one["pet_id"], sibling["pet_id"])).status_code == 404
        with engine.connect() as db:
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ChatGenerationEvent)
                    .where(ChatGenerationEvent.generation_id == UUID(accepted["generation"]["id"]))
                )
                == 3
            )
        assert len(records["requests"]) == 1
    finally:
        if not job.done():
            job.cancel()


@pytest.mark.parametrize("winner", ["cancel", "completion"])
def test_deepseek_cancel_and_completion_commit_in_controlled_order(
    deepseek_pet, monkeypatch, winner
):
    client, _, _, records, control = deepseek_pet
    account(client)
    one = pet(client, "月芽")
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    url = endpoint(one, chat, accepted)
    # Force a persisted delta before the SDK's normal end-of-stream reaches _finish.
    control["prefix"] = "已持久化片段。" * 40
    runner = client.app.state.chat_runner
    original_finish = runner._finish
    reached, release = asyncio.Event(), asyncio.Event()
    claims = []

    async def pause_completion(claim, state, **options):
        if state == "completed":
            claims.append(claim)
            reached.set()
            await release.wait()
        await original_finish(claim, state, **options)

    monkeypatch.setattr(runner, "_finish", pause_completion)
    job = client.portal.start_task_soon(runner.run_once)

    async def wait_for_completion_boundary():
        await asyncio.wait_for(reached.wait(), 8)

    try:
        client.portal.call(wait_for_completion_boundary)
        pending = client.get(url).json()
        assert pending["generation"]["state"] == "running"
        assert pending["assistant_message"]["content"] == control["prefix"]
        if winner == "cancel":
            assert cmd(client, "POST", url.removeprefix("/api/v1") + "/cancel", {}).status_code in (
                200,
                202,
            )
            client.portal.call(release.set)
            assert job.result(timeout=10)
        else:
            client.portal.call(release.set)
            assert job.result(timeout=10)
            late_cancel = cmd(client, "POST", url.removeprefix("/api/v1") + "/cancel", {})
            assert late_cancel.status_code == 200
            assert late_cancel.json()["generation"]["state"] == "completed"
        saved = client.get(url).json()
        expected = "cancelled" if winner == "cancel" else "completed"
        assert saved["generation"]["state"] == saved["assistant_message"]["status"] == expected
        assert saved["assistant_message"]["content"] == control["prefix"]

        async def duplicate_finishes():
            await original_finish(claims[0], "completed", pending="迟到完成不可重写终态")
            await original_finish(claims[0], "cancelled")

        client.portal.call(duplicate_finishes)
        assert client.get(url).json() == saved
        frames = parse_frames(client.get(url + "/events").text)
        assert [item["event"] for item in frames] == ["start", "delta", expected]
        assert all(item["data"]["session_id"] == chat["id"] for item in frames)
        assert all(item["data"]["pet_id"] == one["pet_id"] for item in frames)
        assert len({item["id"] for item in frames}) == 3
        assert len(records["requests"]) == 1
        assert control["streams"][-1].closed and records["clients"][-1].is_closed
    finally:
        client.portal.call(release.set)
        if not job.done():
            job.cancel()
