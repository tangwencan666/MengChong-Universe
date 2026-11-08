"""Regressions for privacy invalidation crossing P3 cancellation states."""

from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf
from pydantic import ValidationError
from sqlalchemy import func, select, update
from test_memory_api import PREFIX, account, command, create_item, enable, preferences
from test_memory_api import memory_client as memory_client

from app.core.config import Settings
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.memory.models import Memory
from app.modules.wallet.models import Wallet, WalletTransaction


def test_memory_change_preserves_privacy_reason_for_already_requested_cancel(
    memory_client, auth_database
):
    account(memory_client)
    enable(memory_client)
    header = lambda: csrf(memory_client) | {"Idempotency-Key": str(uuid4())}  # noqa: E731
    created = memory_client.post(
        "/api/v1/companion/sessions", json={"title": "privacy boundary"}, headers=header()
    )
    assert created.status_code == 201
    session_id = created.json()["session"]["id"]
    accepted = memory_client.post(
        f"/api/v1/companion/sessions/{session_id}/messages",
        json={"client_message_id": str(uuid4()), "content": "synthetic privacy boundary"},
        headers=header(),
    )
    assert accepted.status_code == 202
    generation_id = UUID(accepted.json()["generation"]["id"])
    assistant_id = UUID(accepted.json()["assistant_message"]["id"])
    with auth_database[0].begin() as db:
        db.execute(
            update(ChatGeneration)
            .where(ChatGeneration.id == generation_id)
            .values(state="cancel_requested")
        )
    create_item(memory_client)
    with auth_database[0].connect() as db:
        assert (
            db.scalar(select(ChatGeneration.state).where(ChatGeneration.id == generation_id))
            == "cancelled"
        )
        assert (
            db.scalar(select(ChatMessage.status).where(ChatMessage.id == assistant_id))
            == "cancelled"
        )
        events = db.execute(
            select(ChatGenerationEvent.event_type, ChatGenerationEvent.payload)
            .where(ChatGenerationEvent.generation_id == generation_id)
            .order_by(ChatGenerationEvent.event_sequence)
        ).all()
        assert [event[0] for event in events] == ["start", "cancelled"]
        assert events[-1][1]["reason"] == "memory_policy_changed"
    history = memory_client.get(f"/api/v1/companion/sessions/{session_id}/messages")
    assert history.status_code == 200
    assert len(history.json()["items"]) == 2


def test_management_requires_stable_key_and_injection_cannot_be_enabled():
    with pytest.raises(ValidationError):
        Settings(memory_management_enabled=True, memory_hmac_key=None)
    with pytest.raises(ValidationError):
        Settings(memory_injection_enabled=True)


def test_zero_wallet_balance_does_not_remove_or_block_memory_management(
    memory_client, auth_database
):
    user, _ = account(memory_client)
    owner = UUID(user["id"])
    wallet_id = uuid4()
    with auth_database[0].begin() as db:
        db.execute(Wallet.__table__.insert().values(id=wallet_id, owner_id=owner, balance=1))
    enable(memory_client)
    existing = create_item(memory_client)
    with auth_database[0].begin() as db:
        db.execute(update(Wallet).where(Wallet.id == wallet_id).values(balance=0))
    current = memory_client.get(f"{PREFIX}/items/{existing['id']}")
    assert current.status_code == 200 and current.json()["status"] == "active"
    create_item(memory_client, title="零余额时仍可主动管理的普通事项")
    exported = command(memory_client, "POST", "/export", {"format": "json"})
    assert exported.status_code == 200 and len(exported.json()["items"]) == 2
    cleared = command(
        memory_client,
        "POST",
        "/clear",
        {
            "confirmed": True,
            "expected_revision": preferences(memory_client)["revision"],
        },
    )
    assert cleared.status_code == 204
    with auth_database[0].connect() as db:
        assert db.scalar(select(Wallet.balance).where(Wallet.id == wallet_id)) == 0
        assert db.scalar(select(func.count()).select_from(WalletTransaction)) == 0
        assert (
            db.scalar(
                select(func.count())
                .select_from(Memory)
                .where(Memory.owner_id == owner, Memory.status == "deleted")
            )
            == 2
        )
