"""Development-only pet routing; all SDK calls use local HTTPX MockTransport."""

import json
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import select
from test_chat import create_session as legacy_session
from test_chat import send as legacy_send
from test_deepseek_provider import BytesStream, frame
from test_deepseek_provider import transport as transport
from test_memory_api import create_item as create_legacy_memory
from test_memory_api import enable as enable_legacy_memory
from test_memory_api import use_account
from test_memory_injection import open_client
from test_pet_chat import account, pet, send, session
from test_pet_memory import create, enable

from app.agent.provider_selection import resolved_generation_settings, select_chat_provider
from app.core.config import Settings
from app.core.errors import AppError
from app.modules.pets.memory_runtime import PetGenerationMemoryRuntime
from app.modules.pets.models import PetGenerationContext

OWNER, TARGET, OTHER = uuid4(), uuid4(), uuid4()
FAKE_KEY = "p81-only-local-httpx-fixture-never-real"


def configured(**changes):
    return Settings(
        **(
            {
                "environment": "development",
                "llm_provider": "mock",
                "real_llm_enabled": True,
                "deepseek_api_key": SecretStr(FAKE_KEY),
                "dev_deepseek_pet_owner_id": OWNER,
                "dev_deepseek_pet_id": TARGET,
                "memory_management_enabled": True,
                "memory_hmac_key": SecretStr("p81-scoped-memory-fixture-not-production"),
                "memory_injection_enabled": True,
            }
            | changes
        )
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"environment": "test"},
        {"environment": "production"},
        {"llm_provider": "deepseek"},
        {"real_llm_enabled": False},
        {"deepseek_api_key": None},
        {"deepseek_api_key": SecretStr(" ")},
        {"dev_deepseek_pet_owner_id": None},
        {"dev_deepseek_pet_id": None},
    ],
)
def test_scoped_paid_mode_requires_complete_development_backend_gates(changes):
    with pytest.raises(ValidationError):
        configured(**changes)


def test_default_and_exact_owner_pet_routing_never_depend_on_display_names():
    baseline = Settings()
    assert select_chat_provider(baseline, OWNER, TARGET).provider == "mock"
    settings = configured()
    selected = select_chat_provider(settings, OWNER, TARGET)
    assert (selected.provider, selected.model, selected.memory_injection_enabled) == (
        "deepseek",
        "deepseek-flash",
        False,
    )
    for owner, one in [(OWNER, OTHER), (OTHER, TARGET), (OWNER, None), (None, TARGET)]:
        unchanged = select_chat_provider(settings, owner, one)
        assert (unchanged.provider, unchanged.model, unchanged.memory_injection_enabled) == (
            "mock",
            None,
            True,
        )
    assert select_chat_provider(settings).provider == "mock"
    effective = resolved_generation_settings(settings, OWNER, TARGET, "deepseek", "deepseek-flash")
    assert effective is not settings and effective.llm_provider == "deepseek"
    assert effective.memory_injection_enabled is False
    assert effective.dev_deepseek_pet_id is effective.dev_deepseek_pet_owner_id is None
    assert settings.llm_provider == "mock" and settings.memory_injection_enabled
    assert (
        resolved_generation_settings(settings, OWNER, TARGET, "mock", None).llm_provider == "mock"
    )


@pytest.mark.parametrize(
    "owner,one,model",
    [
        (OTHER, TARGET, "deepseek-flash"),
        (OWNER, OTHER, "deepseek-flash"),
        (OWNER, None, "deepseek-flash"),
        (OWNER, TARGET, "deepseek-v4-pro"),
    ],
)
def test_frozen_real_task_cannot_move_owner_pet_or_model(owner, one, model):
    with pytest.raises(AppError) as error:
        resolved_generation_settings(configured(), owner, one, "deepseek", model)
    assert error.value.code == "REAL_LLM_DISABLED"


@pytest.fixture
def mixed(auth_database, transport):
    engine, baseline = auth_database
    settings = baseline.model_copy(
        update={
            "environment": "development",
            "chat_runner_enabled": False,
            "memory_management_enabled": True,
            "memory_injection_enabled": True,
            "memory_hmac_key": SecretStr("p81-api-memory-fixture-only-not-production"),
            "deepseek_api_key": SecretStr(FAKE_KEY),
            "chat_user_active_limit": 10,
        }
    )
    control = {"error": False}

    def upstream(_):
        if control["error"]:
            return httpx.Response(429, json={"error": {"message": FAKE_KEY}})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=BytesStream(
                [
                    frame("P81 离线回复"),
                    frame(
                        finish="stop",
                        usage={
                            "prompt_tokens": 20,
                            "completion_tokens": 5,
                            "total_tokens": 25,
                        },
                    ),
                ]
            ),
        )

    records = transport(upstream)
    with open_client(settings) as client:
        a_cookies = account(client)
        a_id = UUID(client.get("/api/v1/auth/me").json()["id"])
        a, b, c = pet(client, "月芽"), pet(client, "豆包"), pet(client, "小云")
        client.cookies.clear()
        b_cookies = account(client, "p81-another-account@example.com")
        foreign = pet(client, "月芽")
        use_account(client, a_cookies)
        settings.dev_deepseek_pet_owner_id, settings.dev_deepseek_pet_id = a_id, UUID(a["pet_id"])
        settings.real_llm_enabled = True
        yield client, engine, settings, records, control, (a, b, c), a_cookies, b_cookies, foreign


def url(one, chat, accepted):
    return (
        f"/api/v1/pets/{one['pet_id']}/sessions/{chat['id']}/generations/"
        + accepted["generation"]["id"]
    )


def run(client):
    assert client.portal.call(client.app.state.chat_runner.run_once)


def test_pet_runtime_requires_auth_owner_and_does_not_disclose_other_target(mixed):
    client, _, _, records, _, pets, a_cookies, b_cookies, foreign = mixed
    expected_keys = {
        "schema_version",
        "provider",
        "model",
        "mode",
        "billing",
        "memory_injection_enabled",
    }
    for one, mode in zip(pets, ["deepseek", "mock", "mock"], strict=True):
        response = client.get(f"/api/v1/pets/{one['pet_id']}/runtime")
        assert response.status_code == 200 and set(response.json()) == expected_keys
        assert response.json()["provider"] == mode
        assert response.json()["memory_injection_enabled"] == (mode == "mock")
        assert FAKE_KEY not in response.text
        assert "no-store" in response.headers["cache-control"]
    assert client.get("/api/v1/companion/runtime").json()["provider"] == "mock"
    assert client.get(f"/api/v1/pets/{foreign['pet_id']}/runtime").status_code == 404
    assert client.get(f"/api/v1/pets/{uuid4()}/runtime").status_code == 404
    use_account(client, b_cookies)
    assert client.get(f"/api/v1/pets/{pets[0]['pet_id']}/runtime").status_code == 404
    assert client.get(f"/api/v1/pets/{foreign['pet_id']}/runtime").json()["provider"] == "mock"
    client.cookies.clear()
    assert client.get(f"/api/v1/pets/{pets[0]['pet_id']}/runtime").status_code == 401
    use_account(client, a_cookies)
    assert not records["requests"]


def test_generation_freezes_scoped_choice_for_three_pets_and_legacy(mixed):
    client, _, _, records, _, pets, *_ = mixed
    accepted = []
    for one, mode in zip(pets, ["deepseek", "mock", "mock"], strict=True):
        chat = session(client, one["pet_id"])
        response = send(client, one["pet_id"], chat["id"])
        accepted.append(response)
        assert response["generation"]["provider"] == mode
        assert response["assistant_message"]["provider"] == mode
        assert response["generation"]["model"] == ("deepseek-flash" if mode == "deepseek" else None)
    old = legacy_session(client)
    assert legacy_send(client, old["id"])["generation"]["provider"] == "mock"
    assert len({entry["generation"]["pet_id"] for entry in accepted}) == 3
    assert not records["requests"]


def test_selected_sdk_input_excludes_memories_but_other_mock_pet_keeps_granted_memory(
    mixed, monkeypatch
):
    client, engine, settings, records, _, pets, *_ = mixed
    from app.agent.providers import PrivateMockLLM

    mock_inputs = []

    class ObservingMock(PrivateMockLLM):
        async def stream(self, messages, system_prompt):
            mock_inputs.append(json.dumps(messages, ensure_ascii=False))
            async for chunk in super().stream(messages, system_prompt):
                yield chunk

    monkeypatch.setattr("app.agent.providers.PrivateMockLLM", ObservingMock)
    for index, one in enumerate(pets[:2]):
        enable(client, one["pet_id"])
        create(client, one["pet_id"], content=f"我喜欢简短自然的交流，代号P81_{index}_PRIVATE。")
    accepted = []
    for one in pets[:2]:
        chat = session(client, one["pet_id"])
        response = send(client, one["pet_id"], chat["id"], "想聊聊简短自然的交流。")
        run(client)
        status = client.get(url(one, chat, response)).json()
        assert status["generation"]["state"] == "completed", status
        accepted.append(response)
    assert len(records["requests"]) == 1
    external_input = json.dumps(json.loads(records["requests"][0].content), ensure_ascii=False)
    assert "_PRIVATE" not in external_input and "authorized_memory_data" not in external_input
    assert "月芽" in external_input and "豆包" not in external_input
    assert len(mock_inputs) == 1 and "P81_1_PRIVATE" in mock_inputs[0]
    assert "P81_0_PRIVATE" not in mock_inputs[0]
    assert settings.llm_provider == "mock" and settings.memory_injection_enabled
    with engine.connect() as db:
        target_refs = db.scalar(
            select(PetGenerationContext.memory_refs).where(
                PetGenerationContext.generation_id == UUID(accepted[0]["generation"]["id"])
            )
        )
        mock_refs = db.scalar(
            select(PetGenerationContext.memory_refs).where(
                PetGenerationContext.generation_id == UUID(accepted[1]["generation"]["id"])
            )
        )
        assert target_refs == [] and mock_refs


def test_p81_memory_canaries_are_pet_owner_and_legacy_isolated(mixed, monkeypatch):
    client, engine, settings, records, _, pets, a_cookies, b_cookies, foreign = mixed
    from app.agent.providers import PrivateMockLLM

    markers = [
        "P81_CANARY_MOON",
        "P81_CANARY_DOUBAO",
        "P81_CANARY_XIAOYUN",
        "P81_CANARY_FOREIGN_OWNER",
        "P81_CANARY_LEGACY",
    ]
    memories = {}
    for index, one in enumerate(pets):
        enable(client, one["pet_id"])
        memories[one["pet_id"]] = create(
            client, one["pet_id"], content="我喜欢简短自然的交流，代号" + markers[index] + "。"
        )
    enable_legacy_memory(client)
    create_legacy_memory(client, content="我喜欢简短自然的交流，代号" + markers[4] + "。")
    use_account(client, b_cookies)
    enable(client, foreign["pet_id"])
    memories[foreign["pet_id"]] = create(
        client, foreign["pet_id"], content="我喜欢简短自然的交流，代号" + markers[3] + "。"
    )
    assert (
        client.get(
            f"/api/v1/pets/{pets[0]['pet_id']}/memory/items/" + memories[pets[0]["pet_id"]]["id"]
        ).status_code
        == 404
    )
    use_account(client, a_cookies)
    assert (
        client.get(
            f"/api/v1/pets/{pets[1]['pet_id']}/memory/items/" + memories[pets[0]["pet_id"]]["id"]
        ).status_code
        == 404
    )
    observed_mock = []

    class ObservingMock(PrivateMockLLM):
        async def stream(self, messages, system_prompt):
            observed_mock.append(json.dumps([messages, system_prompt], ensure_ascii=False))
            async for part in super().stream(messages, system_prompt):
                yield part

    monkeypatch.setattr("app.agent.providers.PrivateMockLLM", ObservingMock)
    accepted = []
    for index, one in enumerate([*pets, foreign]):
        use_account(client, b_cookies if index == 3 else a_cookies)
        chat = session(client, one["pet_id"])
        sent = send(client, one["pet_id"], chat["id"], "想聊聊简短自然的交流。")
        run(client)
        state = client.get(url(one, chat, sent)).json()
        assert state["generation"]["state"] == "completed"
        assert state["generation"]["provider"] == ("deepseek" if index == 0 else "mock")
        accepted.append((index, one, sent))
        if index:
            assert markers[index] in observed_mock[-1]
            assert all(
                marker not in observed_mock[-1] for marker in markers if marker != markers[index]
            )
    assert len(records["requests"]) == 1 and len(observed_mock) == 3
    sdk_input = json.dumps(json.loads(records["requests"][0].content), ensure_ascii=False)
    assert all(marker not in sdk_input for marker in markers)
    assert "authorized_memory_data" not in sdk_input
    with engine.connect() as db:
        for index, one, sent in accepted:
            context = (
                db.execute(
                    select(PetGenerationContext.__table__).where(
                        PetGenerationContext.generation_id == UUID(sent["generation"]["id"])
                    )
                )
                .mappings()
                .one()
            )
            assert context["pet_id"] == UUID(one["pet_id"])
            refs = context["memory_refs"]
            assert [ref["memory_id"] for ref in refs] == (
                [] if index == 0 else [memories[one["pet_id"]]["id"]]
            )
    assert settings.llm_provider == "mock" and settings.memory_injection_enabled


def test_target_removed_after_acceptance_fails_before_upstream(mixed):
    client, _, settings, records, _, pets, *_ = mixed
    one = pets[0]
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    settings.dev_deepseek_pet_id = settings.dev_deepseek_pet_owner_id = None
    settings.real_llm_enabled = False
    run(client)
    status = client.get(url(one, chat, accepted)).json()["generation"]
    assert status["state"] == "failed" and not records["requests"]
    assert status["provider"] == "deepseek"  # No silent change to the already accepted task.


def test_pending_mock_task_is_not_upgraded_when_target_is_enabled(mixed):
    client, _, settings, records, _, pets, *_ = mixed
    owner, target = settings.dev_deepseek_pet_owner_id, settings.dev_deepseek_pet_id
    settings.dev_deepseek_pet_id = settings.dev_deepseek_pet_owner_id = None
    settings.real_llm_enabled = False
    one = pets[0]
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    settings.dev_deepseek_pet_owner_id, settings.dev_deepseek_pet_id = owner, target
    settings.real_llm_enabled = True
    run(client)
    result = client.get(url(one, chat, accepted)).json()
    assert result["generation"]["state"] == "completed"
    assert result["generation"]["provider"] == "mock" and not records["requests"]


def test_target_rechecked_at_final_dispatch_boundary(mixed, monkeypatch):
    client, _, settings, records, _, pets, *_ = mixed
    one = pets[0]
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    original = PetGenerationMemoryRuntime.before_provider

    async def changed_scope(runtime, state):
        settings.dev_deepseek_pet_id = UUID(pets[1]["pet_id"])
        return await original(runtime, state)

    monkeypatch.setattr(PetGenerationMemoryRuntime, "before_provider", changed_scope)
    run(client)
    assert client.get(url(one, chat, accepted)).json()["generation"]["state"] == "failed"
    assert not records["requests"]


def test_target_sdk_errors_are_persisted_safely_without_affecting_other_mock_pet(mixed):
    client, _, _, records, control, pets, *_ = mixed
    control["error"] = True
    one = pets[0]
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    run(client)
    response = client.get(url(one, chat, accepted))
    assert response.json()["generation"]["state"] == "failed"
    assert FAKE_KEY not in response.text and len(records["requests"]) == 1
    sibling = pets[1]
    other_chat = session(client, sibling["pet_id"])
    other = send(client, sibling["pet_id"], other_chat["id"])
    run(client)
    assert client.get(url(sibling, other_chat, other)).json()["generation"]["state"] == "completed"
    assert len(records["requests"]) == 1
