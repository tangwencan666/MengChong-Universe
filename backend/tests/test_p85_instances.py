"""P85 instance identity, lifecycle and memory boundary through isolated real APIs."""

import json
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_memory_api import account as memory_account
from test_memory_api import memory_client as memory_client
from test_memory_injection import entries
from test_memory_injection import injection_context as injection_context
from test_pet_chat import account, send, session
from test_pet_chat import pet_client as pet_client
from test_pet_memory import command as memory_command
from test_pet_memory import create as memory_create
from test_pet_memory import enable, path, pet_chat
from test_pet_memory_races import terminal
from test_pets import create as legacy_create

from app.modules.pets.models import Pet, PetMemoryPreferences
from tests.auth_helpers import csrf, login

BASE = "/api/v1/pet-instances"


def test_instance_reads_share_the_existing_owner_read_limit(auth_client):
    account(auth_client)
    for index in range(120):
        route = BASE if index % 2 else "/api/v1/pets"
        assert auth_client.get(route).status_code == 200
    assert auth_client.get(BASE).status_code == 429
    assert auth_client.get("/api/v1/pets").status_code == 429


def command(client, method, suffix="", body=None, key=None):
    return client.request(
        method,
        BASE + suffix,
        json=body,
        headers={**csrf(client), "Idempotency-Key": key or str(uuid4())},
    )


def adopt(client, name="同名伙伴", species="hajimi", key=None):
    response = command(client, "POST", body={"species_id": species, "name": name}, key=key)
    assert response.status_code == 201, response.text
    return response.json()


def test_same_species_and_same_name_are_distinct_instances_with_idempotent_retry(
    auth_client, auth_database
):
    account(auth_client)
    owner = auth_client.get("/api/v1/auth/me").json()["id"]
    key = str(uuid4())
    first = adopt(auth_client, key=key)
    assert adopt(auth_client, key=key) == first
    pets = [first, adopt(auth_client), adopt(auth_client)]
    assert len({pet["pet_instance_id"] for pet in pets}) == 3
    assert all(
        p["pet_id"] == p["pet_instance_id"]
        and p["owner_user_id"] == owner
        and p["species_id"] == "hajimi"
        for p in pets
    )
    with auth_database[0].connect() as db:
        rows = db.execute(select(Pet.__table__)).mappings().all()
        assert len({row["companion_id"] for row in rows}) == 3
        assert len(db.execute(select(PetMemoryPreferences)).all()) == 3
        assert not any(
            row.long_term_memory_enabled for row in db.execute(select(PetMemoryPreferences))
        )


def test_rename_keeps_identity_and_species_and_changes_only_one_persona(auth_client):
    account(auth_client)
    first, second = adopt(auth_client), adopt(auth_client)
    body = {
        "expected_version": first["version"],
        "name": "独立名字",
        "persona_config": {"description": "只有这只喜欢安静。", "tone": "calm"},
    }
    response = command(auth_client, "PATCH", "/" + first["pet_id"], body)
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed["pet_instance_id"] == first["pet_instance_id"]
    assert changed["species_id"] == first["species_id"] and changed["version"] == 2
    assert auth_client.get(BASE + "/" + second["pet_id"]).json() == second
    assert command(auth_client, "PATCH", "/" + first["pet_id"], body).status_code == 409
    legacy = auth_client.get("/api/v1/pets/" + first["pet_id"]).json()
    assert legacy["name"] == changed["name"] and "owner_user_id" not in legacy


def test_legacy_mapping_uses_asset_or_role_never_name_and_supports_more_than_five(auth_client):
    account(auth_client)
    legacy = legacy_create(auth_client, name="哈吉米")
    result = auth_client.get(BASE + "/" + legacy["pet_id"]).json()
    assert result["species_id"] == "moon" and result["species_source"] == "legacy_role"
    for species in ["moon", "doubao", "xiaoyun", "maodie", "hajimi", "hajimi"]:
        assert adopt(auth_client, species=species)["species_source"] == "registered_asset"
    listing = auth_client.get(BASE + "?limit=3").json()
    assert len(listing["items"]) == 3 and listing["has_more"]
    following = auth_client.get(BASE, params={"limit": 30, "cursor": listing["next_cursor"]}).json()
    assert len(following["items"]) == 4
    assert len(auth_client.get(BASE + "/species").json()["items"]) == 8


@pytest.mark.parametrize("extra", ["owner_user_id", "pet_instance_id", "owner_id", "pet_id"])
def test_clients_cannot_assign_instances_or_owners(auth_client, extra):
    account(auth_client)
    response = command(auth_client, "POST", body={"species_id": "hajimi", extra: str(uuid4())})
    assert response.status_code == 422
    assert auth_client.get(BASE).json()["items"] == []


def test_cross_owner_reads_rename_delete_and_csrf_fail_without_disclosing_records(auth_client):
    account(auth_client)
    own = adopt(auth_client)
    owner = own["owner_user_id"]
    auth_client.cookies.clear()
    account(auth_client, "p85-other@example.com")
    other = adopt(auth_client)
    assert other["owner_user_id"] != owner
    assert auth_client.get(BASE + "/" + own["pet_id"]).status_code == 404
    assert auth_client.patch(BASE + "/" + own["pet_id"], json={}).status_code == 403
    for identifier in [own["pet_id"], str(uuid4())]:
        body = {"expected_version": 1, "name": "拒绝", "persona_config": {"description": ""}}
        assert command(auth_client, "PATCH", "/" + identifier, body).status_code == 404
        deletion = {
            "expected_version": 1,
            "confirmation_instance_id": identifier,
            "data_handling": "archive_keep_data",
        }
        assert command(auth_client, "DELETE", "/" + identifier, deletion).status_code == 404


def test_same_species_private_chat_and_prompts_remain_separate(pet_client, monkeypatch):
    from test_pet_chat import Spy

    client, _ = pet_client
    account(client)
    first, second = adopt(client), adopt(client)
    spy = Spy()
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_: spy)
    sessions = []
    for pet, marker in [(first, "P85_FIRST_CHAT"), (second, "P85_SECOND_CHAT")]:
        chat = session(client, pet["pet_id"])
        sessions.append(chat)
        accepted = send(client, pet["pet_id"], chat["id"], marker)
        assert accepted["generation"]["provider"] == "mock"
        assert client.portal.call(client.app.state.chat_runner.run_once)
    assert "P85_FIRST_CHAT" not in json.dumps(spy.calls[1])
    assert "P85_SECOND_CHAT" not in json.dumps(spy.calls[0])
    assert (
        client.get(f"/api/v1/pets/{second['pet_id']}/sessions/{sessions[0]['id']}").status_code
        == 404
    )
    assert spy.closed == 2


def test_archive_cancels_only_selected_instances_job_and_retains_chat(pet_client):
    client, _ = pet_client
    account(client)
    first, second = adopt(client), adopt(client)
    one, two = session(client, first["pet_id"]), session(client, second["pet_id"])
    queued = send(client, first["pet_id"], one["id"], "P85_FIRST_QUEUED")
    sibling = send(client, second["pet_id"], two["id"], "P85_SECOND_QUEUED")
    result = command(
        client,
        "DELETE",
        "/" + first["pet_id"],
        {
            "expected_version": 1,
            "confirmation_instance_id": first["pet_id"],
            "data_handling": "archive_keep_data",
        },
    )
    assert result.status_code == 200, result.text
    for pet, chat, turn, expected in [
        (first, one, queued, "cancelled"),
        (second, two, sibling, "queued"),
    ]:
        base = f"/api/v1/pets/{pet['pet_id']}/sessions/{chat['id']}"
        job = client.get(base + "/generations/" + turn["generation"]["id"])
        assert job.status_code == 200 and job.json()["generation"]["state"] == expected
        assert client.get(base + "/messages").json()["items"]


def test_same_species_memory_retrieval_is_pet_and_owner_scoped(injection_context):
    _, _, client, spy = injection_context
    memory_account(client)
    first, second = adopt(client), adopt(client)
    one, two = first["pet_id"], second["pet_id"]
    for identifier in [one, two]:
        enable(client, identifier)
    own = memory_create(client, one, content="我喜欢简短自然的交流，代号P85_ONE_PRIVATE。")
    sibling = memory_create(client, two, content="我喜欢简短自然的交流，代号P85_TWO_PRIVATE。")
    for identifier, expected, forbidden in [(one, own, sibling), (two, sibling, own)]:
        chat, turn = pet_chat(client, identifier)
        terminal(client, identifier, chat, turn)
        assert [item["memory_id"] for item in entries(spy.calls[-1][0])] == [expected["id"]]
        assert forbidden["content"] not in json.dumps(spy.calls[-1], ensure_ascii=False)
        assert client.get(path(identifier, "/items/" + forbidden["id"])).status_code == 404
    client.cookies.clear()
    memory_account(client, "p85-memory-other@example.com")
    assert client.get(path(one, "/items")).status_code == 404
    assert client.get(BASE + "/" + first["pet_id"]).status_code == 404


def test_delete_requires_explicit_confirmation_archives_and_keeps_privacy_controls(memory_client):
    client = memory_client
    memory_account(client)
    first, second = adopt(client), adopt(client)
    one, two = first["pet_id"], second["pet_id"]
    enable(client, one)
    memory = memory_create(client, one)
    body = {
        "expected_version": 1,
        "confirmation_instance_id": str(uuid4()),
        "data_handling": "archive_keep_data",
    }
    assert command(client, "DELETE", "/" + one, body).status_code == 422
    assert client.get(BASE + "/" + one).json()["status"] == "active"
    body["confirmation_instance_id"] = one
    assert (
        command(
            client, "DELETE", "/" + one, dict(body, data_handling="erase_everything")
        ).status_code
        == 422
    )
    result = command(client, "DELETE", "/" + one, body)
    assert result.status_code == 200, result.text
    assert result.json()["lifecycle"] == {
        "instance": "archived",
        "chat": "retained_read_only",
        "memory": "retained_manageable",
        "can_undo_archive": False,
    }
    assert client.get(BASE + "/" + two).json() == second
    assert client.get(path(one, "/items/" + memory["id"])).status_code == 200
    revoked = memory_command(
        client,
        one,
        "POST",
        "/items/" + memory["id"] + "/revocations",
        {"expected_version": memory["version"]},
    )
    assert revoked.status_code == 200
    erased = memory_command(
        client,
        one,
        "DELETE",
        "/items/" + memory["id"],
        {"expected_version": revoked.json()["version"]},
    )
    assert erased.status_code == 204
    client.cookies.clear()
    assert login(client, email="memory-a@example.com").status_code == 200
    assert client.get(BASE + "?status=archived").json()["items"][0]["pet_instance_id"] == one
