"""P8 configuration disclosure and immutable task metadata; no model network requests."""

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import select
from test_chat import create_session, identity, send

from app.core.event_loop import new_event_loop
from app.main import create_app
from app.modules.companion.models import ChatGeneration, ChatMessage


@pytest.fixture(params=["mock", "deepseek", "openai"])
def configured_client(auth_database, request, monkeypatch):
    engine, baseline = auth_database
    provider = request.param
    settings = baseline.model_copy(
        update={
            "chat_runner_enabled": False,
            "llm_provider": provider,
            "real_llm_enabled": provider != "mock",
            "deepseek_api_key": SecretStr("synthetic-key-never-sent"),
            "openai_api_key": SecretStr("synthetic-key-never-sent"),
            "deepseek_model": "deepseek-flash",
            "openai_model": "synthetic-openai-model",
        }
    )

    def reject_network(*args, **kwargs):
        pytest.fail("Runtime metadata and queued creation must never construct a model client")

    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", reject_network)
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        yield client, engine, settings


def test_runtime_requires_cookie_and_exposes_only_allowlisted_metadata(configured_client):
    client, _, settings = configured_client
    path = "/api/v1/companion/runtime"
    assert client.get(path).status_code == 401
    identity(client)
    response = client.get(path)
    assert response.status_code == 200
    assert "no-store" in response.headers["cache-control"]
    assert response.json() == {
        "schema_version": "chat-runtime/1",
        "provider": settings.llm_provider,
        "model": settings.selected_model,
        "mode": "mock" if settings.llm_provider == "mock" else "real",
        "billing": "none" if settings.llm_provider == "mock" else "external_provider",
        "memory_injection_enabled": False,
    }
    assert "synthetic-key-never-sent" not in response.text
    assert "api_key" not in response.text and "base_url" not in response.text
    assert client.post(path, json={}).status_code == 405


def test_generation_freezes_selected_provider_model_not_openai_fallback(configured_client):
    client, engine, settings = configured_client
    identity(client)
    session = create_session(client)
    result = send(client, session["id"], "仅测试排队元数据，不运行生成。")
    assert result["generation"]["provider"] == settings.llm_provider
    assert result["generation"]["model"] == settings.selected_model
    with engine.connect() as connection:
        generation = connection.execute(select(ChatGeneration.provider, ChatGeneration.model)).one()
        assistant_provider = connection.scalar(
            select(ChatMessage.provider).where(ChatMessage.role == "assistant")
        )
    assert tuple(generation) == (settings.llm_provider, settings.selected_model)
    assert assistant_provider == settings.llm_provider
    # Environment changes after creation cannot rewrite the accepted task snapshot.
    settings.deepseek_model = "deepseek-v4-pro"
    stored = client.get(
        f"/api/v1/companion/sessions/{session['id']}/generations/{result['generation']['id']}"
    ).json()
    assert stored["generation"]["model"] == result["generation"]["model"]
