"""Desktop model opt-in: synthetic keys, disposable SQLite, HTTPX MockTransport only."""

import json
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from test_chat_stream import parse_frames
from test_deepseek_provider import BytesStream, frame
from test_deepseek_provider import transport as transport
from test_memory_api import use_account
from test_memory_injection import open_client
from test_pet_chat import account, cmd, pet
from test_pet_chat import send as send_pet
from test_pet_chat import session as pet_session

from app.agent.local_deepseek_budget import LocalDeepSeekBudget, LocalModelBudgetError
from app.agent.provider_selection import resolved_generation_settings, select_chat_provider
from app.core.config import Settings
from app.core.errors import AppError

OWNER, FIRST, SECOND, FOREIGN = uuid4(), uuid4(), uuid4(), uuid4()
KEY = "local-desktop-synthetic-credential-only"


def session(client, one):
    return pet_session(client, one["pet_id"])


def send(client, one, chat, content="今天想聊聊"):
    return send_pet(client, one["pet_id"], chat["id"], content)


def configured(**changes):
    return Settings(
        **(
            {
                "environment": "development",
                "llm_provider": "mock",
                "real_llm_enabled": True,
                "deepseek_api_key": SecretStr(KEY),
                "local_deepseek_pets": [
                    {"owner_id": OWNER, "pet_id": FIRST},
                    {"owner_id": OWNER, "pet_id": SECOND},
                ],
                "local_deepseek_max_requests": 2,
            }
            | changes
        )
    )


def test_key_alias_precedence_explicit_values_and_redaction(monkeypatch):
    monkeypatch.delenv("WEIBIYE_DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", KEY)
    assert Settings().deepseek_api_key.get_secret_value() == KEY
    other = "another-synthetic-key"
    monkeypatch.setenv("WEIBIYE_DEEPSEEK_API_KEY", other)
    assert Settings().deepseek_api_key.get_secret_value() == other
    explicit = Settings(deepseek_api_key=SecretStr(KEY))
    assert explicit.deepseek_api_key.get_secret_value() == KEY
    assert Settings(deepseek_api_key=None).deepseek_api_key is None
    rebuilt = Settings.model_validate(explicit.model_dump() | {"deepseek_api_key": KEY})
    assert rebuilt.deepseek_api_key.get_secret_value() == KEY
    assert KEY not in repr(explicit) + explicit.model_dump_json()
    assert "deepseek_api_key" not in explicit.model_dump()
    assert select_chat_provider(Settings()).provider == "mock"


def test_blank_canonical_key_does_not_silently_switch_to_another_account(monkeypatch):
    monkeypatch.setenv("WEIBIYE_DEEPSEEK_API_KEY", " ")
    monkeypatch.setenv("DEEPSEEK_API_KEY", KEY)
    with pytest.raises(ValidationError):
        Settings(llm_provider="deepseek", real_llm_enabled=True)


@pytest.mark.parametrize(
    "changes",
    [
        {"environment": "production"},
        {"environment": "test"},
        {"llm_provider": "deepseek"},
        {"real_llm_enabled": False},
        {"deepseek_api_key": None},
        {"local_deepseek_max_requests": 0},
        {"local_deepseek_max_requests": 101},
        {"local_deepseek_pets": []},
        {"deepseek_max_tokens": 513},
        {"dev_deepseek_pet_owner_id": OWNER, "dev_deepseek_pet_id": FIRST},
        {"local_deepseek_pets": [{"owner_id": OWNER, "pet_id": FIRST}] * 2},
        {"local_deepseek_pets": [{"owner_id": OWNER, "pet_id": FIRST, "name": "月芽"}]},
    ],
)
def test_local_paid_scope_requires_every_gate(changes):
    with pytest.raises(ValidationError):
        configured(**changes)


def test_multiple_instances_route_by_owner_and_id_without_mutating_defaults():
    settings = configured()
    for one in (FIRST, SECOND):
        selection = select_chat_provider(settings, OWNER, one)
        assert (selection.provider, selection.model, selection.memory_injection_enabled) == (
            "deepseek",
            "deepseek-flash",
            False,
        )
        effective = resolved_generation_settings(settings, OWNER, one, "deepseek", "deepseek-flash")
        assert effective.llm_provider == "deepseek" and not effective.local_deepseek_pets
        assert effective.local_deepseek_max_requests == 0
    for owner, one in [(FOREIGN, FIRST), (OWNER, FOREIGN), (OWNER, None), (None, FIRST)]:
        assert select_chat_provider(settings, owner, one).provider == "mock"
        with pytest.raises(AppError):
            resolved_generation_settings(settings, owner, one, "deepseek", "deepseek-flash")
    assert settings.llm_provider == "mock" and len(settings.local_deepseek_pets) == 2
    assert resolved_generation_settings(settings, OWNER, FIRST, "mock", None).llm_provider == "mock"


def test_budget_is_atomic_shared_and_rejects_changed_configuration():
    settings = configured()
    budget = LocalDeepSeekBudget(settings)

    def attempt(_):
        try:
            budget.admit(settings, [{"role": "user", "content": "hello"}], "safe")
            return True
        except LocalModelBudgetError as error:
            assert error.code == "LOCAL_MODEL_BUDGET_EXHAUSTED"
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(attempt, range(20))) == 2
    assert budget.used == 2
    with pytest.raises(LocalModelBudgetError, match="LOCAL_MODEL_POLICY_CHANGED"):
        budget.admit(settings.model_copy(update={"local_deepseek_max_requests": 3}), [], "safe")


def test_oversized_input_is_rejected_before_spending_a_slot():
    settings = configured(local_deepseek_max_input_bytes=256)
    budget = LocalDeepSeekBudget(settings)
    with pytest.raises(LocalModelBudgetError) as error:
        budget.admit(settings, [{"role": "user", "content": "鲸" * 200}], "safe")
    assert error.value.code == "LOCAL_MODEL_INPUT_LIMIT" and budget.used == 0


@pytest.fixture
def local_chat(auth_database, transport):
    engine, baseline = auth_database
    control = {"status": 200}

    def upstream(_):
        if control["status"] != 200:
            return httpx.Response(control["status"], json={"error": {"message": KEY}})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=BytesStream(
                [
                    frame("【离线协议测试】"),
                    frame("本实例的回复"),
                    frame(
                        finish="stop",
                        usage={"prompt_tokens": 30, "completion_tokens": 8, "total_tokens": 38},
                    ),
                ]
            ),
        )

    records = transport(upstream)
    with open_client(baseline) as setup:
        cookies_a = account(setup)
        owner_a = UUID(setup.get("/api/v1/auth/me").json()["id"])
        a, b, unselected = pet(setup, "同名哈吉米"), pet(setup, "同名哈吉米"), pet(setup, "豆包")
        setup.cookies.clear()
        cookies_b = account(setup, "local-model-another@example.com")
        foreign = pet(setup, "同名哈吉米")
    options = configured(
        local_deepseek_pets=[{"owner_id": owner_a, "pet_id": UUID(p["pet_id"])} for p in [a, b]],
        database_url=baseline.database_url,
        auth_store_backend="memory",
        rate_limit_backend="memory",
        cors_origins=["http://testserver"],
        chat_runner_enabled=False,
    )
    with open_client(options) as client:
        use_account(client, cookies_a)
        yield client, records, control, (a, b, unselected, foreign), cookies_a, cookies_b


def endpoint(one, chat, accepted):
    return (
        f"/api/v1/pets/{one['pet_id']}/sessions/{chat['id']}/generations/"
        + accepted["generation"]["id"]
    )


def run(client, one, chat, accepted):
    assert client.portal.call(client.app.state.chat_runner.run_once)
    response = client.get(endpoint(one, chat, accepted))
    assert response.status_code == 200
    return response.json()["generation"]


def test_two_same_name_pets_share_budget_but_never_private_history(local_chat):
    client, records, _, (a, b, unselected, _), _, _ = local_chat
    first, second = session(client, a), session(client, b)
    one = send(client, a, first, "ONLY_FIRST_PRIVATE_74a")
    assert run(client, a, first, one)["state"] == "completed"
    two = send(client, b, second, "ONLY_SECOND_PRIVATE_19b")
    generation = run(client, b, second, two)
    assert generation["state"] == "completed"
    frames = parse_frames(client.get(endpoint(b, second, two) + "/events").text)
    assert frames[-1]["event"] == "completed"
    assert frames[-1]["data"]["usage"] == {"input_tokens": 30, "output_tokens": 8}
    assert len(records["requests"]) == 2
    payloads = [json.loads(request.content) for request in records["requests"]]
    assert "ONLY_SECOND_PRIVATE_19b" not in json.dumps(payloads[0])
    assert "ONLY_FIRST_PRIVATE_74a" not in json.dumps(payloads[1])
    three = send(client, a, first, "third attempt")
    denied = run(client, a, first, three)
    assert denied["state"] == "failed" and denied["error"]["code"] == "LOCAL_MODEL_BUDGET_EXHAUSTED"
    assert len(records["requests"]) == 2
    assert KEY not in json.dumps(denied)
    mock = session(client, unselected)
    accepted = send(client, unselected, mock)
    assert run(client, unselected, mock, accepted)["provider"] == "mock"
    assert len(records["requests"]) == 2


def test_runtime_and_history_never_reveal_foreign_pet(local_chat):
    client, records, _, (a, _, unselected, foreign), cookies_a, cookies_b = local_chat
    assert client.get(f"/api/v1/pets/{a['pet_id']}/runtime").json()["provider"] == "deepseek"
    assert client.get(f"/api/v1/pets/{unselected['pet_id']}/runtime").json()["provider"] == "mock"
    assert client.get(f"/api/v1/pets/{foreign['pet_id']}/runtime").status_code == 404
    use_account(client, cookies_b)
    assert client.get(f"/api/v1/pets/{a['pet_id']}/runtime").status_code == 404
    assert client.get(f"/api/v1/pets/{foreign['pet_id']}/runtime").json()["provider"] == "mock"
    use_account(client, cookies_a)
    assert records["requests"] == []


def test_failed_upstream_consumes_slot_and_manual_retry_cannot_refund_it(local_chat):
    client, records, control, (a, _, _, _), _, _ = local_chat
    control["status"] = 429
    chat = session(client, a)
    first = send(client, a, chat)
    assert run(client, a, chat, first)["state"] == "failed"
    assert len(records["requests"]) == 1  # SDK retries remain zero.
    control["status"] = 200
    second = send(client, a, chat, "a new message")
    assert run(client, a, chat, second)["state"] == "completed"
    third = send(client, a, chat, "cannot exceed the run budget")
    assert run(client, a, chat, third)["error"]["code"] == "LOCAL_MODEL_BUDGET_EXHAUSTED"
    assert len(records["requests"]) == 2


def test_same_send_idempotency_key_does_not_dispatch_twice(local_chat):
    client, records, _, (a, _, _, _), _, _ = local_chat
    chat = session(client, a)
    key = str(uuid4())
    base = f"/pets/{a['pet_id']}/sessions/{chat['id']}"
    payload = {"content": "one user click", "client_message_id": str(uuid4())}
    first = cmd(client, "POST", base + "/messages", payload, key)
    assert first.status_code == 202
    assert run(client, a, chat, first.json())["state"] == "completed"
    replay = cmd(client, "POST", base + "/messages", payload, key)
    assert (
        replay.status_code == 202
        and replay.json()["generation"]["id"] == first.json()["generation"]["id"]
    )
    assert len(records["requests"]) == 1
