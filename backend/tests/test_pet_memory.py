"""Explicit owner+pet consent and memory boundaries in disposable SQLite databases."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from test_memory_api import CONSENT, account, use_account
from test_memory_api import enable as enable_legacy
from test_memory_api import memory_client as memory_client
from test_pets import create as create_pet

from app.modules.memory.models import Memory, MemoryPreferences
from app.modules.pets.models import PetMemory, PetMemoryConsent
from tests.auth_helpers import csrf


def path(pet, suffix=""):
    return f"/api/v1/pets/{pet}/memory{suffix}"


def command(client, pet, method, suffix, payload=None, key=None):
    return client.request(
        method,
        path(pet, suffix),
        json=payload,
        headers={
            **csrf(client),
            "Idempotency-Key": key or str(uuid4()),
        },
    )


def prefs(client, pet):
    response = client.get(path(pet, "/preferences"))
    assert response.status_code == 200, response.text
    assert response.json()["pet_id"] == pet
    return response.json()


def enable(client, pet):
    response = command(
        client,
        pet,
        "PATCH",
        "/preferences",
        {
            "long_term_memory_enabled": True,
            "expected_version": prefs(client, pet)["version"],
            "consent": CONSENT,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def payload(client, pet, **changes):
    return {
        "title": "交流方式",
        "content": "我喜欢简短自然的交流。",
        "category": "communication_preference",
        "source": {"kind": "manual"},
        "expected_preferences_version": prefs(client, pet)["version"],
        "consent": CONSENT,
    } | changes


def create(client, pet, **changes):
    response = command(client, pet, "POST", "/items", payload(client, pet, **changes))
    assert response.status_code == 201, response.text
    assert response.json()["pet_id"] == pet
    return response.json()["item"]


def pet_chat(client, pet, content="我喜欢简短自然的交流。"):
    base = f"/api/v1/pets/{pet}"
    headers = {**csrf(client), "Idempotency-Key": str(uuid4())}
    response = client.post(base + "/sessions", json={}, headers=headers)
    assert response.status_code == 201, response.text
    session = response.json()["session"]
    headers["Idempotency-Key"] = str(uuid4())
    response = client.post(
        base + f"/sessions/{session['id']}/messages",
        json={
            "content": content,
            "client_message_id": str(uuid4()),
        },
        headers=headers,
    )
    assert response.status_code == 202, response.text
    return session, response.json()


def preview(client, pet, session, turn):
    response = command(
        client,
        pet,
        "POST",
        "/previews",
        {
            "session_id": session["id"],
            "message_ids": [turn["user_message"]["id"]],
            "expected_preferences_version": prefs(client, pet)["version"],
            "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def candidate_payload(client, pet, shown):
    item = shown["candidates"][0]
    return payload(
        client,
        pet,
        title=item["title"],
        content=item["content"],
        category=item["category"],
        source={
            "kind": "chat_message",
            "session_id": item["source_refs"][0]["session_id"],
            "message_ids": [item["source_refs"][0]["message_id"]],
            "preview_token": shown["preview_token"],
        },
    )


def test_pet_defaults_and_consent_never_share_legacy_or_sibling(memory_client, auth_database):
    c = memory_client
    account(c)
    a, b = create_pet(c)["pet_id"], create_pet(c)["pet_id"]
    assert prefs(c, a)["version"] == 1
    assert not prefs(c, a)["long_term_memory_enabled"]
    assert command(c, a, "POST", "/items", payload(c, a)).status_code == 409
    assert (
        c.patch(
            path(a, "/preferences"),
            json={
                "long_term_memory_enabled": True,
                "expected_version": 1,
                "consent": CONSENT,
            },
        ).status_code
        == 403
    )
    enable(c, a)
    assert not prefs(c, b)["long_term_memory_enabled"]
    assert c.get("/api/v1/memory/preferences").json()["long_term_memory_enabled"] is False
    assert c.get("/api/v1/companion/preferences").json()["recent_topic_enabled"] is False
    no_confirmation = payload(c, a, consent=dict(CONSENT, confirmed=False))
    assert command(c, a, "POST", "/items", no_confirmation).status_code == 422
    create(c, a)
    assert c.get(path(b, "/items")).json()["items"] == []
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(Memory)) == 0
        assert db.scalar(select(func.count()).select_from(MemoryPreferences)) == 0
        assert db.scalar(select(func.count()).select_from(PetMemory)) == 1


def test_pet_memory_crud_revocation_export_and_deleted_content(memory_client, auth_database):
    c = memory_client
    account(c)
    pet = create_pet(c)["pet_id"]
    enable(c, pet)
    item = create(c, pet)
    edit = payload(c, pet, expected_version=item["version"], content="请用平静语气和我交流。")
    edit.pop("source")
    response = command(c, pet, "PATCH", "/items/" + item["id"], edit)
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed["version"] == item["version"] + 1
    assert command(c, pet, "PATCH", "/items/" + item["id"], edit).status_code == 409
    exported = command(c, pet, "POST", "/export", {"format": "json", "include_inactive": True})
    assert exported.status_code == 200 and exported.json()["pet_id"] == pet
    assert exported.json()["items"][0]["content"] == changed["content"]
    source = c.get(path(pet, "/items/" + item["id"] + "/sources"))
    assert source.json()["pet_id"] == pet and source.json()["items"][0]["kind"] == "manual"
    revoked = command(
        c,
        pet,
        "POST",
        "/items/" + item["id"] + "/revocations",
        {
            "expected_version": changed["version"],
        },
    )
    assert revoked.status_code == 200 and revoked.json()["status"] == "revoked"
    deleted = command(
        c,
        pet,
        "DELETE",
        "/items/" + item["id"],
        {
            "expected_version": revoked.json()["version"],
        },
    )
    assert deleted.status_code == 204
    assert c.get(path(pet, "/items/" + item["id"])).status_code == 404
    with auth_database[0].connect() as db:
        row = db.execute(
            select(PetMemory.__table__).where(PetMemory.id == UUID(item["id"]))
        ).first()
        assert row.content == row.title == row.summary == ""


def test_owner_pet_cursor_and_idempotency_domains(memory_client):
    c = memory_client
    _, cookies = account(c)
    a, b = create_pet(c)["pet_id"], create_pet(c)["pet_id"]
    enable(c, a)
    enable(c, b)
    key = str(uuid4())
    data = payload(c, a)
    first = command(c, a, "POST", "/items", data, key).json()
    assert command(c, a, "POST", "/items", data, key).json()["idempotent_replay"]
    other = command(c, b, "POST", "/items", payload(c, b), key).json()
    assert first["item"]["id"] != other["item"]["id"]
    assert c.get(path(b, "/items/" + first["item"]["id"])).status_code == 404
    cursor = prefs(c, a)["sync_cursor"]
    assert c.get(path(b, "/changes"), params={"cursor": cursor}).status_code == 422
    assert c.get(path(a, "/changes"), params={"cursor": cursor}).json()["pet_id"] == a
    c.cookies.clear()
    account(c, "another-pet-memory@example.com")
    own = create_pet(c)["pet_id"]
    for suffix in [
        "/preferences",
        "/items",
        "/items/" + first["item"]["id"],
        "/items/" + first["item"]["id"] + "/sources",
    ]:
        assert c.get(path(a, suffix)).status_code == 404
    assert c.get(path(own, "/items/" + first["item"]["id"])).status_code == 404
    use_account(c, cookies)
    assert c.get(path(a, "/items/" + first["item"]["id"])).status_code == 200


def test_preview_receipt_is_pet_source_bound_and_never_auto_saves(memory_client, auth_database):
    c = memory_client
    account(c)
    a, b = create_pet(c)["pet_id"], create_pet(c)["pet_id"]
    enable(c, a)
    enable(c, b)
    session, turn = pet_chat(c, a)
    shown = preview(c, a, session, turn)
    assert shown["persisted"] is False and shown["pet_id"] == a
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(PetMemory)) == 0
    data = candidate_payload(c, a, shown)
    assert command(c, b, "POST", "/items", data).status_code == 404
    # An otherwise valid B source cannot redeem A's signed receipt.
    b_session, b_turn = pet_chat(c, b)
    switched = dict(
        data,
        source=dict(
            data["source"], session_id=b_session["id"], message_ids=[b_turn["user_message"]["id"]]
        ),
    )
    rejected = command(c, b, "POST", "/items", switched)
    assert rejected.status_code == 409 and rejected.json()["error"]["code"] == "PREVIEW_STALE"
    # Even an authorized legacy domain cannot take over pet-bound messages.
    legacy_pref = enable_legacy(c)
    legacy = c.post(
        "/api/v1/memory/previews",
        json={
            "session_id": session["id"],
            "message_ids": [turn["user_message"]["id"]],
            "expected_preferences_version": legacy_pref["version"],
            "consent": {"confirmed": True, "notice_version": "memory-preview/1"},
        },
        headers=csrf(c),
    )
    assert legacy.status_code == 404
    saved = command(c, a, "POST", "/items", data)
    assert saved.status_code == 201, saved.text
    item = saved.json()["item"]
    assert item["sources"][0]["message_id"] == turn["user_message"]["id"]
    assert c.get(path(b, "/items")).json()["items"] == []


def test_deleted_pet_source_is_not_retrieved_and_retains_only_source_metadata(
    memory_client,
):
    c = memory_client
    account(c)
    pet = create_pet(c)["pet_id"]
    enable(c, pet)
    session, turn = pet_chat(c, pet)
    shown = preview(c, pet, session, turn)
    saved = command(c, pet, "POST", "/items", candidate_payload(c, pet, shown))
    assert saved.status_code == 201, saved.text
    item = saved.json()["item"]
    response = c.delete(f"/api/v1/pets/{pet}/sessions/{session['id']}", headers=csrf(c))
    assert response.status_code == 204
    retrieved = command(
        c,
        pet,
        "POST",
        "/retrieval-preview",
        {
            "query": "简短自然的交流",
            "limit": 5,
            "expected_preferences_version": prefs(c, pet)["version"],
        },
    )
    assert retrieved.status_code == 200 and retrieved.json()["items"] == [], retrieved.text
    detail = c.get(path(pet, "/items/" + item["id"]))
    assert detail.json()["status"] == "revoked"
    assert detail.json()["sources"][0]["availability"] == "source_deleted"


def test_disable_clear_and_archive_do_not_change_other_pet(memory_client, auth_database):
    c = memory_client
    account(c)
    a, b = create_pet(c)["pet_id"], create_pet(c)["pet_id"]
    enable(c, a)
    enable(c, b)
    item, sibling = create(c, a), create(c, b)
    result = command(
        c,
        a,
        "PATCH",
        "/preferences",
        {
            "long_term_memory_enabled": False,
            "expected_version": prefs(c, a)["version"],
        },
    )
    assert result.status_code == 200 and result.json()["context_epoch_floor"] != "0"
    assert c.get(path(a, "/items/" + item["id"])).json()["status"] == "revoked"
    assert c.get(path(b, "/items/" + sibling["id"])).json()["status"] == "active"
    assert (
        command(
            c,
            a,
            "POST",
            "/clear",
            {
                "confirmed": True,
                "expected_revision": prefs(c, a)["revision"],
            },
        ).status_code
        == 204
    )
    assert c.get(path(a, "/items")).json()["items"] == []
    with auth_database[0].connect() as db:
        preserved = dict(
            db.execute(select(PetMemory.__table__).where(PetMemory.id == UUID(item["id"])))
            .mappings()
            .one()
        )
    archive = c.post(f"/api/v1/pets/{b}/archive", json={"expected_version": 1}, headers=csrf(c))
    assert archive.status_code == 200, archive.text
    assert c.get(path(b, "/items")).json()["items"][0]["id"] == sibling["id"]
    assert (
        command(
            c,
            b,
            "DELETE",
            "/items/" + sibling["id"],
            {
                "expected_version": sibling["version"],
            },
        ).status_code
        == 204
    )
    assert c.get(path(b, "/items/" + sibling["id"])).status_code == 404
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(PetMemoryConsent)) >= 5
        deleted = (
            db.execute(select(PetMemory.__table__).where(PetMemory.id == UUID(sibling["id"])))
            .mappings()
            .one()
        )
        assert deleted["content"] == deleted["title"] == deleted["summary"] == ""
        assert (
            dict(
                db.execute(select(PetMemory.__table__).where(PetMemory.id == UUID(item["id"])))
                .mappings()
                .one()
            )
            == preserved
        )


def privacy_payload(client, pet, item, action):
    if action == "disable":
        return (
            "PATCH",
            "/preferences",
            {
                "long_term_memory_enabled": False,
                "expected_version": prefs(client, pet)["version"],
            },
        )
    if action == "clear":
        return (
            "POST",
            "/clear",
            {
                "confirmed": True,
                "expected_revision": prefs(client, pet)["revision"],
            },
        )
    return (
        "DELETE" if action == "delete" else "POST",
        "/items/" + item["id"] + ("/revocations" if action == "revoke" else ""),
        {"expected_version": item["version"]},
    )


@pytest.mark.parametrize("action", ["disable", "revoke", "delete", "clear"])
def test_archived_pet_keeps_privacy_controls_and_all_access_fences(
    memory_client,
    auth_database,
    action,
):
    c = memory_client
    _, cookies = account(c)
    a, b = create_pet(c)["pet_id"], create_pet(c)["pet_id"]
    enable(c, a)
    enable(c, b)
    first, second, sibling = create(c, a), create(c, a), create(c, b)
    assert (
        c.post(
            f"/api/v1/pets/{a}/archive", json={"expected_version": 1}, headers=csrf(c)
        ).status_code
        == 200
    )
    before = prefs(c, a)
    sibling_pref = prefs(c, b)
    with auth_database[0].connect() as db:
        sibling_row = dict(
            db.execute(select(PetMemory.__table__).where(PetMemory.id == UUID(sibling["id"])))
            .mappings()
            .one()
        )
    method, suffix, data = privacy_payload(c, a, first, action)
    no_csrf = c.request(
        method, path(a, suffix), json=data, headers={"Idempotency-Key": str(uuid4())}
    )
    assert no_csrf.status_code == 403
    assert command(c, a, method, suffix, dict(data, pet_id=b)).status_code == 422
    stale = dict(data)
    field = "expected_revision" if action == "clear" else "expected_version"
    stale[field] = str(int(data[field]) + 1) if action == "clear" else data[field] + 1
    assert command(c, a, method, suffix, stale).status_code == 409
    if action in {"delete", "revoke"}:
        assert command(c, b, method, suffix, data).status_code == 404
    c.cookies.clear()
    assert command(c, a, method, suffix, data).status_code == 401
    account(c, "archived-other-owner@example.com")
    assert command(c, a, method, suffix, data).status_code == 404
    use_account(c, cookies)
    key = str(uuid4())
    response = command(c, a, method, suffix, data, key)
    expected = 204 if action in {"delete", "clear"} else 200
    assert response.status_code == expected, response.text
    assert command(c, a, method, suffix, data, key).status_code == expected
    after = prefs(c, a)
    assert int(after["privacy_epoch"]) > int(before["privacy_epoch"])
    assert after["context_epoch_floor"] == after["privacy_epoch"]
    if action == "disable":
        assert not after["long_term_memory_enabled"]
        assert c.get(path(a, "/items/" + first["id"])).json()["status"] == "revoked"
        assert c.get(path(a, "/items/" + second["id"])).json()["status"] == "revoked"
    elif action == "revoke":
        assert c.get(path(a, "/items/" + first["id"])).json()["status"] == "revoked"
        assert c.get(path(a, "/items/" + second["id"])).json()["status"] == "active"
    else:
        assert c.get(path(a, "/items/" + first["id"])).status_code == 404
        if action == "clear":
            assert c.get(path(a, "/items/" + second["id"])).status_code == 404
        with auth_database[0].connect() as db:
            erased = (
                db.execute(select(PetMemory.__table__).where(PetMemory.id == UUID(first["id"])))
                .mappings()
                .one()
            )
            assert erased["content"] == erased["title"] == erased["summary"] == ""
    assert prefs(c, b) == sibling_pref
    with auth_database[0].connect() as db:
        assert (
            dict(
                db.execute(select(PetMemory.__table__).where(PetMemory.id == UUID(sibling["id"])))
                .mappings()
                .one()
            )
            == sibling_row
        )


@pytest.mark.parametrize("action", ["enable", "create", "edit", "confirm"])
def test_archived_pet_still_rejects_new_consent_or_memory_content(memory_client, action):
    c = memory_client
    account(c)
    pet = create_pet(c)["pet_id"]
    enable(c, pet)
    item = create(c, pet)
    assert (
        c.post(
            f"/api/v1/pets/{pet}/archive", json={"expected_version": 1}, headers=csrf(c)
        ).status_code
        == 200
    )
    if action == "enable":
        method, suffix, data = (
            "PATCH",
            "/preferences",
            {
                "long_term_memory_enabled": True,
                "expected_version": prefs(c, pet)["version"],
                "consent": CONSENT,
            },
        )
    elif action == "create":
        method, suffix, data = "POST", "/items", payload(c, pet)
    else:
        data = payload(c, pet, expected_version=item["version"])
        data.pop("source")
        method = "POST" if action == "confirm" else "PATCH"
        suffix = "/items/" + item["id"] + ("/confirm" if action == "confirm" else "")
    response = command(c, pet, method, suffix, data)
    assert response.status_code == 409 and response.json()["error"]["code"] == "PET_ARCHIVED"
    assert c.get(path(pet, "/items/" + item["id"])).json()["content"] == item["content"]


@pytest.mark.parametrize("field", ["pet_id", "owner_id", "user_id"])
def test_memory_identity_cannot_be_assigned_in_body(memory_client, field):
    c = memory_client
    account(c)
    pet = create_pet(c)["pet_id"]
    enable(c, pet)
    assert (
        command(c, pet, "POST", "/items", payload(c, pet, **{field: str(uuid4())})).status_code
        == 422
    )
