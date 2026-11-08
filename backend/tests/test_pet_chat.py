"""Pet-scoped chat uses real auth, temporary storage and the P3 state machine."""

from copy import deepcopy
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf, login, register
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.event_loop import new_event_loop
from app.main import create_app
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent
from app.modules.pets.models import Pet, PetChatBinding, PetGenerationContext


@pytest.fixture
def pet_client(auth_database):
    engine, settings = auth_database
    settings = settings.model_copy(update={"chat_runner_enabled": False})
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        yield client, engine


def account(client, email="pet-chat-owner@example.com"):
    assert register(client, email=email).status_code == 202
    assert login(client, email=email).status_code == 200
    return dict(client.cookies)


def cmd(client, method, path, body=None, key=None):
    headers = csrf(client)
    if key:
        headers["Idempotency-Key"] = key
    return client.request(method, "/api/v1" + path, json=body, headers=headers)


def pet(client, name="小叶", description="说话简洁"):
    response = cmd(
        client,
        "POST",
        "/pets",
        {"name": name, "persona_config": {"description": description, "tone": "calm"}},
        str(uuid4()),
    )
    assert response.status_code == 201, response.text
    return response.json()


def session(client, pet_id, key=None):
    response = cmd(
        client, "POST", f"/pets/{pet_id}/sessions", {"title": "新的聊天"}, key or str(uuid4())
    )
    assert response.status_code == 201, response.text
    return response.json()["session"]


def send(client, pet_id, session_id, content="今天想聊聊", key=None, message_id=None):
    response = cmd(
        client,
        "POST",
        f"/pets/{pet_id}/sessions/{session_id}/messages",
        {"client_message_id": message_id or str(uuid4()), "content": content},
        key or str(uuid4()),
    )
    assert response.status_code == 202, response.text
    return response.json()


class Spy:
    name = "mock"

    def __init__(self):
        self.calls = []
        self.closed = 0

    async def stream(self, messages, system_prompt):
        self.calls.append((deepcopy(messages), system_prompt))
        try:
            yield "【Mock】你好。"
        finally:
            self.closed += 1


def test_session_key_is_bounded_pet_scoped_and_legacy_cannot_bypass(pet_client):
    client, engine = pet_client
    account(client)
    first, second = pet(client), pet(client, "阿团")
    key = str(uuid4())
    one, two = session(client, first["pet_id"], key), session(client, second["pet_id"], key)
    assert one["id"] != two["id"] and one["pet_id"] == first["pet_id"]
    assert session(client, first["pet_id"], key)["id"] == one["id"]
    assert client.get("/api/v1/companion/sessions").json()["items"] == []
    assert client.get("/api/v1/companion/sessions/" + one["id"]).status_code == 404
    assert client.get(f"/api/v1/pets/{second['pet_id']}/sessions/{one['id']}").status_code == 404
    with engine.connect() as db:
        companion = db.scalar(select(Pet.companion_id).where(Pet.id == UUID(first["pet_id"])))
        assert len(db.execute(select(PetChatBinding)).all()) == 2
    response = cmd(
        client, "POST", "/companion/sessions", {"companion_id": str(companion)}, str(uuid4())
    )
    assert response.status_code == 404


def test_pet_chat_auth_csrf_and_cross_user_are_real(pet_client):
    client, _ = pet_client
    assert client.get(f"/api/v1/pets/{uuid4()}/sessions").status_code == 401
    cookies = account(client)
    one = pet(client)
    path = f"/pets/{one['pet_id']}/sessions"
    assert (
        client.post(
            "/api/v1" + path, json={}, headers={"Idempotency-Key": str(uuid4())}
        ).status_code
        == 403
    )
    first = session(client, one["pet_id"])
    client.cookies.clear()
    account(client, "pet-chat-other@example.com")
    assert client.get("/api/v1" + path).status_code == 404
    assert cmd(client, "POST", path, {}, str(uuid4())).status_code == 404
    assert client.get("/api/v1" + path + "/" + first["id"]).status_code == 404
    client.cookies.clear()
    client.cookies.update(cookies)
    assert client.get("/api/v1" + path + "/" + first["id"]).status_code == 200


def test_pet_persona_is_snapshotted_and_present_with_injection_disabled(pet_client, monkeypatch):
    client, engine = pet_client
    spy = Spy()
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: spy)
    account(client)
    one = pet(client, "月牙", "喜欢简短温和的回答")
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    assert accepted["generation"]["pet_id"] == one["pet_id"]
    response = cmd(
        client,
        "PATCH",
        "/pets/" + one["pet_id"],
        {"expected_version": 1, "name": "新名字", "persona_config": {"description": "新设定"}},
    )
    assert response.status_code == 200, response.text
    assert client.portal.call(client.app.state.chat_runner.run_once)
    assert len(spy.calls) == spy.closed == 1
    assert "月牙" in spy.calls[0][1] and "喜欢简短温和的回答" in spy.calls[0][1]
    assert "新名字" not in spy.calls[0][1] and "新设定" not in spy.calls[0][1]
    generation_id = UUID(accepted["generation"]["id"])
    with engine.connect() as db:
        context = (
            db.execute(
                select(PetGenerationContext).where(
                    PetGenerationContext.generation_id == generation_id
                )
            )
            .mappings()
            .one()
        )
        assert context["persona_version"] == 1 and context["memory_refs"] == []
        assert (
            db.scalar(select(ChatGeneration.state).where(ChatGeneration.id == generation_id))
            == "completed"
        )
        events = (
            db.execute(
                select(ChatGenerationEvent)
                .where(ChatGenerationEvent.generation_id == generation_id)
                .order_by(ChatGenerationEvent.event_sequence)
            )
            .mappings()
            .all()
        )
        assert [event["event_type"] for event in events] == ["start", "delta", "completed"]
        assert all(event["payload"]["pet_id"] == one["pet_id"] for event in events)
    history = client.get(f"/api/v1/pets/{one['pet_id']}/sessions/{chat['id']}/messages").json()
    assert [m["role"] for m in history["items"]] == ["user", "assistant"]


def test_pet_history_cursors_reject_other_pet_or_legacy_scope(pet_client):
    client, _ = pet_client
    account(client)
    one, two = pet(client), pet(client, "阿团")
    for _ in range(2):
        session(client, one["pet_id"])
    page = client.get(f"/api/v1/pets/{one['pet_id']}/sessions?limit=1").json()
    assert page["has_more"] and page["next_cursor"]
    assert (
        client.get(
            f"/api/v1/pets/{two['pet_id']}/sessions", params={"cursor": page["next_cursor"]}
        ).status_code
        == 422
    )
    assert (
        client.get("/api/v1/companion/sessions", params={"cursor": page["next_cursor"]}).status_code
        == 422
    )


def test_archive_cancels_queued_work_but_retains_history(pet_client):
    client, engine = pet_client
    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    response = cmd(client, "POST", f"/pets/{one['pet_id']}/archive", {"expected_version": 1})
    assert response.status_code == 200, response.text
    assert client.get(f"/api/v1/pets/{one['pet_id']}/sessions/{chat['id']}").status_code == 200
    assert (
        cmd(client, "POST", f"/pets/{one['pet_id']}/sessions", {}, str(uuid4())).status_code == 409
    )
    assert (
        cmd(
            client,
            "POST",
            f"/pets/{one['pet_id']}/sessions/{chat['id']}/messages",
            {"content": "new", "client_message_id": str(uuid4())},
            str(uuid4()),
        ).status_code
        == 409
    )
    with engine.connect() as db:
        assert (
            db.scalar(
                select(ChatGeneration.state).where(
                    ChatGeneration.id == UUID(accepted["generation"]["id"])
                )
            )
            == "cancelled"
        )


def test_replay_retry_and_cancellation_cannot_change_pet(pet_client):
    client, _ = pet_client
    account(client)
    one, two = pet(client), pet(client, "阿团")
    chat = session(client, one["pet_id"])
    key, message_id = str(uuid4()), str(uuid4())
    first = send(client, one["pet_id"], chat["id"], key=key, message_id=message_id)
    assert (
        send(client, one["pet_id"], chat["id"], key=key, message_id=message_id)["generation"]["id"]
        == first["generation"]["id"]
    )
    base = f"/pets/{one['pet_id']}/sessions/{chat['id']}/generations/{first['generation']['id']}"
    wrong = base.replace(one["pet_id"], two["pet_id"])
    for path in [wrong, wrong + "/events"]:
        assert client.get("/api/v1" + path).status_code == 404
    assert cmd(client, "POST", wrong + "/cancel", {}).status_code == 404
    assert cmd(client, "POST", base + "/cancel", {}).status_code == 200
    retried = cmd(
        client,
        "POST",
        f"/pets/{one['pet_id']}/sessions/{chat['id']}/generations",
        {"retry_of_generation_id": first["generation"]["id"]},
        str(uuid4()),
    )
    assert retried.status_code == 202, retried.text
    assert retried.json()["generation"]["pet_id"] == one["pet_id"]
    assert retried.json()["user_message"]["id"] == first["user_message"]["id"]


def test_pet_memory_references_fail_explicitly_on_legacy_schema(pet_client):
    from sqlalchemy import text

    client, engine = pet_client
    account(client)
    with engine.begin() as db:
        db.execute(text("UPDATE alembic_version SET version_num='0005'"))
    path = f"/api/v1/pets/{uuid4()}/sessions/{uuid4()}/generations/{uuid4()}/memory-refs"
    response = client.get(path)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PET_STORAGE_UNAVAILABLE"
    # Legacy routes still operate against the unchanged schema capability.
    assert client.get("/api/v1/companion/sessions").status_code == 200
