"""P4-A memory management contracts against isolated, migrated SQLite databases."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf, login, register
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import func, select, update

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app
from app.modules.memory import service as memory_service
from app.modules.memory.models import Memory

PREFIX = "/api/v1/memory"
CONSENT = {
    "confirmed": True,
    "policy_version": "memory-policy/1",
    "notice_version": "memory-notice/1",
}
TEST_KEY = "p4a-isolated-test-hmac-key-not-for-production-2026"


@pytest.fixture
def memory_client(auth_database):
    _, base = auth_database
    settings = Settings(
        **(
            base.model_dump()
            | {
                "memory_management_enabled": True,
                "memory_injection_enabled": False,
                "memory_hmac_key": SecretStr(TEST_KEY),
                "chat_runner_enabled": False,
            }
        )
    )
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        yield client


def account(client, email="memory-a@example.com"):
    assert register(client, email=email).status_code == 202
    response = login(client, email=email)
    assert response.status_code == 200
    return response.json(), dict(client.cookies)


def use_account(client, cookies):
    client.cookies.clear()
    client.cookies.update(cookies)


def preferences(client):
    response = client.get(f"{PREFIX}/preferences")
    assert response.status_code == 200, response.text
    return response.json()


def command(client, method, path, payload=None, *, key=None):
    headers = csrf(client)
    if path not in {"/export", "/previews", "/retrieval-preview"}:
        headers["Idempotency-Key"] = key if key is not None else str(uuid4())
    return client.request(method, PREFIX + path, json=payload, headers=headers)


def enable(client):
    current = preferences(client)
    response = command(
        client,
        "PATCH",
        "/preferences",
        {
            "long_term_memory_enabled": True,
            "expected_version": current["version"],
            "consent": CONSENT,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def item_payload(client, **changes):
    return {
        "title": "求职方向",
        "content": "希望优先了解后端开发岗位。",
        "category": "career_goal",
        "source": {"kind": "manual"},
        "expected_preferences_version": preferences(client)["version"],
        "consent": CONSENT,
    } | changes


def create_item(client, *, key=None, **changes):
    response = command(client, "POST", "/items", item_payload(client, **changes), key=key)
    assert response.status_code == 201, response.text
    assert response.json()["idempotent_replay"] is False
    return response.json()["item"]


def correction_payload(client, item, **changes):
    return {
        "title": item["title"],
        "content": item["content"],
        "category": item["category"],
        "expires_at": item["expires_at"],
        "expected_version": item["version"],
        "expected_preferences_version": preferences(client)["version"],
        "consent": CONSENT,
    } | changes


def test_memory_defaults_are_virtual_disabled_without_user_memory_writes(
    memory_client, auth_database
):
    account(memory_client)
    result = preferences(memory_client)
    assert result["long_term_memory_enabled"] is False
    assert result["version"] == 0
    assert result["privacy_epoch"] == result["context_epoch_floor"] == result["revision"] == "0"
    assert isinstance(result["sync_cursor"], str) and result["sync_cursor"]
    assert memory_client.get(f"{PREFIX}/items").json()["items"] == []
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 0
        assert db.exec_driver_sql("SELECT count(*) FROM memory_preferences").scalar_one() == 0
        assert db.exec_driver_sql("SELECT count(*) FROM memory_consent_events").scalar_one() == 0


def test_explicit_authorization_and_revocation_have_separate_versions(memory_client, auth_database):
    account(memory_client)
    initial = enable(memory_client)
    assert initial["long_term_memory_enabled"] is True and initial["version"] == 1
    assert int(initial["privacy_epoch"]) > 0
    assert initial["context_epoch_floor"] == "0"
    assert (
        memory_client.get("/api/v1/companion/preferences").json()["recent_topic_enabled"] is False
    )
    item = create_item(memory_client)
    after_create = preferences(memory_client)
    assert after_create["version"] == initial["version"]
    assert int(after_create["privacy_epoch"]) > int(initial["privacy_epoch"])
    closed = command(
        memory_client,
        "PATCH",
        "/preferences",
        {"long_term_memory_enabled": False, "expected_version": after_create["version"]},
    )
    assert closed.status_code == 200
    state = closed.json()
    assert state["long_term_memory_enabled"] is False and state["version"] == 2
    assert state["context_epoch_floor"] == state["privacy_epoch"]
    assert memory_client.get(f"{PREFIX}/items/{item['id']}").json()["status"] == "revoked"
    enabled_again = enable(memory_client)
    assert enabled_again["context_epoch_floor"] == state["context_epoch_floor"]
    assert memory_client.get(f"{PREFIX}/items/{item['id']}").json()["status"] == "revoked"
    with auth_database[0].connect() as db:
        actions = (
            db.exec_driver_sql("SELECT action FROM memory_consent_events ORDER BY revision")
            .scalars()
            .all()
        )
    assert "enabled" in actions and "disabled" in actions and "confirmed" in actions


def test_disabled_and_unconfirmed_creation_are_rejected_without_fact_writes(
    memory_client, auth_database
):
    account(memory_client)
    response = command(memory_client, "POST", "/items", item_payload(memory_client))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "MEMORY_DISABLED"
    enable(memory_client)
    payload = item_payload(memory_client)
    payload["consent"] = dict(CONSENT, confirmed=False)
    denied = command(memory_client, "POST", "/items", payload)
    assert denied.status_code == 422
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 0
        assert db.exec_driver_sql("SELECT count(*) FROM memory_sources").scalar_one() == 0


@pytest.mark.parametrize("confirmed", [1, "true"])
def test_authorization_requires_an_actual_boolean_confirmation(memory_client, confirmed):
    account(memory_client)
    response = command(
        memory_client,
        "PATCH",
        "/preferences",
        {
            "long_term_memory_enabled": True,
            "expected_version": 0,
            "consent": dict(CONSENT, confirmed=confirmed),
        },
    )
    assert response.status_code == 422
    state = preferences(memory_client)
    assert state["long_term_memory_enabled"] is False and state["version"] == 0


@pytest.mark.parametrize("confirmed", [1, "true"])
def test_memory_creation_requires_an_actual_boolean_confirmation(memory_client, confirmed):
    account(memory_client)
    enable(memory_client)
    response = command(
        memory_client,
        "POST",
        "/items",
        item_payload(memory_client, consent=dict(CONSENT, confirmed=confirmed)),
    )
    assert response.status_code == 422
    assert memory_client.get(f"{PREFIX}/items").json()["items"] == []


def test_manual_memory_crud_sources_and_actual_erasure(memory_client, auth_database):
    account(memory_client)
    enable(memory_client)
    original = create_item(memory_client, content="  希望了解后端岗位。\r\n可以简洁一点。  ")
    assert original["content"] == "希望了解后端岗位。\n可以简洁一点。"
    assert original["status"] == "active" and original["version"] == 1
    assert original["consent_ref"] is not None
    assert original["expires_at"]
    detail = memory_client.get(f"{PREFIX}/items/{original['id']}")
    assert detail.status_code == 200 and detail.json()["content"] == original["content"]
    assert "no-store" in detail.headers["cache-control"]
    listed = memory_client.get(f"{PREFIX}/items").json()
    assert [row["id"] for row in listed["items"]] == [original["id"]]
    source = memory_client.get(f"{PREFIX}/items/{original['id']}/sources")
    assert source.status_code == 200 and source.json()["items"][0]["kind"] == "manual"
    assert source.json()["items"][0]["session_id"] is None
    changed = command(
        memory_client,
        "PATCH",
        f"/items/{original['id']}",
        correction_payload(memory_client, original, content="现在希望了解测试开发岗位。"),
    )
    assert changed.status_code == 200, changed.text
    revised = changed.json()
    assert revised["version"] == 2 and revised["content"] != original["content"]
    assert revised["consent_ref"] != original["consent_ref"]
    removed = command(
        memory_client,
        "DELETE",
        f"/items/{original['id']}",
        {"expected_version": revised["version"]},
    )
    assert removed.status_code == 204 and not removed.content
    assert memory_client.get(f"{PREFIX}/items/{original['id']}").status_code == 404
    assert memory_client.get(f"{PREFIX}/items/{original['id']}/sources").status_code == 404
    assert memory_client.get(f"{PREFIX}/items").json()["items"] == []
    with auth_database[0].connect() as db:
        saved = db.execute(select(Memory.__table__)).mappings().one()
        assert saved["status"] == "deleted" and saved["deleted_at"] is not None
        assert saved["content"] == saved["title"] == saved["summary"] == ""
        assert saved["active_consent_id"] is None


def test_stale_item_and_preferences_versions_do_not_overwrite(memory_client):
    account(memory_client)
    enable(memory_client)
    first = create_item(memory_client)
    changed = command(
        memory_client,
        "PATCH",
        f"/items/{first['id']}",
        correction_payload(memory_client, first, content="偏好简洁的建议。"),
    )
    assert changed.status_code == 200
    conflict = command(
        memory_client,
        "PATCH",
        f"/items/{first['id']}",
        correction_payload(memory_client, first, content="不应覆盖成功修改。"),
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "VERSION_CONFLICT"
    assert (
        memory_client.get(f"{PREFIX}/items/{first['id']}").json()["content"] == "偏好简洁的建议。"
    )
    stale = command(
        memory_client,
        "PATCH",
        "/preferences",
        {"long_term_memory_enabled": False, "expected_version": 0},
    )
    assert stale.status_code == 409
    assert preferences(memory_client)["long_term_memory_enabled"] is True


def test_create_idempotency_replays_current_state_without_resurrection(
    memory_client, auth_database
):
    account(memory_client)
    enable(memory_client)
    key = str(uuid4())
    payload = item_payload(memory_client)
    created = command(memory_client, "POST", "/items", payload, key=key)
    assert created.status_code == 201
    item = created.json()["item"]
    replay = command(memory_client, "POST", "/items", payload, key=key)
    assert replay.status_code == 201
    assert replay.json()["item"]["id"] == item["id"]
    assert replay.json()["idempotent_replay"] is True
    conflict = command(
        memory_client, "POST", "/items", payload | {"content": "不同的确认内容。"}, key=key
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    removed = command(
        memory_client, "DELETE", f"/items/{item['id']}", {"expected_version": item["version"]}
    )
    assert removed.status_code == 204
    replay_deleted = command(memory_client, "POST", "/items", payload, key=key)
    assert replay_deleted.status_code == 410
    assert item["content"] not in replay_deleted.text
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 1
        assert db.scalar(select(Memory.content)) == ""


def test_committed_create_replays_do_not_consume_business_write_limit(memory_client, auth_database):
    account(memory_client)
    enable(memory_client)
    payload = item_payload(memory_client)
    key = str(uuid4())
    response = command(memory_client, "POST", "/items", payload, key=key)
    assert response.status_code == 201
    first = response.json()["item"]
    revision = preferences(memory_client)["revision"]
    for _ in range(25):
        replay = command(memory_client, "POST", "/items", payload, key=key)
        assert replay.status_code == 201, replay.text
        assert replay.json()["idempotent_replay"] is True
        assert replay.json()["item"]["id"] == first["id"]
    assert preferences(memory_client)["revision"] == revision
    second = create_item(memory_client, content="重放之后仍可明确保存新事项。")
    assert second["id"] != first["id"]
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 2


def test_long_memory_summary_marks_truncation_without_truncating_stored_content(memory_client):
    account(memory_client)
    enable(memory_client)
    content = "希望了解后端开发岗位，并且逐步准备。" * 25 + "这句尾部必须完整保留。"
    assert 240 < len(content) <= 1000
    item = create_item(memory_client, content=content)
    assert item["content"] == content
    assert len(item["summary"]) <= 240 and item["summary"].endswith("…")
    assert content.startswith(item["summary"][:-1])
    revised_content = "更希望了解测试开发岗位，并且循序准备。" * 25 + "修正后的尾部也需要保留。"
    assert 240 < len(revised_content) <= 1000
    response = command(
        memory_client,
        "PATCH",
        f"/items/{item['id']}",
        correction_payload(memory_client, item, content=revised_content),
    )
    assert response.status_code == 200, response.text
    revised = response.json()
    assert revised["content"] == revised_content
    assert len(revised["summary"]) <= 240 and revised["summary"].endswith("…")
    assert revised_content.startswith(revised["summary"][:-1])
    assert memory_client.get(f"{PREFIX}/items/{item['id']}").json()["content"] == revised_content


def test_revoked_memory_requires_explicit_same_source_reconfirmation(memory_client):
    account(memory_client)
    enable(memory_client)
    item = create_item(memory_client)
    revoked = command(
        memory_client,
        "POST",
        f"/items/{item['id']}/revocations",
        {"expected_version": item["version"]},
    )
    assert revoked.status_code == 200 and revoked.json()["status"] == "revoked"
    assert "content" not in revoked.json()
    retained = memory_client.get(f"{PREFIX}/items/{item['id']}").json()
    assert retained["content"] == item["content"]
    assert memory_client.get(f"{PREFIX}/{item['id']}").status_code == 404
    confirmed = command(
        memory_client,
        "POST",
        f"/items/{item['id']}/confirm",
        correction_payload(memory_client, retained),
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["id"] == item["id"] and confirmed.json()["status"] == "active"
    assert confirmed.json()["version"] > retained["version"]


def test_export_while_disabled_contains_only_current_non_deleted_content(memory_client):
    account(memory_client)
    enable(memory_client)
    first = create_item(memory_client, content="可导出的交流偏好。")
    removed = create_item(memory_client, content="删除后不可导出的内容。")
    assert (
        command(
            memory_client,
            "DELETE",
            f"/items/{removed['id']}",
            {"expected_version": removed["version"]},
        ).status_code
        == 204
    )
    current = preferences(memory_client)
    assert (
        command(
            memory_client,
            "PATCH",
            "/preferences",
            {"long_term_memory_enabled": False, "expected_version": current["version"]},
        ).status_code
        == 200
    )
    response = command(
        memory_client, "POST", "/export", {"format": "json", "include_inactive": True}
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["schema_version"] and result["exported_at"]
    assert isinstance(result["snapshot_revision"], str)
    assert [item["id"] for item in result["items"]] == [first["id"]]
    assert result["items"][0]["status"] == "revoked"
    assert removed["content"] not in response.text
    assert not any(word in response.text for word in ("password_hash", "csrf_hash", "token_hash"))
    assert "no-store" in response.headers["cache-control"]
    assert "attachment" in response.headers["content-disposition"]
    active_only = command(
        memory_client, "POST", "/export", {"format": "json", "include_inactive": False}
    )
    assert active_only.status_code == 200 and active_only.json()["items"] == []


def test_clear_is_owner_scoped_and_keeps_both_authorization_settings(memory_client):
    first, cookie_a = account(memory_client)
    enable(memory_client)
    create_item(memory_client, content="账号A的第一条普通事项。")
    create_item(memory_client, content="账号A的第二条普通事项。")
    topic = memory_client.patch(
        "/api/v1/companion/preferences",
        json={"recent_topic_enabled": True, "expected_version": 0},
        headers=csrf(memory_client),
    )
    assert topic.status_code == 200
    memory_client.cookies.clear()
    second, cookie_b = account(memory_client, "memory-b@example.com")
    assert first["id"] != second["id"]
    enable(memory_client)
    other = create_item(memory_client, content="账号B的普通事项。")
    use_account(memory_client, cookie_a)
    before = preferences(memory_client)
    response = command(
        memory_client,
        "POST",
        "/clear",
        {"confirmed": True, "expected_revision": before["revision"]},
    )
    assert response.status_code == 204, response.text
    after = preferences(memory_client)
    assert after["long_term_memory_enabled"] is True
    assert after["version"] == before["version"]
    assert int(after["context_epoch_floor"]) > int(before["context_epoch_floor"])
    assert memory_client.get(f"{PREFIX}/items").json()["items"] == []
    assert memory_client.get("/api/v1/companion/preferences").json()["recent_topic_enabled"] is True
    use_account(memory_client, cookie_b)
    assert memory_client.get(f"{PREFIX}/items/{other['id']}").status_code == 200
    assert preferences(memory_client)["long_term_memory_enabled"] is True


def test_clear_requires_confirmation_and_current_revision(memory_client):
    account(memory_client)
    enable(memory_client)
    before = preferences(memory_client)
    item = create_item(memory_client)
    denied = command(
        memory_client,
        "POST",
        "/clear",
        {"confirmed": False, "expected_revision": preferences(memory_client)["revision"]},
    )
    assert denied.status_code == 422
    conflict = command(
        memory_client,
        "POST",
        "/clear",
        {"confirmed": True, "expected_revision": before["revision"]},
    )
    assert conflict.status_code == 409
    assert memory_client.get(f"{PREFIX}/items/{item['id']}").status_code == 200


@pytest.mark.parametrize("confirmed", [1, "true"])
def test_clear_requires_an_actual_boolean_confirmation(memory_client, confirmed):
    account(memory_client)
    enable(memory_client)
    item = create_item(memory_client)
    response = command(
        memory_client,
        "POST",
        "/clear",
        {"confirmed": confirmed, "expected_revision": preferences(memory_client)["revision"]},
    )
    assert response.status_code == 422
    assert memory_client.get(f"{PREFIX}/items/{item['id']}").status_code == 200


def test_old_clear_replay_does_not_delete_memories_created_after_it(memory_client):
    account(memory_client)
    enable(memory_client)
    create_item(memory_client)
    payload = {"confirmed": True, "expected_revision": preferences(memory_client)["revision"]}
    key = str(uuid4())
    assert command(memory_client, "POST", "/clear", payload, key=key).status_code == 204
    later = create_item(memory_client, content="清空后重新明确确认的新事项。")
    before_replay = preferences(memory_client)
    assert command(memory_client, "POST", "/clear", payload, key=key).status_code == 204
    assert preferences(memory_client)["revision"] == before_replay["revision"]
    assert memory_client.get(f"{PREFIX}/items/{later['id']}").status_code == 200


def test_old_enable_replay_cannot_reenable_revoked_authorization(memory_client):
    account(memory_client)
    key = str(uuid4())
    payload = {"long_term_memory_enabled": True, "expected_version": 0, "consent": CONSENT}
    initial = command(memory_client, "PATCH", "/preferences", payload, key=key)
    assert initial.status_code == 200
    assert (
        command(
            memory_client,
            "PATCH",
            "/preferences",
            {"long_term_memory_enabled": False, "expected_version": initial.json()["version"]},
        ).status_code
        == 200
    )
    replay = command(memory_client, "PATCH", "/preferences", payload, key=key)
    assert replay.status_code == 200
    assert replay.json()["long_term_memory_enabled"] is False
    assert preferences(memory_client)["long_term_memory_enabled"] is False


def test_sync_cursor_provenance_and_pagination_restart(memory_client):
    account(memory_client)
    enable(memory_client)
    before = preferences(memory_client)
    first = create_item(memory_client)
    second = create_item(memory_client, title="沟通偏好", content="喜欢简洁的交流。")
    changes = memory_client.get(f"{PREFIX}/changes", params={"cursor": before["sync_cursor"]})
    assert changes.status_code == 200
    events = changes.json()["items"]
    assert {row["memory_id"] for row in events} == {first["id"], second["id"]}
    assert all("content" not in row and "summary" not in row for row in events)
    page = memory_client.get(f"{PREFIX}/items", params={"limit": 1})
    assert page.status_code == 200 and page.json()["has_more"] is True
    cursor = page.json()["next_cursor"]
    create_item(memory_client, title="面试准备", content="准备基础知识复习。")
    stale = memory_client.get(f"{PREFIX}/items", params={"limit": 1, "cursor": cursor})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "SYNC_RESTART_REQUIRED"


def test_active_pagination_does_not_skip_survivor_when_previous_page_expires(
    memory_client, monkeypatch
):
    account(memory_client)
    enable(memory_client)
    clock = datetime.now(UTC)
    monkeypatch.setattr(memory_service, "now", lambda: clock)
    survivor = create_item(
        memory_client,
        title="长期有效的目标",
        content="希望持续了解后端开发岗位。",
        expires_at=(clock + timedelta(days=1)).isoformat(),
    )
    clock += timedelta(seconds=1)
    expiring = create_item(
        memory_client,
        title="短期事项",
        content="希望今天了解一次面试准备。",
        expires_at=(clock + timedelta(seconds=2)).isoformat(),
    )
    revision = preferences(memory_client)["revision"]
    first = memory_client.get(f"{PREFIX}/items", params={"status": "active", "limit": 1})
    assert first.status_code == 200
    assert [row["id"] for row in first.json()["items"]] == [expiring["id"]]
    assert first.json()["has_more"] is True
    cursor = first.json()["next_cursor"]
    clock += timedelta(seconds=3)
    assert preferences(memory_client)["revision"] == revision
    second = memory_client.get(
        f"{PREFIX}/items", params={"status": "active", "limit": 1, "cursor": cursor}
    )
    assert second.status_code == 200
    assert [row["id"] for row in second.json()["items"]] == [survivor["id"]]
    assert second.json()["has_more"] is False
    assert preferences(memory_client)["revision"] == revision


def test_display_expiry_does_not_depend_on_background_scanner(memory_client, auth_database):
    account(memory_client)
    enable(memory_client)
    item = create_item(memory_client)
    with auth_database[0].begin() as db:
        db.execute(
            update(Memory)
            .where(Memory.id == UUID(item["id"]))
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    response = memory_client.get(f"{PREFIX}/items/{item['id']}")
    assert response.status_code == 200
    assert response.json()["status"] == "expired"
    assert memory_client.get(f"{PREFIX}/{item['id']}").status_code == 404


def test_non_deleted_legacy_records_count_toward_capacity(memory_client, auth_database):
    user, _ = account(memory_client)
    enable(memory_client)
    with auth_database[0].begin() as db:
        db.execute(
            Memory.__table__.insert(),
            [
                {
                    "id": uuid4(),
                    "owner_id": UUID(user["id"]),
                    "content": "未确认的旧条目。",
                    "consent_granted_at": datetime.now(UTC),
                }
                for _ in range(200)
            ],
        )
    response = command(memory_client, "POST", "/items", item_payload(memory_client))
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "MEMORY_CAPACITY_LIMIT"
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 200
