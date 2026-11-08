"""Eight-role adoption uses real isolated auth/storage/retrieval with Mock only."""

import json

import pytest
from test_memory_api import account as memory_account
from test_memory_injection import entries
from test_memory_injection import injection_context as injection_context
from test_p85_instances import BASE, adopt, command
from test_pet_chat import account
from test_pet_memory import create as memory_create
from test_pet_memory import enable, path, pet_chat
from test_pet_memory_races import terminal


def test_eight_role_catalog_declares_local_appearance_without_private_identity(auth_client):
    account(auth_client)
    rows = auth_client.get(BASE + "/species").json()["items"]
    assert [row["species_id"] for row in rows] == [
        "moon",
        "doubao",
        "xiaoyun",
        "maodie",
        "hajimi",
        "niwa",
        "daodun",
        "whale",
    ]
    assert len({row["appearance_id"] for row in rows}) == 8
    assert all(row["appearance_restriction"] == "local-verification-only" for row in rows[-3:])
    assert all("owner_user_id" not in row and "pet_instance_id" not in row for row in rows)


def test_explicit_matching_appearance_uses_new_instance_not_an_existing_identity(auth_client):
    account(auth_client)
    body = {"species_id": "niwa", "appearance_id": "niwa-source-v1", "name": "同名"}
    first = command(auth_client, "POST", body=body).json()
    second = command(auth_client, "POST", body=body).json()
    assert first["pet_instance_id"] != second["pet_instance_id"]
    assert first["species_id"] == "niwa" and first["appearance_id"] == "niwa-source-v1"


@pytest.mark.parametrize("species", ["niwa", "daodun", "whale"])
def test_new_role_siblings_have_persisted_independent_snapshots_and_stable_identity(
    auth_client, monkeypatch, species
):
    from app.modules.pet_instances.catalog import TEMPLATES

    account(auth_client)
    first, second = adopt(auth_client, species=species), adopt(auth_client, species=species)
    assert first["pet_instance_id"] != second["pet_instance_id"]
    assert first["appearance_id"] == second["appearance_id"] == species + "-source-v1"
    assert first["appearance_config"]["asset_id"] == first["appearance_id"]
    assert first["personality_snapshot"] == first["persona_config"]
    assert first["personality_snapshot_version"] == 1
    monkeypatch.setitem(TEMPLATES[species], "persona", "修改模板也不能改变已领养实例的人格。")
    assert auth_client.get(BASE + "/" + first["pet_id"]).json() == first
    response = command(
        auth_client,
        "PATCH",
        "/" + first["pet_id"],
        {
            "expected_version": 1,
            "name": "自己的新名字",
            "persona_config": {"description": "只有此实例喜欢安静。", "tone": "calm"},
        },
    )
    assert response.status_code == 200
    updated = response.json()
    assert (
        updated["pet_instance_id"] == first["pet_instance_id"]
        and updated["appearance_id"] == first["appearance_id"]
    )
    assert (
        updated["personality_snapshot"] == updated["persona_config"]
        and updated["personality_snapshot_version"] == 2
    )
    assert auth_client.get(BASE + "/" + second["pet_id"]).json() == second


@pytest.mark.parametrize(
    "appearance", ["niwa-source-v1", "moon-base-v1", "outside", "../../private"]
)
def test_appearance_selection_cannot_reassign_species_or_read_arbitrary_resources(
    auth_client, appearance
):
    account(auth_client)
    response = command(
        auth_client, "POST", body={"species_id": "whale", "appearance_id": appearance}
    )
    assert response.status_code == 422
    assert auth_client.get(BASE).json()["items"] == []


def test_new_same_species_cross_species_and_other_owner_memory_and_chat_do_not_mix(
    injection_context,
):
    _, _, client, spy = injection_context
    memory_account(client)
    pets = [adopt(client, species=species) for species in ["whale", "whale", "niwa"]]
    items = []
    for index, pet in enumerate(pets):
        enable(client, pet["pet_id"])
        items.append(
            memory_create(
                client, pet["pet_id"], content=f"我喜欢简短自然的回应，独立标记P85_EIGHT_{index}。"
            )
        )
    chats = []
    for index, pet in enumerate(pets):
        chat, turn = pet_chat(client, pet["pet_id"])
        chats.append(chat)
        terminal(client, pet["pet_id"], chat, turn)
        assert [entry["memory_id"] for entry in entries(spy.calls[-1][0])] == [items[index]["id"]]
        for other_index, other in enumerate(pets):
            if index != other_index:
                assert items[other_index]["content"] not in json.dumps(
                    spy.calls[-1], ensure_ascii=False
                )
                assert (
                    client.get(path(other["pet_id"], "/items/" + items[index]["id"])).status_code
                    == 404
                )
                assert (
                    client.get(f"/api/v1/pets/{other['pet_id']}/sessions/{chat['id']}").status_code
                    == 404
                )
    assert len({chat["id"] for chat in chats}) == 3
    client.cookies.clear()
    memory_account(client, "p85-eight-other@example.com")
    for pet in pets:
        assert client.get(BASE + "/" + pet["pet_id"]).status_code == 404
        assert client.get(path(pet["pet_id"], "/items")).status_code == 404
