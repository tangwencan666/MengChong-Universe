"""Actual auth/chat/SDK integration, ONLY HTTPX MockTransport and disposable SQLite."""

from datetime import timedelta
from urllib.parse import urlencode
from uuid import UUID, uuid4

import pytest
from beta_helpers import beta_settings, install_beta_schema
from integration.test_beta_quota_postgres import postgres as postgres
from pydantic import SecretStr
from sqlalchemy import func, select, update
from test_deepseek_pet_runtime import complete, endpoint
from test_deepseek_pet_runtime import deepseek_pet as deepseek_pet
from test_deepseek_provider import transport as transport
from test_pet_chat import account, cmd, pet, send, session

from app.core.config import Settings
from app.modules.beta_quota import service as quota
from app.modules.beta_quota.models import (
    BetaAccount,
    BetaInvitation,
    BetaQuotaEvent,
    BetaReservation,
)
from app.modules.companion.models import ChatGeneration
from app.modules.users.models import User


@pytest.fixture
def auth_database(postgres):
    # The real-provider gate requires PostgreSQL even with an HTTPX MockTransport.
    engine, url, schema, _ = postgres
    settings = Settings(
        environment="test",
        database_url=SecretStr(url + "?" + urlencode({"options": "-csearch_path=" + schema})),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        cors_origins=["http://testserver"],
    )
    yield engine, settings


@pytest.fixture
def beta_chat(deepseek_pet):
    client, engine, settings, records, control = deepseek_pet
    install_beta_schema(engine)
    policy = beta_settings(settings)
    for field in type(policy).model_fields:
        if field.startswith("beta_"):
            setattr(settings, field, getattr(policy, field))
    return client, engine, settings, records, control


def grant(client, engine, count=2):
    owner = UUID(client.get("/api/v1/auth/me").json()["id"])
    code = "p83-sdk-mock-invitation-no-real-secret-0001"
    with engine.begin() as db:
        db.execute(update(User).where(User.id == owner).values(email_verified_at=quota.now()))
        db.execute(
            BetaInvitation.__table__.insert().values(
                code_hash=quota.invitation_hash(code),
                grant_requests=count,
                expires_at=quota.now() + timedelta(days=1),
                grant_expires_at=quota.now() + timedelta(days=7),
            )
        )
    for _ in range(2):
        response = cmd(client, "POST", "/beta/quota/claim", {"invitation": code})
        assert response.status_code == 200, response.text
        assert response.json()["remaining"] == count
    return owner


def test_chat_rejects_unclaimed_credit_before_acceptance_or_sdk(beta_chat):
    client, engine, _, records, _ = beta_chat
    account(client)
    one = pet(client)
    chat = session(client, one["pet_id"])
    response = cmd(
        client,
        "POST",
        f"/pets/{one['pet_id']}/sessions/{chat['id']}/messages",
        {"client_message_id": str(uuid4()), "content": "offline"},
        str(uuid4()),
    )
    assert response.status_code == 429 and records["requests"] == []
    with engine.connect() as db:
        assert db.scalar(select(func.count()).select_from(ChatGeneration)) == 0


def test_http_idempotency_and_completion_consume_one_slot(beta_chat):
    client, engine, _, records, _ = beta_chat
    account(client)
    owner = grant(client, engine)
    one = pet(client)
    chat = session(client, one["pet_id"])
    key, message = str(uuid4()), str(uuid4())
    accepted = send(client, one["pet_id"], chat["id"], "offline", key=key, message_id=message)
    duplicate = send(client, one["pet_id"], chat["id"], "offline", key=key, message_id=message)
    assert duplicate["generation"]["id"] == accepted["generation"]["id"]
    complete(client, one, chat, accepted)
    assert len(records["requests"]) == 1
    with engine.connect() as db:
        assert db.scalar(select(BetaAccount.spent).where(BetaAccount.owner_id == owner)) == 1
        assert db.scalar(select(func.count()).select_from(BetaQuotaEvent)) == 3


def test_queued_cancel_releases_and_mock_sdk_failure_after_admission_does_not_refund(beta_chat):
    client, engine, _, records, control = beta_chat
    account(client)
    owner = grant(client, engine, 1)
    one = pet(client)
    chat = session(client, one["pet_id"])
    first = send(client, one["pet_id"], chat["id"])
    assert (
        cmd(
            client, "POST", endpoint(one, chat, first).removeprefix("/api/v1") + "/cancel", {}
        ).status_code
        == 200
    )
    assert records["requests"] == []
    control["prefix"] = {"invalid": "offline SDK response type"}
    accepted = send(client, one["pet_id"], chat["id"])
    assert client.portal.call(client.app.state.chat_runner.run_once)
    assert client.get(endpoint(one, chat, accepted)).json()["generation"]["state"] == "failed"
    assert len(records["requests"]) == 1
    with engine.connect() as db:
        assert db.scalar(select(BetaAccount.spent).where(BetaAccount.owner_id == owner)) == 1
        states = list(db.scalars(select(BetaReservation.state)))
        assert sorted(states) == ["released", "settled"]


def test_turning_off_beta_after_acceptance_blocks_sdk_and_releases_reservation(beta_chat):
    client, engine, settings, records, _ = beta_chat
    account(client)
    owner = grant(client, engine)
    one = pet(client)
    chat = session(client, one["pet_id"])
    accepted = send(client, one["pet_id"], chat["id"])
    settings.beta_quota_enabled = False
    assert client.portal.call(client.app.state.chat_runner.run_once)
    row = client.get(endpoint(one, chat, accepted)).json()["generation"]
    assert row["state"] == "failed" and row["error"]["code"] == "BETA_QUOTA_UNAVAILABLE"
    assert records["requests"] == []
    with engine.connect() as db:
        assert db.scalar(select(BetaAccount.reserved).where(BetaAccount.owner_id == owner)) == 0
