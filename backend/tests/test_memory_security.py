"""Owner, CSRF, privacy and truthful phase boundaries for P4-A memory APIs."""

import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf
from sqlalchemy import func, select, update
from test_memory_api import (
    CONSENT,
    PREFIX,
    account,
    command,
    correction_payload,
    create_item,
    enable,
    item_payload,
    preferences,
    use_account,
)
from test_memory_api import (
    memory_client as memory_client,
)

from app.modules.memory.models import Memory
from app.modules.users.models import User


@pytest.mark.parametrize(
    "path",
    [
        "/preferences",
        "/items",
        f"/items/{uuid4()}",
        f"/items/{uuid4()}/sources",
        "/changes",
    ],
)
def test_memory_anonymous_reads_require_authentication(memory_client, path):
    response = memory_client.get(PREFIX + path)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        (
            "PATCH",
            "/preferences",
            {"long_term_memory_enabled": True, "expected_version": 0, "consent": CONSENT},
        ),
        (
            "POST",
            "/items",
            {
                "title": "普通事项",
                "content": "希望了解后端岗位。",
                "category": "career_goal",
                "source": {"kind": "manual"},
                "expected_preferences_version": 1,
                "consent": CONSENT,
            },
        ),
        ("POST", "/clear", {"confirmed": True, "expected_revision": "0"}),
        ("POST", "/export", {"format": "json", "include_inactive": True}),
    ],
)
def test_memory_anonymous_commands_are_not_authorized_by_a_csrf_cookie(
    memory_client, method, path, payload
):
    response = command(memory_client, method, path, payload)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("PATCH", "/preferences", {"long_term_memory_enabled": True, "expected_version": 0}),
        ("POST", "/items", {}),
        ("POST", "/clear", {"confirmed": True, "expected_revision": "0"}),
        ("POST", "/export", {"format": "json", "include_inactive": True}),
        ("POST", "/previews", {}),
        ("POST", "/retrieval-preview", {"query": "求职", "limit": 5}),
    ],
)
def test_memory_writes_and_computational_posts_require_csrf(memory_client, method, path, payload):
    account(memory_client)
    response = memory_client.request(
        method,
        PREFIX + path,
        json=payload,
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CSRF_REJECTED"


def test_memory_authenticated_cross_site_write_is_rejected(memory_client):
    account(memory_client)
    enable(memory_client)
    headers = csrf(memory_client) | {
        "Origin": "https://untrusted.example",
        "Sec-Fetch-Site": "cross-site",
        "Idempotency-Key": str(uuid4()),
    }
    response = memory_client.post(
        PREFIX + "/items", json=item_payload(memory_client), headers=headers
    )
    assert response.status_code == 403


def test_private_memory_is_owner_filtered_even_for_admin(memory_client, auth_database):
    first, cookie_a = account(memory_client)
    enable(memory_client)
    own = create_item(memory_client, content="账号A确认的普通求职事项。")
    memory_client.cookies.clear()
    second, cookie_b = account(memory_client, "other-memory@example.com")
    enable(memory_client)
    other = create_item(memory_client, content="账号B确认的普通求职事项。")
    with auth_database[0].begin() as db:
        db.execute(update(User).where(User.id == UUID(first["id"])).values(role="admin"))
    use_account(memory_client, cookie_a)
    assert memory_client.get(f"{PREFIX}/items/{own['id']}").status_code == 200
    for suffix in ("", "/sources"):
        foreign = memory_client.get(f"{PREFIX}/items/{other['id']}{suffix}")
        missing = memory_client.get(f"{PREFIX}/items/{uuid4()}{suffix}")
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json()["error"] == missing.json()["error"]
        assert other["content"] not in foreign.text
    assert [row["id"] for row in memory_client.get(f"{PREFIX}/items").json()["items"]] == [
        own["id"]
    ]
    patch = command(
        memory_client,
        "PATCH",
        f"/items/{other['id']}",
        correction_payload(memory_client, other, content="不应修改另一账号。"),
    )
    assert patch.status_code == 404
    revoke = command(
        memory_client,
        "POST",
        f"/items/{other['id']}/revocations",
        {"expected_version": other["version"]},
    )
    assert revoke.status_code == 404
    delete = command(
        memory_client,
        "DELETE",
        f"/items/{other['id']}",
        {"expected_version": other["version"]},
    )
    assert delete.status_code == 404
    use_account(memory_client, cookie_b)
    assert memory_client.get(f"{PREFIX}/items/{own['id']}").status_code == 404
    assert memory_client.get(f"{PREFIX}/items/{other['id']}").json()["content"] == other["content"]
    assert first["id"] != second["id"]


def test_same_idempotency_key_is_isolated_between_accounts(memory_client):
    _, cookie_a = account(memory_client)
    enable(memory_client)
    key = str(uuid4())
    first = create_item(memory_client, key=key)
    memory_client.cookies.clear()
    _, cookie_b = account(memory_client, "same-key-memory@example.com")
    enable(memory_client)
    second = create_item(memory_client, key=key)
    assert first["id"] != second["id"]
    assert memory_client.get(f"{PREFIX}/items/{first['id']}").status_code == 404
    use_account(memory_client, cookie_a)
    assert memory_client.get(f"{PREFIX}/items/{second['id']}").status_code == 404
    use_account(memory_client, cookie_b)
    assert memory_client.get(f"{PREFIX}/items/{second['id']}").status_code == 200


def test_foreign_sync_cursor_cannot_read_another_owner_events(memory_client):
    _, cookie_a = account(memory_client)
    enable(memory_client)
    a_cursor = preferences(memory_client)["sync_cursor"]
    create_item(memory_client, content="A的变更不能通过B读取。")
    memory_client.cookies.clear()
    account(memory_client, "cursor-memory@example.com")
    enable(memory_client)
    response = memory_client.get(f"{PREFIX}/changes", params={"cursor": a_cursor})
    assert response.status_code == 422
    assert "A的变更" not in response.text
    use_account(memory_client, cookie_a)
    own = memory_client.get(f"{PREFIX}/changes", params={"cursor": a_cursor})
    assert own.status_code == 200 and len(own.json()["items"]) == 1


@pytest.mark.parametrize("extra", ["owner_id", "user_id", "provider", "system_prompt"])
def test_memory_create_rejects_privileged_request_fields(memory_client, extra):
    account(memory_client)
    enable(memory_client)
    response = command(
        memory_client, "POST", "/items", item_payload(memory_client, **{extra: str(uuid4())})
    )
    assert response.status_code == 422
    assert memory_client.get(f"{PREFIX}/items").json()["items"] == []


@pytest.mark.parametrize("key", ["", "short", "a" * 121])
def test_memory_persistent_commands_require_bounded_idempotency_key(memory_client, key):
    account(memory_client)
    enable(memory_client)
    response = command(memory_client, "POST", "/items", item_payload(memory_client), key=key)
    assert response.status_code == 422


@pytest.mark.parametrize(
    "content",
    [
        "请记住密码是 SyntheticPasswordForTestingOnly!2026。",
        "请记住身份证号码 110101199001011234。",
        "我的 API key 是 sk-p4a-synthetic-not-a-real-key-123456789。",
        "我被诊断为抑郁症，请长期记录诊断。",
    ],
)
def test_sensitive_memory_is_not_persisted_or_echoed(memory_client, auth_database, content):
    account(memory_client)
    enable(memory_client)
    response = command(
        memory_client, "POST", "/items", item_payload(memory_client, content=content)
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SENSITIVE_MEMORY_REJECTED"
    assert content not in response.text
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 0


@pytest.mark.parametrize("days", [-1, 366])
def test_expiration_must_be_future_and_bounded(memory_client, days):
    account(memory_client)
    enable(memory_client)
    expiry = (datetime.now(UTC) + timedelta(days=days)).isoformat()
    response = command(
        memory_client, "POST", "/items", item_payload(memory_client, expires_at=expiry)
    )
    assert response.status_code == 422


def test_memory_body_and_historical_plaintext_are_absent_from_logs(memory_client, caplog):
    caplog.set_level(logging.INFO)
    account(memory_client)
    enable(memory_client)
    private = "这条求职偏好只用于日志回归，不应出现在日志中。"
    revised = "修正后的求职偏好也不应出现在日志中。"
    item = create_item(memory_client, content=private)
    changed = command(
        memory_client,
        "PATCH",
        f"/items/{item['id']}",
        correction_payload(memory_client, item, content=revised),
    )
    assert changed.status_code == 200
    assert (
        command(
            memory_client,
            "DELETE",
            f"/items/{item['id']}",
            {"expected_version": changed.json()["version"]},
        ).status_code
        == 204
    )
    assert private not in caplog.text and revised not in caplog.text
    assert memory_client.cookies.get("weibiye_session") not in caplog.text
    assert csrf(memory_client)["X-CSRF-Token"] not in caplog.text


def test_long_term_and_recent_topic_authorization_remain_independent(memory_client):
    account(memory_client)
    topic = memory_client.patch(
        "/api/v1/companion/preferences",
        json={"recent_topic_enabled": True, "expected_version": 0},
        headers=csrf(memory_client),
    )
    assert topic.status_code == 200
    assert preferences(memory_client)["long_term_memory_enabled"] is False
    state = enable(memory_client)
    assert memory_client.get("/api/v1/companion/preferences").json()["recent_topic_enabled"] is True
    assert (
        command(
            memory_client,
            "PATCH",
            "/preferences",
            {"long_term_memory_enabled": False, "expected_version": state["version"]},
        ).status_code
        == 200
    )
    assert memory_client.get("/api/v1/companion/preferences").json()["recent_topic_enabled"] is True


def test_preview_and_retrieval_validate_sources_without_fact_writes(memory_client, auth_database):
    account(memory_client)
    enable(memory_client)
    requests = [
        (
            "/previews",
            {
                "session_id": str(uuid4()),
                "message_ids": [str(uuid4())],
                "expected_preferences_version": preferences(memory_client)["version"],
                "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
            },
        ),
        (
            "/retrieval-preview",
            {"query": "后端岗位", "limit": 5, "expected_preferences_version": 1},
        ),
    ]
    for path, payload in requests:
        response = command(memory_client, "POST", path, payload)
        if path == "/previews":
            assert response.status_code == 404
            assert response.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        else:
            assert response.status_code == 200
            assert response.json()["items"] == []
    payload = item_payload(
        memory_client,
        source={
            "kind": "chat_message",
            "session_id": str(uuid4()),
            "message_ids": [str(uuid4())],
            "preview_token": "not-an-authorized-preview-token",
        },
    )
    response = command(memory_client, "POST", "/items", payload)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 0
        assert db.exec_driver_sql("SELECT count(*) FROM memory_generation_refs").scalar_one() == 0


def test_legacy_memory_can_be_managed_but_not_injected_or_reconfirmed_in_place(
    memory_client, auth_database
):
    user, _ = account(memory_client)
    enable(memory_client)
    memory_id = uuid4()
    with auth_database[0].begin() as db:
        db.execute(
            Memory.__table__.insert().values(
                id=memory_id,
                owner_id=UUID(user["id"]),
                content="旧版明确授权证据缺失的普通事项。",
                consent_granted_at=datetime.now(UTC),
            )
        )
    detail = memory_client.get(f"{PREFIX}/items/{memory_id}")
    assert detail.status_code == 200 and detail.json()["status"] == "legacy_unconfirmed"
    assert memory_client.get(PREFIX).json() == []
    assert memory_client.get(f"{PREFIX}/{memory_id}").status_code == 404
    response = command(
        memory_client,
        "POST",
        f"/items/{memory_id}/confirm",
        {
            "title": "重新确认",
            "content": detail.json()["content"],
            "category": "explicit_note",
            "expected_version": detail.json()["version"],
            "expected_preferences_version": preferences(memory_client)["version"],
            "consent": CONSENT,
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SOURCE_UNAVAILABLE"


def test_deleted_memory_is_not_exposed_in_changes_or_audit_plaintext(memory_client, auth_database):
    account(memory_client)
    enable(memory_client)
    cursor = preferences(memory_client)["sync_cursor"]
    private = "只能存于当前记忆行，不能复制到审计记录的普通偏好。"
    item = create_item(memory_client, content=private)
    assert (
        command(
            memory_client,
            "DELETE",
            f"/items/{item['id']}",
            {"expected_version": item["version"]},
        ).status_code
        == 204
    )
    response = memory_client.get(f"{PREFIX}/changes", params={"cursor": cursor})
    assert response.status_code == 200
    assert private not in response.text
    assert "deleted" in {row["action"] for row in response.json()["items"]}
    with auth_database[0].connect() as db:
        for table in ("memory_consent_events", "memory_operations", "memory_generation_refs"):
            rows = db.exec_driver_sql(f"SELECT * FROM {table}").mappings().all()
            assert private not in repr(rows)


def test_auth_redis_failure_has_no_privacy_operation_bypass(memory_client):
    from redis.exceptions import ConnectionError

    from app.modules.auth.store import AuthStore

    account(memory_client)
    enable(memory_client)
    item = create_item(memory_client)
    headers = csrf(memory_client) | {"Idempotency-Key": str(uuid4())}

    class Unavailable:
        async def get(self, *args):
            raise ConnectionError("synthetic-private-cache-error")

        async def eval(self, *args):
            raise ConnectionError("synthetic-private-cache-error")

    memory_client.app.state.auth_store = AuthStore(Unavailable())
    response = memory_client.request(
        "DELETE",
        f"{PREFIX}/items/{item['id']}",
        json={"expected_version": item["version"]},
        headers=headers,
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AUTH_STORE_UNAVAILABLE"
    assert "synthetic-private-cache-error" not in response.text
