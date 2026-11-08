"""Pet identity commands against an isolated temporary, fully migrated database."""

import base64
import json
import logging
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from app.modules.companion.models import AICompanion
from app.modules.pets.models import Pet, PetChatBinding, PetMemoryPreferences
from tests.auth_helpers import csrf, login, register

PREFIX = "/api/v1/pets"


def account(client, email="pet-owner@example.com"):
    assert register(client, email=email).status_code == 202
    assert login(client, email=email).status_code == 200
    return dict(client.cookies)


def command(client, method, path="", payload=None, key=None):
    headers = csrf(client)
    if method == "POST":
        headers["Idempotency-Key"] = key if key is not None else str(uuid4())
    return client.request(method, PREFIX + path, json=payload, headers=headers)


def create(client, name="小叶", key=None):
    result = command(client, "POST", payload={"name": name, "role_type": "cat"}, key=key)
    assert result.status_code == 201, result.text
    return result.json()


def test_pet_identity_is_new_private_and_memory_defaults_off(auth_client, auth_database):
    account(auth_client)
    first, second = create(auth_client), create(auth_client)
    assert first["pet_id"] != second["pet_id"]
    assert first["version"] == 1 and first["status"] == "active"
    assert first["persona_config"] == {"description": "", "tone": "warm"}
    assert first["appearance_config"]["asset_id"] == "pet-default"
    assert "owner_id" not in first and "companion_id" not in first
    with auth_database[0].connect() as db:
        pets = db.execute(select(Pet.__table__)).mappings().all()
        companions = db.execute(select(AICompanion.__table__)).mappings().all()
        preferences = db.execute(select(PetMemoryPreferences.__table__)).mappings().all()
        assert len(pets) == len(companions) == len(preferences) == 2
        assert len({row["companion_id"] for row in pets}) == 2
        assert all(
            row["prompt_version"] == "pet-v1" and not row["is_default"] for row in companions
        )
        assert all(
            not row["long_term_memory_enabled"] and row["privacy_epoch"] == 0 for row in preferences
        )
        assert db.scalar(select(func.count()).select_from(PetChatBinding)) == 0


def test_pet_create_is_idempotent_with_owner_scoped_key(auth_client):
    cookies = account(auth_client)
    key = str(uuid4())
    original = create(auth_client, key=key)
    assert create(auth_client, key=key) == original
    assert command(auth_client, "POST", payload={"name": "different"}, key=key).status_code == 409
    assert command(auth_client, "POST", payload={"name": "name"}, key="short").status_code == 422
    auth_client.cookies.clear()
    account(auth_client, "pet-other@example.com")
    other = create(auth_client, key=key)
    assert other["pet_id"] != original["pet_id"]
    assert auth_client.get(PREFIX + "/" + original["pet_id"]).status_code == 404
    auth_client.cookies.clear()
    auth_client.cookies.update(cookies)
    assert auth_client.get(PREFIX + "/" + other["pet_id"]).status_code == 404


def test_pet_csrf_and_cross_owner_commands_are_checked(auth_client):
    assert auth_client.get(PREFIX).status_code == 401
    first_cookie = account(auth_client)
    first = create(auth_client)
    assert (
        auth_client.patch(
            PREFIX + "/" + first["pet_id"], json={"name": "new", "expected_version": 1}
        ).status_code
        == 403
    )
    auth_client.cookies.clear()
    account(auth_client, "pet-isolation@example.com")
    create(auth_client)
    for method, suffix, payload in [
        ("PATCH", "", {"name": "new", "expected_version": 1}),
        ("POST", "/visibility", {"hidden": True, "expected_version": 1}),
        ("POST", "/archive", {"expected_version": 1}),
    ]:
        response = command(auth_client, method, "/" + first["pet_id"] + suffix, payload)
        absent = command(auth_client, method, "/" + str(uuid4()) + suffix, payload)
        assert response.status_code == absent.status_code == 404
        assert response.json()["error"] == absent.json()["error"]
    assert len(auth_client.get(PREFIX).json()["items"]) == 1
    auth_client.cookies.clear()
    auth_client.cookies.update(first_cookie)
    assert auth_client.get(PREFIX + "/" + first["pet_id"]).json()["version"] == 1


def test_versioned_edit_hide_and_archive_preserve_read_access(auth_client):
    account(auth_client)
    pet = create(auth_client)
    path = "/" + pet["pet_id"]
    edited = command(
        auth_client,
        "PATCH",
        path,
        {
            "expected_version": 1,
            "name": "叶叶",
            "role_type": "dog",
            "persona_config": {"description": "说话简洁", "tone": "calm"},
            "appearance_config": {"asset_id": "dog-soft", "tint": "#ABCDEF", "scale": 1.2},
        },
    )
    assert edited.status_code == 200 and edited.json()["version"] == 2
    assert (
        command(auth_client, "PATCH", path, {"expected_version": 1, "name": "stale"}).status_code
        == 409
    )
    hidden = command(
        auth_client, "POST", path + "/visibility", {"expected_version": 2, "hidden": True}
    )
    assert hidden.status_code == 200 and hidden.json()["status"] == "hidden"
    assert auth_client.get(PREFIX).json()["items"] == []
    assert auth_client.get(PREFIX + "?status=hidden").json()["items"][0]["pet_id"] == pet["pet_id"]
    assert auth_client.get(PREFIX + path).status_code == 200
    archived = command(auth_client, "POST", path + "/archive", {"expected_version": 3})
    assert archived.status_code == 200 and archived.json()["status"] == "archived"
    assert auth_client.get(PREFIX + path).status_code == 200
    assert auth_client.get(PREFIX + "?status=archived").json()["items"][0]["version"] == 4
    assert (
        command(auth_client, "PATCH", path, {"expected_version": 4, "name": "blocked"}).status_code
        == 409
    )
    assert (
        command(
            auth_client, "POST", path + "/visibility", {"expected_version": 4, "hidden": False}
        ).status_code
        == 409
    )


@pytest.mark.parametrize("extra", ["owner_id", "user_id", "pet_id", "id", "companion_id"])
def test_pet_client_cannot_assign_identity(auth_client, extra):
    account(auth_client)
    response = command(auth_client, "POST", payload={"name": "safe", extra: str(uuid4())})
    assert response.status_code == 422
    assert auth_client.get(PREFIX).json()["items"] == []


@pytest.mark.parametrize(
    "payload",
    [
        {"name": " "},
        {"name": "a" * 61},
        {"name": "line\nbreak"},
        {"name": "safe", "role_type": "admin"},
        {"name": "safe", "persona_config": {"system_prompt": "override"}},
        {"name": "safe", "persona_config": {"description": "a" * 601}},
        {"name": "safe", "appearance_config": {"asset_id": "https://example.invalid/pet"}},
        {"name": "safe", "appearance_config": {"asset_id": "../outside"}},
        {"name": "safe", "appearance_config": {"url": "file:///private"}},
        {"name": "safe", "appearance_config": {"tint": "red;script"}},
        {"name": "safe", "appearance_config": {"scale": 20}},
        {"name": "safe", "appearance_config": {"scale": "1.0"}},
    ],
)
def test_pet_configuration_is_bounded_and_has_no_execution_or_paths(auth_client, payload):
    account(auth_client)
    assert command(auth_client, "POST", payload=payload).status_code == 422


def test_pet_cursor_rejects_account_and_status_changes(auth_client):
    account(auth_client)
    first, second = create(auth_client), create(auth_client)
    page = auth_client.get(PREFIX + "?limit=1").json()
    assert page["has_more"] and page["next_cursor"]
    next_page = auth_client.get(PREFIX, params={"limit": 1, "cursor": page["next_cursor"]}).json()
    assert {page["items"][0]["pet_id"], next_page["items"][0]["pet_id"]} == {
        first["pet_id"],
        second["pet_id"],
    }
    assert next_page["has_more"] is False
    assert (
        auth_client.get(
            PREFIX, params={"status": "hidden", "cursor": page["next_cursor"]}
        ).status_code
        == 422
    )
    for invalid in [123, {}, [], None]:
        malformed = json.loads(base64.urlsafe_b64decode(page["next_cursor"]))
        malformed["id"] = invalid
        token = base64.urlsafe_b64encode(json.dumps(malformed).encode()).decode()
        assert auth_client.get(PREFIX, params={"cursor": token}).status_code == 422
    auth_client.cookies.clear()
    account(auth_client, "cursor-pet@example.com")
    assert auth_client.get(PREFIX, params={"cursor": page["next_cursor"]}).status_code == 422


def test_pet_private_configuration_and_cookie_are_not_logged(auth_client, caplog):
    caplog.set_level(logging.INFO)
    account(auth_client)
    private = "this-is-a-private-pet-description"
    response = command(
        auth_client, "POST", payload={"name": "pet", "persona_config": {"description": private}}
    )
    assert response.status_code == 201
    assert UUID(response.json()["pet_id"])
    assert private not in caplog.text
    assert auth_client.cookies.get("weibiye_session") not in caplog.text


def test_pet_reads_do_not_consume_chat_mutation_allowance(auth_client):
    account(auth_client)
    auth_client.app.state.settings.chat_commands_per_minute = 2
    pet = create(auth_client)
    for _ in range(5):
        assert auth_client.get(PREFIX).status_code == 200
        assert auth_client.get(PREFIX + "/" + pet["pet_id"]).status_code == 200
    edited = command(
        auth_client, "PATCH", "/" + pet["pet_id"], {"expected_version": 1, "name": "still allowed"}
    )
    assert edited.status_code == 200
    limited = command(
        auth_client, "POST", "/" + pet["pet_id"] + "/archive", {"expected_version": 2}
    )
    assert limited.status_code == 429


def test_pet_chat_child_commands_are_counted_once(auth_client):
    account(auth_client)
    auth_client.app.state.settings.chat_commands_per_minute = 2
    pet = create(auth_client)
    session = command(auth_client, "POST", "/" + pet["pet_id"] + "/sessions", {})
    assert session.status_code == 201, session.text
    blocked = command(
        auth_client, "PATCH", "/" + pet["pet_id"], {"expected_version": 1, "name": "third mutation"}
    )
    assert blocked.status_code == 429
