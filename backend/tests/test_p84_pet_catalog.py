"""Real isolated auth/chat/memory paths, public catalog, local Mock provider only."""

import json
from pathlib import Path

import pytest
from auth_helpers import login
from test_memory_api import account as memory_account
from test_memory_api import memory_client as memory_client
from test_pet_chat import Spy, account, cmd, send, session
from test_pet_chat import pet_client as pet_client
from test_pet_memory import create, enable, path

CATALOG = json.loads(
    (Path(__file__).parents[2] / "desktop/assets/pet-definitions.json").read_text(encoding="utf-8")
)["pets"]


def adopt(client, definition):
    from uuid import uuid4

    response = cmd(
        client,
        "POST",
        "/pets",
        {
            "name": definition["name"],
            "role_type": definition["role_type"],
            "persona_config": {"description": definition["persona"], "tone": definition["tone"]},
            "appearance_config": {
                "asset_id": definition["id"],
                "tint": definition["tint"],
                "scale": 1.0,
            },
        },
        str(uuid4()),
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize(
    "definitions",
    [CATALOG[:5], [CATALOG[0], *CATALOG[5:]]],
    ids=["original-five", "three-new-and-legacy-moon"],
)
def test_eight_templates_preserve_distinct_persona_prompt_history_and_pet_context(
    pet_client, monkeypatch, definitions
):
    client, _ = pet_client
    account(client)
    spy = Spy()
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_: spy)
    # Separate real auth fixtures keep each batch within the existing command
    # rate limit; the second batch also covers old/new species together.
    pets = [adopt(client, definition) for definition in definitions]
    assert len({pet["pet_id"] for pet in pets}) == len(definitions)
    sessions = []
    for index, (pet, definition) in enumerate(zip(pets, definitions, strict=True)):
        chat = session(client, pet["pet_id"])
        sessions.append(chat)
        accepted = send(client, pet["pet_id"], chat["id"], "P84-local-private-" + definition["id"])
        assert accepted["generation"]["provider"] == "mock"
        assert client.portal.call(client.app.state.chat_runner.run_once)
        messages, prompt = spy.calls[index]
        assert definition["name"] in prompt and definition["persona"] in prompt
        for other in CATALOG:
            if other["id"] != definition["id"]:
                assert "P84-local-private-" + other["id"] not in json.dumps(messages)
                assert other["persona"] not in prompt
        history = client.get(f"/api/v1/pets/{pet['pet_id']}/sessions/{chat['id']}/messages").json()
        assert len(history["items"]) == 2
    assert len({chat["id"] for chat in sessions}) == len(definitions) and len(
        spy.calls
    ) == spy.closed == len(definitions)
    assert (
        client.get(f"/api/v1/pets/{pets[-1]['pet_id']}/sessions/{sessions[-2]['id']}").status_code
        == 404
    )


def test_maodie_hajimi_long_term_memory_and_other_user_remain_isolated(memory_client):
    client = memory_client
    memory_account(client)
    maodie, hajimi = [
        adopt(client, definition)
        for definition in CATALOG
        if definition["id"] in {"maodie", "hajimi"}
    ]
    for pet in [maodie, hajimi]:
        enable(client, pet["pet_id"])
    first = create(client, maodie["pet_id"], content="只属于耄耋的本地合成偏好：喜欢抽象笑话。")
    second = create(client, hajimi["pet_id"], content="只属于哈吉米的本地合成偏好：喜欢安静陪伴。")
    for own, other, item in [(maodie, hajimi, first), (hajimi, maodie, second)]:
        rows = client.get(path(own["pet_id"], "/items")).json()["items"]
        assert [row["id"] for row in rows] == [item["id"]]
        assert client.get(path(other["pet_id"], "/items/" + item["id"])).status_code == 404
    memory_account(client, "p84-other@example.com")
    for pet in [maodie, hajimi]:
        assert client.get(path(pet["pet_id"], "/items")).status_code == 404
        assert client.get(f"/api/v1/pets/{pet['pet_id']}").status_code == 404
    client.cookies.clear()
    assert login(client, email="memory-a@example.com").status_code == 200
    assert client.get(path(maodie["pet_id"], "/items")).json()["items"][0]["id"] == first["id"]
