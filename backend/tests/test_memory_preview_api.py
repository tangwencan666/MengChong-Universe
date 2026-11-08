"""Authenticated preview/confirmation and provenance flow; every database is test-owned."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from auth_helpers import login
from sqlalchemy import func, select
from test_chat import command as chat_command
from test_chat import create_session, generation_path, send
from test_chat_stream import parse_frames
from test_memory_api import (
    CONSENT,
    PREFIX,
    account,
    command,
    correction_payload,
    create_item,
    enable,
    preferences,
    use_account,
)
from test_memory_api import memory_client as memory_client

from app.modules.companion.models import ChatGeneration
from app.modules.memory import service as memory_service
from app.modules.memory.models import (
    Memory,
    MemoryConsentEvent,
    MemoryGenerationRef,
    MemoryOperation,
    MemoryPreferences,
    MemorySource,
)

TEXT = "我希望了解 Python 后端开发岗位。"


def chat_messages(client, texts=None):
    texts = texts or [TEXT]
    session = create_session(client)
    accepted = []
    for index, content in enumerate(texts):
        turn = send(client, session["id"], content)
        accepted.append(turn)
        if index != len(texts) - 1:
            stopped = chat_command(
                client,
                "POST",
                generation_path(session["id"], turn["generation"]["id"]) + "/cancel",
                {},
            )
            assert stopped.status_code == 200
    return session, accepted


def preview_payload(client, session, turns):
    return {
        "session_id": session["id"],
        "message_ids": [turn["user_message"]["id"] for turn in turns],
        "expected_preferences_version": preferences(client)["version"],
        "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
    }


def preview(client, session, turns):
    result = command(client, "POST", "/previews", preview_payload(client, session, turns))
    assert result.status_code == 200, result.text
    return result.json()


def candidate_payload(client, shown, candidate_index=0):
    candidate = shown["candidates"][candidate_index]
    return {
        "title": candidate["title"],
        "content": candidate["content"],
        "category": candidate["category"],
        "expires_at": candidate["suggested_expires_at"],
        "source": {
            "kind": "chat_message",
            "session_id": candidate["source_refs"][0]["session_id"],
            "message_ids": [reference["message_id"] for reference in candidate["source_refs"]],
            "preview_token": shown["preview_token"],
        },
        "expected_preferences_version": preferences(client)["version"],
        "consent": CONSENT,
    }


def memory_counts(engine):
    with engine.connect() as db:
        return {
            model.__tablename__: db.scalar(select(func.count()).select_from(model))
            for model in [
                Memory,
                MemoryPreferences,
                MemoryConsentEvent,
                MemorySource,
                MemoryOperation,
                MemoryGenerationRef,
            ]
        }


def accepted_memory(client, session, turns):
    shown = preview(client, session, turns)
    payload = candidate_payload(client, shown)
    response = command(client, "POST", "/items", payload)
    assert response.status_code == 201, response.text
    return response.json()["item"], payload


def test_preview_needs_authorization_and_never_creates_implicit_memories(
    memory_client, auth_database
):
    account(memory_client)
    session, turns = chat_messages(memory_client)
    before = memory_counts(auth_database[0])
    denied = command(
        memory_client, "POST", "/previews", preview_payload(memory_client, session, turns)
    )
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "MEMORY_DISABLED"
    retrieval = command(
        memory_client,
        "POST",
        "/retrieval-preview",
        {
            "query": "后端岗位",
            "limit": 5,
            "expected_preferences_version": 0,
        },
    )
    assert retrieval.status_code == 409 and retrieval.json()["error"]["code"] == "MEMORY_DISABLED"
    assert memory_counts(auth_database[0]) == before


def test_preview_is_read_only_and_confirmation_alone_creates_owned_sources(
    memory_client, auth_database
):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    before = memory_counts(auth_database[0])
    shown = preview(memory_client, session, turns)
    assert shown["persisted"] is False and shown["candidates"][0]["content"] == TEXT
    assert memory_counts(auth_database[0]) == before
    generation_id = UUID(turns[0]["generation"]["id"])
    with auth_database[0].connect() as db:
        assert (
            db.scalar(select(ChatGeneration.state).where(ChatGeneration.id == generation_id))
            == "queued"
        )
    saved = command(memory_client, "POST", "/items", candidate_payload(memory_client, shown))
    assert saved.status_code == 201
    item = saved.json()["item"]
    assert item["status"] == "active" and item["content"] == TEXT
    provenance = memory_client.get(f"{PREFIX}/items/{item['id']}/sources")
    assert provenance.status_code == 200
    assert provenance.json()["items"][0]["message_id"] == turns[0]["user_message"]["id"]
    assert provenance.json()["items"][0]["availability"] == "available"
    after = memory_counts(auth_database[0])
    assert after["memories"] == before["memories"] + 1
    assert after["memory_sources"] == before["memory_sources"] + 1
    assert after["memory_consent_events"] == before["memory_consent_events"] + 1
    assert after["memory_generation_refs"] == 0
    with auth_database[0].connect() as db:
        assert (
            db.scalar(select(ChatGeneration.state).where(ChatGeneration.id == generation_id))
            == "cancelled"
        )


def test_five_explicit_sources_produce_at_most_three_independent_candidates(
    memory_client, auth_database
):
    account(memory_client)
    enable(memory_client)
    texts = [f"我希望了解后端开发的第{index}个普通方向。" for index in range(5)]
    session, turns = chat_messages(memory_client, texts)
    before = memory_counts(auth_database[0])
    shown = preview(memory_client, session, list(reversed(turns)))
    assert len(shown["candidates"]) == 3
    assert [item["content"] for item in shown["candidates"]] == texts[:3]
    assert all(len(item["source_refs"]) == 1 for item in shown["candidates"])
    assert memory_counts(auth_database[0]) == before
    saved = command(memory_client, "POST", "/items", candidate_payload(memory_client, shown, 1))
    assert saved.status_code == 201
    assert saved.json()["item"]["sources"][0]["message_id"] == turns[1]["user_message"]["id"]


@pytest.mark.parametrize(
    "path,payload",
    [
        (
            "/previews",
            {
                "session_id": str(uuid4()),
                "message_ids": [str(uuid4())],
                "expected_preferences_version": 0,
                "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
            },
        ),
        (
            "/retrieval-preview",
            {"query": "后端开发", "limit": 5, "expected_preferences_version": 0},
        ),
    ],
)
def test_preview_and_retrieval_need_cookie_and_csrf(memory_client, path, payload):
    assert memory_client.post(PREFIX + path, json=payload).status_code == 401
    account(memory_client)
    enable(memory_client)
    assert memory_client.post(PREFIX + path, json=payload).status_code == 403


def test_chat_confirmation_does_not_bypass_csrf(memory_client, auth_database):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    shown = preview(memory_client, session, turns)
    payload = candidate_payload(memory_client, shown)
    response = memory_client.post(
        PREFIX + "/items", json=payload, headers={"Idempotency-Key": str(uuid4())}
    )
    assert response.status_code == 403
    assert memory_counts(auth_database[0])["memories"] == 0


def test_mixed_owner_sources_are_atomic_404_and_cannot_be_confirmed(memory_client, auth_database):
    account(memory_client, "preview-a@example.com")
    enable(memory_client)
    a_session, a_turns = chat_messages(memory_client)
    shown = preview(memory_client, a_session, a_turns)
    a_cookies = type(memory_client.cookies)(memory_client.cookies)
    use_account(memory_client, {})
    account(memory_client, "preview-b@example.com")
    enable(memory_client)
    b_session, b_turns = chat_messages(memory_client)
    b_cookies = type(memory_client.cookies)(memory_client.cookies)
    use_account(memory_client, a_cookies)
    mixed = preview_payload(memory_client, a_session, a_turns)
    mixed["message_ids"].append(b_turns[0]["user_message"]["id"])
    assert command(memory_client, "POST", "/previews", mixed).status_code == 404
    foreign = candidate_payload(memory_client, shown)
    foreign["source"]["session_id"] = b_session["id"]
    foreign["source"]["message_ids"] = [b_turns[0]["user_message"]["id"]]
    assert command(memory_client, "POST", "/items", foreign).status_code == 404
    use_account(memory_client, b_cookies)
    own_pref = preferences(memory_client)["version"]
    stolen = candidate_payload(memory_client, shown)
    stolen["expected_preferences_version"] = own_pref
    assert command(memory_client, "POST", "/items", stolen).status_code == 404
    assert memory_counts(auth_database[0])["memories"] == 0


def test_receipt_expiry_blocks_first_save_but_not_committed_idempotent_replay(
    memory_client, auth_database, monkeypatch
):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    clock = datetime.now(UTC)
    monkeypatch.setattr(memory_service, "now", lambda: clock)
    shown = preview(memory_client, session, turns)
    payload = candidate_payload(memory_client, shown)
    clock += timedelta(minutes=5)
    stale = command(memory_client, "POST", "/items", payload)
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "PREVIEW_STALE"
    assert memory_counts(auth_database[0])["memories"] == 0
    shown = preview(memory_client, session, turns)
    payload = candidate_payload(memory_client, shown)
    key = str(uuid4())
    accepted = command(memory_client, "POST", "/items", payload, key=key)
    assert accepted.status_code == 201
    item = accepted.json()["item"]
    clock += timedelta(minutes=6)
    repeated = command(memory_client, "POST", "/items", payload, key=key)
    assert repeated.status_code == 201 and repeated.json()["idempotent_replay"] is True
    assert repeated.json()["item"]["id"] == item["id"]
    assert (
        command(
            memory_client, "DELETE", f"/items/{item['id']}", {"expected_version": item["version"]}
        ).status_code
        == 204
    )
    assert command(memory_client, "POST", "/items", payload, key=key).status_code == 410


@pytest.mark.parametrize("invalidate", ["epoch", "session"])
def test_receipt_is_invalid_after_memory_change_or_new_login(
    memory_client, auth_database, invalidate
):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    shown = preview(memory_client, session, turns)
    payload = candidate_payload(memory_client, shown)
    if invalidate == "epoch":
        create_item(memory_client, title="另一个明确确认的普通事项")
    else:
        assert login(memory_client, email="memory-a@example.com").status_code == 200
    response = command(memory_client, "POST", "/items", payload)
    assert response.status_code == 409 and response.json()["error"]["code"] == "PREVIEW_STALE"
    assert memory_counts(auth_database[0])["memories"] == (1 if invalidate == "epoch" else 0)


def test_chat_reconfirmation_requires_a_new_receipt_and_cannot_change_origin(memory_client):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    item, _ = accepted_memory(memory_client, session, turns)
    revoked = command(
        memory_client,
        "POST",
        f"/items/{item['id']}/revocations",
        {"expected_version": item["version"]},
    )
    assert revoked.status_code == 200
    inactive = memory_client.get(f"{PREFIX}/items/{item['id']}").json()
    missing_receipt = command(
        memory_client,
        "POST",
        f"/items/{item['id']}/confirm",
        correction_payload(memory_client, inactive),
    )
    assert missing_receipt.status_code == 409
    renewed = preview(memory_client, session, turns)
    payload = correction_payload(memory_client, inactive)
    payload["source"] = candidate_payload(memory_client, renewed)["source"]
    confirmed = command(memory_client, "POST", f"/items/{item['id']}/confirm", payload)
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "active"
    current = confirmed.json()
    forbidden_edit = correction_payload(memory_client, current) | {"source": payload["source"]}
    assert (
        command(memory_client, "PATCH", f"/items/{item['id']}", forbidden_edit).status_code == 422
    )
    revoked = command(
        memory_client,
        "POST",
        f"/items/{item['id']}/revocations",
        {"expected_version": current["version"]},
    )
    assert revoked.status_code == 200
    inactive = memory_client.get(f"{PREFIX}/items/{item['id']}").json()
    other_session, other_turns = chat_messages(memory_client, ["另一段本人明确选择的普通事项。"])
    other_preview = preview(memory_client, other_session, other_turns)
    changed = correction_payload(memory_client, inactive) | {
        "source": candidate_payload(memory_client, other_preview)["source"]
    }
    response = command(memory_client, "POST", f"/items/{item['id']}/confirm", changed)
    assert response.status_code == 409 and response.json()["error"]["code"] == "SOURCE_UNAVAILABLE"
    assert (
        memory_client.get(f"{PREFIX}/items/{item['id']}/sources").json()["items"][0]["message_id"]
        == turns[0]["user_message"]["id"]
    )


def test_deleted_source_is_not_exposed_or_returned_by_retrieval(memory_client):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    item, _ = accepted_memory(memory_client, session, turns)
    assert chat_command(memory_client, "DELETE", f"/sessions/{session['id']}").status_code == 204
    retrieval = command(
        memory_client,
        "POST",
        "/retrieval-preview",
        {
            "query": "Python 后端开发岗位",
            "limit": 5,
            "expected_preferences_version": preferences(memory_client)["version"],
        },
    )
    assert retrieval.status_code == 200
    assert item["id"] not in {hit["memory_id"] for hit in retrieval.json()["items"]}
    provenance = memory_client.get(f"{PREFIX}/items/{item['id']}/sources")
    assert provenance.status_code == 200
    assert provenance.json()["items"][0]["availability"] == "source_deleted"
    assert TEXT not in provenance.text


def test_sensitive_source_is_rejected_before_any_candidate_or_fact_is_saved(
    memory_client, auth_database
):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client, ["请记住密码是 synthetic-local-never-real。"])
    before = memory_counts(auth_database[0])
    response = command(
        memory_client, "POST", "/previews", preview_payload(memory_client, session, turns)
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SENSITIVE_MEMORY_REJECTED"
    assert "synthetic-local-never-real" not in response.text
    assert memory_counts(auth_database[0]) == before


def test_cancelled_sse_replay_does_not_extract_or_store_another_memory(
    memory_client, auth_database
):
    account(memory_client)
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    accepted_memory(memory_client, session, turns)
    before = memory_counts(auth_database[0])
    path = "/api/v1/companion" + generation_path(session["id"], turns[0]["generation"]["id"])
    first = memory_client.get(path + "/events")
    assert first.status_code == 200
    frames = parse_frames(first.text)
    assert [frame["event"] for frame in frames] == ["start", "cancelled"]
    assert frames[-1]["data"]["reason"] == "memory_policy_changed"
    replay = memory_client.get(path + "/events", headers={"Last-Event-ID": frames[0]["id"]})
    assert replay.status_code == 200
    assert [frame["id"] for frame in parse_frames(replay.text)] == [frames[-1]["id"]]
    assert memory_counts(auth_database[0]) == before


def test_retrieval_preview_is_owner_scoped_and_has_no_persistence_side_effects(
    memory_client, auth_database
):
    account(memory_client, "retrieval-a@example.com")
    enable(memory_client)
    item = create_item(memory_client, content=TEXT)
    a_cookies = type(memory_client.cookies)(memory_client.cookies)
    before = memory_counts(auth_database[0])
    result = command(
        memory_client,
        "POST",
        "/retrieval-preview",
        {
            "query": "Python 后端开发岗位",
            "limit": 5,
            "expected_preferences_version": preferences(memory_client)["version"],
        },
    )
    assert result.status_code == 200
    assert item["id"] in {hit["memory_id"] for hit in result.json()["items"]}
    assert len(result.json()["items"]) <= 5
    assert result.json()["counter_version"] and isinstance(result.json()["budget"], dict)
    assert memory_counts(auth_database[0]) == before
    use_account(memory_client, {})
    account(memory_client, "retrieval-b@example.com")
    enable(memory_client)
    other = create_item(memory_client, content="我希望了解数据分析方向。")
    result = command(
        memory_client,
        "POST",
        "/retrieval-preview",
        {
            "query": "Python 后端开发岗位",
            "limit": 5,
            "expected_preferences_version": preferences(memory_client)["version"],
        },
    )
    assert result.status_code == 200
    assert item["id"] not in {hit["memory_id"] for hit in result.json()["items"]}
    use_account(memory_client, a_cookies)
    assert memory_client.get(f"{PREFIX}/items/{other['id']}").status_code == 404


def test_preview_and_retrieval_have_independent_owner_rate_limits(
    memory_client, auth_database, monkeypatch
):
    # Keep the limiter's minute stable without replacing auth, CSRF or API logic.
    monkeypatch.setattr(
        "app.modules.auth.store.time", SimpleNamespace(time=lambda: 1_800_000_000.0)
    )
    account(memory_client, "quota-a@example.com")
    enable(memory_client)
    session, turns = chat_messages(memory_client)
    requests = [
        ("/previews", preview_payload(memory_client, session, turns)),
        (
            "/retrieval-preview",
            {
                "query": "Python 后端开发岗位",
                "limit": 5,
                "expected_preferences_version": preferences(memory_client)["version"],
            },
        ),
    ]
    before = memory_counts(auth_database[0])
    initial_preferences = preferences(memory_client)
    for path, payload in requests:
        # Retrieval keeps its entire allowance after previews exhaust theirs.
        for _ in range(10):
            response = command(memory_client, "POST", path, payload)
            assert response.status_code == 200, response.text
            if path == "/previews":
                assert response.json()["persisted"] is False
            else:
                assert response.json()["items"] == []
        limited = command(memory_client, "POST", path, payload)
        assert limited.status_code == 429
        assert limited.json()["error"]["code"] == "RATE_LIMITED"
        assert limited.headers["Retry-After"] == "60"
    assert memory_counts(auth_database[0]) == before
    assert preferences(memory_client) == initial_preferences

    # A different authenticated owner must not inherit either exhausted bucket.
    use_account(memory_client, {})
    account(memory_client, "quota-b@example.com")
    enable(memory_client)
    other_session, other_turns = chat_messages(memory_client)
    before_other = memory_counts(auth_database[0])
    own_preview = command(
        memory_client,
        "POST",
        "/previews",
        preview_payload(memory_client, other_session, other_turns),
    )
    assert own_preview.status_code == 200 and own_preview.json()["persisted"] is False
    own_retrieval = command(
        memory_client,
        "POST",
        "/retrieval-preview",
        {
            "query": "Python 后端开发岗位",
            "limit": 5,
            "expected_preferences_version": preferences(memory_client)["version"],
        },
    )
    assert own_retrieval.status_code == 200 and own_retrieval.json()["items"] == []
    assert memory_counts(auth_database[0]) == before_other
