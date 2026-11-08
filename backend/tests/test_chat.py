"""Private chat commands use real auth and a new forward-migrated SQLite file."""

import base64
import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf, login, register
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select, update

from app.core.event_loop import new_event_loop
from app.db.base import Base
from app.main import create_app
from app.modules.companion.models import AICompanion, ChatMessage, ChatSession
from app.modules.users.models import User

PREFIX = "/api/v1/companion"


@pytest.fixture
def chat_database(auth_database):
    engine, settings = auth_database
    return engine, settings.model_copy(
        update={"chat_runner_enabled": False, "llm_provider": "mock", "real_llm_enabled": False}
    )


@pytest.fixture
def chat_client(chat_database):
    with TestClient(
        create_app(chat_database[1]),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        yield client


def identity(client, email="chat-one@example.com"):
    assert register(client, email=email).status_code == 202
    response = login(client, email=email)
    assert response.status_code == 200, response.text
    return response.json()


def command(client, method, path, payload=None, *, key=None):
    headers = csrf(client)
    if key is not None:
        headers["Idempotency-Key"] = key
    return client.request(method, PREFIX + path, json=payload, headers=headers)


def create_session(client, title="新的聊天", *, key=None, companion_id=None):
    response = command(
        client,
        "POST",
        "/sessions",
        {"title": title, "companion_id": companion_id},
        key=key or str(uuid4()),
    )
    assert response.status_code == 201, response.text
    return response.json()["session"]


def send(client, session_id, content="今天想练习面试。", *, key=None, client_message_id=None):
    response = command(
        client,
        "POST",
        f"/sessions/{session_id}/messages",
        {"client_message_id": client_message_id or str(uuid4()), "content": content},
        key=key or str(uuid4()),
    )
    assert response.status_code == 202, response.text
    return response.json()


def run_one(client):
    assert client.portal.call(client.app.state.chat_runner.run_once)


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
    assert response.json()["request_id"]


def generation_path(session_id, generation_id):
    return f"/sessions/{session_id}/generations/{generation_id}"


def test_create_session_normalization_idempotency_rename_and_soft_delete(chat_client):
    identity(chat_client)
    key = str(uuid4())
    payload = {"title": "  第一段\r\n聊天  "}
    first = command(chat_client, "POST", "/sessions", payload, key=key)
    assert first.status_code == 201
    session = first.json()["session"]
    assert session["title"] == "第一段\n聊天"
    assert session["version"] == 1
    assert session["active_generation"] is None
    assert session["last_message_at"] is None
    assert session["created_at"].endswith("Z")
    assert first.headers["location"].endswith("/sessions/" + session["id"])
    assert "no-store" in first.headers["cache-control"]
    replay = command(chat_client, "POST", "/sessions", {"title": "第一段\n聊天"}, key=key)
    assert replay.status_code == 201
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["session"]["id"] == session["id"]
    assert_error(
        command(chat_client, "POST", "/sessions", {"title": "不同标题"}, key=key),
        409,
        "IDEMPOTENCY_CONFLICT",
    )
    renamed = command(
        chat_client,
        "PATCH",
        f"/sessions/{session['id']}",
        {"title": "面试准备", "expected_version": 1},
    )
    assert renamed.status_code == 200
    assert renamed.json()["version"] == 2
    assert renamed.json()["last_activity_at"] == session["last_activity_at"]
    assert_error(
        command(
            chat_client,
            "PATCH",
            f"/sessions/{session['id']}",
            {"title": "旧窗口", "expected_version": 1},
        ),
        409,
        "VERSION_CONFLICT",
    )
    for _ in range(2):
        assert command(chat_client, "DELETE", f"/sessions/{session['id']}").status_code == 204
    assert_error(chat_client.get(PREFIX + f"/sessions/{session['id']}"), 404, "RESOURCE_NOT_FOUND")
    assert chat_client.get(PREFIX + "/sessions").json()["items"] == []
    assert_error(
        command(chat_client, "POST", "/sessions", payload, key=key), 409, "RESOURCE_DELETED"
    )


def test_session_page_is_owner_bound_and_rename_does_not_reorder(chat_client):
    identity(chat_client)
    first = create_session(chat_client, "第一段")
    second = create_session(chat_client, "第二段")
    page = chat_client.get(PREFIX + "/sessions", params={"limit": 1}).json()
    assert [item["id"] for item in page["items"]] == [second["id"]]
    assert page["has_more"] is True and page["next_cursor"]
    renamed = command(
        chat_client,
        "PATCH",
        f"/sessions/{first['id']}",
        {"title": "新标题", "expected_version": 1},
    )
    assert renamed.status_code == 200
    next_page = chat_client.get(
        PREFIX + "/sessions", params={"limit": 1, "cursor": page["next_cursor"]}
    ).json()
    assert [item["id"] for item in next_page["items"]] == [first["id"]]
    assert next_page["has_more"] is False and next_page["next_cursor"] is None
    identity(chat_client, "chat-two@example.com")
    assert_error(
        chat_client.get(PREFIX + "/sessions", params={"cursor": page["next_cursor"]}),
        422,
        "INVALID_CURSOR",
    )


def test_accept_is_atomic_and_duplicate_keys_are_checked_before_busy_state(
    chat_client, chat_database
):
    user = identity(chat_client)
    session = create_session(chat_client)
    key, client_id = str(uuid4()), str(uuid4())
    accepted = send(
        chat_client, session["id"], "  原文\r\n保留  ", key=key, client_message_id=client_id
    )
    generation = accepted["generation"]
    assert generation["state"] == "queued"
    assert generation["provider"] == "mock" and generation["model"] is None
    assert generation["prompt_version"] == "companion-v1"
    assert generation["last_event_id"] == generation["id"] + ":1"
    assert (
        accepted["events_url"]
        == PREFIX + generation_path(session["id"], generation["id"]) + "/events"
    )
    assert accepted["user_message"]["content"] == "原文\n保留"
    assert accepted["user_message"]["status"] == "completed"
    assert accepted["user_message"]["provider"] is None
    assert accepted["user_message"]["generation_id"] is None
    assert accepted["assistant_message"]["content"] == ""
    assert accepted["assistant_message"]["status"] == "queued"
    assert accepted["assistant_message"]["client_message_id"] is None
    replay = send(chat_client, session["id"], "原文\n保留", key=key, client_message_id=client_id)
    assert replay["idempotent_replay"] is True
    assert replay["generation"]["id"] == generation["id"]
    assert_error(
        command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/messages",
            {"client_message_id": client_id, "content": "改过的正文"},
            key=key,
        ),
        409,
        "IDEMPOTENCY_CONFLICT",
    )
    assert_error(
        command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/messages",
            {"client_message_id": client_id, "content": "原文\n保留"},
            key=str(uuid4()),
        ),
        409,
        "DUPLICATE_CLIENT_MESSAGE",
    )
    assert_error(
        command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/messages",
            {"client_message_id": str(uuid4()), "content": "另一条输入"},
            key=str(uuid4()),
        ),
        409,
        "GENERATION_IN_PROGRESS",
    )
    detail = chat_client.get(PREFIX + f"/sessions/{session['id']}").json()
    assert detail["active_generation"]["id"] == generation["id"]
    with chat_database[0].connect() as db:
        messages = (
            db.execute(
                select(ChatMessage.__table__).where(ChatMessage.owner_id == UUID(user["id"]))
            )
            .mappings()
            .all()
        )
        assert len(messages) == 2
        events = Base.metadata.tables["chat_generation_events"]
        assert db.scalar(select(func.count()).select_from(events)) == 1


def test_queue_cancellation_is_terminal_and_retry_preserves_original_user(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    original = send(chat_client, session["id"])
    path = generation_path(session["id"], original["generation"]["id"])
    for _ in range(2):
        cancelled = command(chat_client, "POST", path + "/cancel", {})
        assert cancelled.status_code == 200
        assert cancelled.json()["generation"]["state"] == "cancelled"
    retry_key = str(uuid4())
    request = {"retry_of_generation_id": original["generation"]["id"]}
    retried = command(
        chat_client, "POST", f"/sessions/{session['id']}/generations", request, key=retry_key
    )
    assert retried.status_code == 202, retried.text
    body = retried.json()
    assert body["user_message"]["id"] == original["user_message"]["id"]
    assert body["assistant_message"]["id"] != original["assistant_message"]["id"]
    assert body["generation"]["retry_of_generation_id"] == original["generation"]["id"]
    replay = command(
        chat_client, "POST", f"/sessions/{session['id']}/generations", request, key=retry_key
    )
    assert replay.status_code == 202 and replay.json()["idempotent_replay"] is True
    assert replay.json()["generation"]["id"] == body["generation"]["id"]
    run_one(chat_client)
    messages = chat_client.get(PREFIX + f"/sessions/{session['id']}/messages").json()["items"]
    assert [message["role"] for message in messages] == ["user", "assistant", "assistant"]
    assert [message["status"] for message in messages] == ["completed", "cancelled", "completed"]
    assert_error(
        command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/generations",
            request,
            key=str(uuid4()),
        ),
        409,
        "RETRY_NOT_ALLOWED",
    )


def test_private_mock_persists_snapshot_without_wallet_memory_or_sdk_calls(
    chat_client, chat_database, monkeypatch
):
    def forbidden(*args, **kwargs):
        raise AssertionError("Private Mock must never construct a real provider client")

    monkeypatch.setattr("app.agent.providers.AsyncOpenAI", forbidden)
    identity(chat_client)
    untouched = [
        "wallets",
        "wallet_transactions",
        "wallet_reservations",
        "usage_records",
        "memories",
    ]
    with chat_database[0].connect() as db:
        before = {name: db.execute(select(Base.metadata.tables[name])).all() for name in untouched}
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"], "<script>alert('原样文本')</script>")
    run_one(chat_client)
    path = generation_path(session["id"], accepted["generation"]["id"])
    snapshot = chat_client.get(PREFIX + path)
    assert snapshot.status_code == 200
    body = snapshot.json()
    assert body["generation"]["state"] == "completed"
    assert body["generation"]["finished_at"].endswith("Z")
    assert body["generation"]["error"] is None
    assert body["assistant_message"]["status"] == "completed"
    assert body["assistant_message"]["completed_at"].endswith("Z")
    content = body["assistant_message"]["content"]
    assert "Mock" in content and "当前账户" in content and "长期记忆" in content
    assert "不会保存会话" not in content
    assert body["resume_after_event_id"] == body["generation"]["last_event_id"]
    assert "no-store" in snapshot.headers["cache-control"]
    history = chat_client.get(PREFIX + f"/sessions/{session['id']}/messages").json()["items"]
    assert history[-1] == body["assistant_message"]
    assert history[0]["content"] == "<script>alert('原样文本')</script>"
    assert not any(message["role"] == "system" for message in history)
    detail = chat_client.get(PREFIX + f"/sessions/{session['id']}").json()
    assert detail["active_generation"] is None
    assert (
        command(chat_client, "POST", path + "/cancel", {}).json()["generation"]["state"]
        == "completed"
    )
    with chat_database[0].connect() as db:
        assert {
            name: db.execute(select(Base.metadata.tables[name])).all() for name in untouched
        } == before


def test_message_pages_have_frozen_upper_boundary_and_bind_to_session(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    for content in ["第一轮", "第二轮", "第三轮"]:
        send(chat_client, session["id"], content)
        run_one(chat_client)
    path = PREFIX + f"/sessions/{session['id']}/messages"
    first = chat_client.get(path, params={"limit": 2}).json()
    assert [message["sequence"] for message in first["items"]] == [4, 5]
    assert first["has_more"] is True
    send(chat_client, session["id"], "新增第四轮")
    run_one(chat_client)
    second = chat_client.get(path, params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [message["sequence"] for message in second["items"]] == [2, 3]
    third = chat_client.get(path, params={"limit": 2, "cursor": second["next_cursor"]}).json()
    assert [message["sequence"] for message in third["items"]] == [0, 1]
    assert third["has_more"] is False and third["next_cursor"] is None
    other = create_session(chat_client)
    assert_error(
        chat_client.get(
            PREFIX + f"/sessions/{other['id']}/messages", params={"cursor": first["next_cursor"]}
        ),
        422,
        "INVALID_CURSOR",
    )


def test_preferences_topic_sources_dismissal_and_reenable(chat_client):
    identity(chat_client)
    assert chat_client.get(PREFIX + "/preferences").json() == {
        "recent_topic_enabled": False,
        "version": 0,
        "consented_at": None,
    }
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}
    enabled = command(
        chat_client, "PATCH", "/preferences", {"recent_topic_enabled": True, "expected_version": 0}
    )
    assert enabled.status_code == 200
    preference = enabled.json()
    assert preference["recent_topic_enabled"] is True
    assert preference["version"] == 1 and preference["consented_at"].endswith("Z")
    assert_error(
        command(
            chat_client,
            "PATCH",
            "/preferences",
            {"recent_topic_enabled": False, "expected_version": 0},
        ),
        409,
        "VERSION_CONFLICT",
    )
    session = create_session(chat_client, "来源标题")
    accepted = send(chat_client, session["id"], "来源内容" * 40)
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}
    run_one(chat_client)
    topic = chat_client.get(PREFIX + "/recent-topic").json()["item"]
    assert topic["conversation_id"] == session["id"] and topic["title"] == "来源标题"
    assert topic["source"] == "message-excerpt" and topic["dismissed"] is False
    assert 1 <= len(topic["summary"]) <= 80
    assert ("来源内容" * 40).startswith(topic["summary"].removesuffix("…"))
    assert topic["source_message_ids"] == [
        accepted["user_message"]["id"],
        accepted["assistant_message"]["id"],
    ]
    assert topic["follow_up_text"] == "如果你愿意，我们可以从上次的这段话接着聊。"
    for _ in range(2):
        assert (
            command(
                chat_client,
                "POST",
                f"/sessions/{session['id']}/topic-dismissals",
                {"summary_version": topic["summary_version"]},
            ).status_code
            == 204
        )
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}
    current_version = chat_client.get(PREFIX + "/preferences").json()["version"]
    repeated = command(
        chat_client,
        "PATCH",
        "/preferences",
        {"recent_topic_enabled": True, "expected_version": current_version},
    )
    assert repeated.status_code == 200, repeated.text
    repeated = repeated.json()
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}
    disabled = command(
        chat_client,
        "PATCH",
        "/preferences",
        {"recent_topic_enabled": False, "expected_version": repeated["version"]},
    ).json()
    assert disabled["recent_topic_enabled"] is False
    command(
        chat_client,
        "PATCH",
        "/preferences",
        {"recent_topic_enabled": True, "expected_version": disabled["version"]},
    )
    assert (
        chat_client.get(PREFIX + "/recent-topic").json()["item"]["summary_version"]
        == topic["summary_version"]
    )
    send(chat_client, session["id"], "新的一轮")
    run_one(chat_client)
    assert_error(
        command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/topic-dismissals",
            {"summary_version": topic["summary_version"]},
        ),
        409,
        "TOPIC_STALE",
    )
    assert command(chat_client, "DELETE", f"/sessions/{session['id']}").status_code == 204
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}


@pytest.mark.parametrize("admin", [False, True])
def test_all_nested_resources_are_404_for_other_users_even_admin(chat_client, chat_database, admin):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    gen_path = generation_path(session["id"], accepted["generation"]["id"])
    command(chat_client, "POST", gen_path + "/cancel", {})
    other = identity(chat_client, "chat-other@example.com")
    if admin:
        with chat_database[0].begin() as db:
            db.execute(update(User).where(User.id == UUID(other["id"])).values(role="admin"))
        assert chat_client.get("/api/v1/auth/me").json()["role"] == "admin"
    requests = [
        ("GET", f"/sessions/{session['id']}", None),
        ("GET", f"/sessions/{session['id']}/messages", None),
        ("GET", gen_path, None),
        ("GET", gen_path + "/events", None),
        ("PATCH", f"/sessions/{session['id']}", {"title": "别人的", "expected_version": 1}),
        ("DELETE", f"/sessions/{session['id']}", None),
        (
            "POST",
            f"/sessions/{session['id']}/messages",
            {"client_message_id": str(uuid4()), "content": "x"},
        ),
        ("POST", gen_path + "/cancel", {}),
        (
            "POST",
            f"/sessions/{session['id']}/generations",
            {"retry_of_generation_id": accepted["generation"]["id"]},
        ),
        (
            "POST",
            f"/sessions/{session['id']}/topic-dismissals",
            {"summary_version": "foreign-version"},
        ),
    ]
    for method, path, payload in requests:
        response = (
            chat_client.get(PREFIX + path, headers={"Last-Event-ID": "malformed"})
            if method == "GET"
            else command(chat_client, method, path, payload, key=str(uuid4()))
        )
        assert_error(response, 404, "RESOURCE_NOT_FOUND")
    assert_error(
        command(
            chat_client,
            "POST",
            "/sessions",
            {"companion_id": session["companion_id"]},
            key=str(uuid4()),
        ),
        404,
        "RESOURCE_NOT_FOUND",
    )
    assert chat_client.get(PREFIX + "/sessions").json()["items"] == []
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}
    assert chat_client.get(PREFIX + "/preferences").json()["recent_topic_enabled"] is False


def test_anonymous_reads_and_commands_require_cookie_auth(chat_client):
    session_id, generation_id = str(uuid4()), str(uuid4())
    gen_path = generation_path(session_id, generation_id)
    for path in [
        "/sessions",
        f"/sessions/{session_id}",
        f"/sessions/{session_id}/messages",
        gen_path,
        gen_path + "/events",
        "/preferences",
        "/recent-topic",
    ]:
        assert_error(chat_client.get(PREFIX + path), 401, "AUTHENTICATION_REQUIRED")
    for method, path, payload in [
        ("POST", "/sessions", {}),
        ("PATCH", f"/sessions/{session_id}", {"title": "x", "expected_version": 1}),
        ("DELETE", f"/sessions/{session_id}", None),
        (
            "POST",
            f"/sessions/{session_id}/messages",
            {"client_message_id": str(uuid4()), "content": "x"},
        ),
        ("POST", f"/sessions/{session_id}/generations", {"retry_of_generation_id": generation_id}),
        ("POST", gen_path + "/cancel", {}),
        ("PATCH", "/preferences", {"recent_topic_enabled": True, "expected_version": 0}),
        ("POST", f"/sessions/{session_id}/topic-dismissals", {"summary_version": "x"}),
    ]:
        assert_error(
            chat_client.request(
                method, PREFIX + path, json=payload, headers={"Idempotency-Key": str(uuid4())}
            ),
            401,
            "AUTHENTICATION_REQUIRED",
        )


def test_every_chat_write_keeps_csrf_protection(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    gen_path = generation_path(session["id"], accepted["generation"]["id"])
    for method, path, payload in [
        ("POST", "/sessions", {}),
        ("PATCH", f"/sessions/{session['id']}", {"title": "x", "expected_version": 1}),
        ("DELETE", f"/sessions/{session['id']}", None),
        (
            "POST",
            f"/sessions/{session['id']}/messages",
            {"client_message_id": str(uuid4()), "content": "x"},
        ),
        (
            "POST",
            f"/sessions/{session['id']}/generations",
            {"retry_of_generation_id": accepted["generation"]["id"]},
        ),
        ("POST", gen_path + "/cancel", {}),
        ("PATCH", "/preferences", {"recent_topic_enabled": True, "expected_version": 0}),
        ("POST", f"/sessions/{session['id']}/topic-dismissals", {"summary_version": "x"}),
    ]:
        assert_error(
            chat_client.request(
                method, PREFIX + path, json=payload, headers={"Idempotency-Key": str(uuid4())}
            ),
            403,
            "CSRF_REJECTED",
        )


def test_validation_rejects_privilege_fields_bad_ids_limits_and_keys(chat_client):
    identity(chat_client)
    for field in ["owner_id", "user_id", "role", "provider", "model", "system_prompt"]:
        assert_error(
            command(chat_client, "POST", "/sessions", {field: str(uuid4())}, key=str(uuid4())),
            422,
            "VALIDATION_ERROR",
        )
    for title in [" \r\n ", "字" * 121]:
        response = command(chat_client, "POST", "/sessions", {"title": title}, key=str(uuid4()))
        assert_error(response, 422, "VALIDATION_ERROR")
        assert title not in response.text
    for key in [None, "short", "x" * 121]:
        assert_error(
            command(chat_client, "POST", "/sessions", {}, key=key), 422, "VALIDATION_ERROR"
        )
    for limit in [0, 101, "bad"]:
        assert_error(
            chat_client.get(PREFIX + "/sessions", params={"limit": limit}), 422, "VALIDATION_ERROR"
        )
    for cursor in ["not-base64", "x" * 1025]:
        assert_error(
            chat_client.get(PREFIX + "/sessions", params={"cursor": cursor}), 422, "INVALID_CURSOR"
        )
    session = create_session(chat_client)
    for content in ["\r\n ", "🧪" * 4001]:
        response = command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/messages",
            {"client_message_id": str(uuid4()), "content": content},
            key=str(uuid4()),
        )
        assert_error(response, 422, "VALIDATION_ERROR")
        assert content not in response.text
    accepted = send(chat_client, session["id"], "🧪" * 4000)
    assert len(accepted["user_message"]["content"]) == 4000


def test_cursor_versions_and_integer_boundaries_are_validated_before_sql(chat_client):
    user = identity(chat_client)
    session = create_session(chat_client)
    send(chat_client, session["id"])
    cursor_base = {
        "v": 1,
        "kind": "messages",
        "owner": user["id"],
        "session": session["id"],
        "before": 1,
        "max": 1,
    }
    for changes in [{"v": True}, {"v": 1.0}, {"before": True}, {"max": 2**64}]:
        cursor = base64.urlsafe_b64encode(json.dumps(cursor_base | changes).encode()).decode()
        assert_error(
            chat_client.get(
                PREFIX + f"/sessions/{session['id']}/messages", params={"cursor": cursor}
            ),
            422,
            "INVALID_CURSOR",
        )


def test_delete_cancels_queued_job_and_hides_all_nested_reads(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    gen_path = generation_path(session["id"], accepted["generation"]["id"])
    assert command(chat_client, "DELETE", f"/sessions/{session['id']}").status_code == 204
    for path in [
        f"/sessions/{session['id']}",
        f"/sessions/{session['id']}/messages",
        gen_path,
        gen_path + "/events",
    ]:
        assert_error(chat_client.get(PREFIX + path), 404, "RESOURCE_NOT_FOUND")
    assert not chat_client.portal.call(chat_client.app.state.chat_runner.run_once)


def test_user_capacity_is_bounded_and_idempotent_replay_still_succeeds(chat_client):
    identity(chat_client)
    sessions = [create_session(chat_client) for _ in range(3)]
    key, client_id = str(uuid4()), str(uuid4())
    first = send(chat_client, sessions[0]["id"], key=key, client_message_id=client_id)
    send(chat_client, sessions[1]["id"])
    rejected = command(
        chat_client,
        "POST",
        f"/sessions/{sessions[2]['id']}/messages",
        {"client_message_id": str(uuid4()), "content": "超出本人活跃任务上限"},
        key=str(uuid4()),
    )
    assert_error(rejected, 429, "CHAT_CAPACITY_LIMIT")
    assert int(rejected.headers["retry-after"]) > 0
    replay = send(chat_client, sessions[0]["id"], key=key, client_message_id=client_id)
    assert replay["generation"]["id"] == first["generation"]["id"]
    assert replay["idempotent_replay"] is True
    assert chat_client.get(PREFIX + f"/sessions/{sessions[2]['id']}/messages").json()["items"] == []


def test_cancelled_latest_input_is_not_a_recent_topic_and_old_round_cannot_retry(chat_client):
    identity(chat_client)
    command(
        chat_client,
        "PATCH",
        "/preferences",
        {"recent_topic_enabled": True, "expected_version": 0},
    )
    session = create_session(chat_client)
    first = send(chat_client, session["id"], "成功来源")
    run_one(chat_client)
    cancelled = send(chat_client, session["id"], "取消后不得成为推荐来源")
    command(
        chat_client,
        "POST",
        generation_path(session["id"], cancelled["generation"]["id"]) + "/cancel",
        {},
    )
    topic = chat_client.get(PREFIX + "/recent-topic").json()["item"]
    assert topic["summary"] == "成功来源"
    assert topic["source_message_ids"] == [
        first["user_message"]["id"],
        first["assistant_message"]["id"],
    ]
    send(chat_client, session["id"], "更新的输入")
    run_one(chat_client)
    assert_error(
        command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/generations",
            {"retry_of_generation_id": cancelled["generation"]["id"]},
            key=str(uuid4()),
        ),
        409,
        "RETRY_NOT_ALLOWED",
    )


def test_logical_delete_preserves_existing_memory_and_usage_foreign_keys(
    chat_client, chat_database
):
    user = identity(chat_client)
    session = create_session(chat_client)
    owner_id, wallet_id, memory_id, usage_id = UUID(user["id"]), uuid4(), uuid4(), uuid4()
    wallets = Base.metadata.tables["wallets"]
    memories = Base.metadata.tables["memories"]
    usage = Base.metadata.tables["usage_records"]
    with chat_database[0].begin() as db:
        db.execute(
            wallets.insert().values(id=wallet_id, owner_id=owner_id, balance=137, reserved=17)
        )
        db.execute(
            memories.insert().values(
                id=memory_id,
                owner_id=owner_id,
                source_session_id=UUID(session["id"]),
                content="测试已有、明确授权的记忆",
                consent_granted_at=datetime.now(UTC),
            )
        )
        db.execute(
            usage.insert().values(
                id=usage_id,
                owner_id=owner_id,
                wallet_id=wallet_id,
                session_id=UUID(session["id"]),
                provider="legacy-test",
                model="legacy-test",
                input_tokens=12,
                output_tokens=34,
                idempotency_key=str(uuid4()),
            )
        )
        before = {
            table.name: db.execute(select(table)).all() for table in [wallets, memories, usage]
        }
    send(chat_client, session["id"])
    run_one(chat_client)
    assert command(chat_client, "DELETE", f"/sessions/{session['id']}").status_code == 204
    with chat_database[0].connect() as db:
        assert {
            table.name: db.execute(select(table)).all() for table in [wallets, memories, usage]
        } == before


def test_legacy_prompt_alias_is_pinned_and_unknown_prompt_fails_before_acceptance(
    chat_client, chat_database
):
    identity(chat_client)
    session = create_session(chat_client)
    companion_id = UUID(session["companion_id"])
    with chat_database[0].begin() as db:
        db.execute(
            update(AICompanion).where(AICompanion.id == companion_id).values(prompt_version="v1")
        )
    accepted = send(chat_client, session["id"])
    assert accepted["generation"]["prompt_version"] == "companion-v1"
    run_one(chat_client)
    with chat_database[0].begin() as db:
        db.execute(
            update(AICompanion)
            .where(AICompanion.id == companion_id)
            .values(prompt_version="unknown-version")
        )
    assert_error(
        command(
            chat_client,
            "POST",
            f"/sessions/{session['id']}/messages",
            {"client_message_id": str(uuid4()), "content": "未知提示词不应接受"},
            key=str(uuid4()),
        ),
        503,
        "PROMPT_UNAVAILABLE",
    )
    assert len(chat_client.get(PREFIX + f"/sessions/{session['id']}/messages").json()["items"]) == 2


@pytest.mark.parametrize("identifier", [123, ["not-a-uuid"]])
def test_session_cursor_uuid_type_errors_are_safe_validation_errors(chat_client, identifier):
    user = identity(chat_client)
    session = create_session(chat_client)
    cursor = base64.urlsafe_b64encode(
        json.dumps(
            {
                "v": 1,
                "kind": "sessions",
                "owner": user["id"],
                "at": session["last_activity_at"],
                "id": identifier,
            }
        ).encode()
    ).decode()
    assert_error(
        chat_client.get(PREFIX + "/sessions", params={"cursor": cursor}), 422, "INVALID_CURSOR"
    )


def test_deleted_dismissed_latest_topic_cannot_reveal_older_completed_conversation(chat_client):
    identity(chat_client)
    assert (
        command(
            chat_client,
            "PATCH",
            "/preferences",
            {"recent_topic_enabled": True, "expected_version": 0},
        ).status_code
        == 200
    )
    older = create_session(chat_client, "较早的会话")
    send(chat_client, older["id"], "较早来源不得替换刚隐藏的话题")
    run_one(chat_client)
    latest = create_session(chat_client, "最近的会话")
    send(chat_client, latest["id"], "用户明确隐藏的来源")
    run_one(chat_client)
    topic = chat_client.get(PREFIX + "/recent-topic").json()["item"]
    assert topic["conversation_id"] == latest["id"]
    assert (
        command(
            chat_client,
            "POST",
            f"/sessions/{latest['id']}/topic-dismissals",
            {"summary_version": topic["summary_version"]},
        ).status_code
        == 204
    )
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}
    assert command(chat_client, "DELETE", f"/sessions/{latest['id']}").status_code == 204
    assert chat_client.get(PREFIX + "/recent-topic").json() == {"item": None}
    new_round = send(chat_client, older["id"], "隐藏决定之后新完成的一轮可以出现")
    run_one(chat_client)
    visible = chat_client.get(PREFIX + "/recent-topic").json()["item"]
    assert visible["conversation_id"] == older["id"]
    assert visible["summary"] == "隐藏决定之后新完成的一轮可以出现"
    assert visible["source_message_ids"] == [
        new_round["user_message"]["id"],
        new_round["assistant_message"]["id"],
    ]
    assert visible["summary_version"] != topic["summary_version"]


def test_message_read_rechecks_tombstone_between_parent_check_and_child_query(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"], "删除竞态中的私人正文不能返回")
    run_one(chat_client)
    injected = False
    engine = chat_client.app.state.engine.sync_engine

    def delete_before_child_query(connection, cursor, statement, parameters, context, executemany):
        nonlocal injected
        if not injected and "FROM chat_messages" in statement:
            # The ownership SELECT has finished. Changing the row on this same
            # connection makes the race deterministic without another writer or sleep.
            injected = True
            connection.execute(
                update(ChatSession)
                .where(ChatSession.id == UUID(session["id"]))
                .values(deleted_at=datetime.now(UTC))
            )

    event.listen(engine, "before_cursor_execute", delete_before_child_query)
    try:
        response = chat_client.get(PREFIX + f"/sessions/{session['id']}/messages")
    finally:
        event.remove(engine, "before_cursor_execute", delete_before_child_query)
    assert injected
    assert response.status_code in {200, 404}, response.text
    if response.status_code == 200:
        assert response.json()["items"] == []
    else:
        assert_error(response, 404, "RESOURCE_NOT_FOUND")
    assert accepted["user_message"]["id"] not in response.text
    assert accepted["assistant_message"]["id"] not in response.text
    assert "删除竞态中的私人正文不能返回" not in response.text
