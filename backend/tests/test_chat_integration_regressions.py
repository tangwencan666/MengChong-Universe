"""Terminal metadata must survive snapshot recovery without a replayable stream.

Only new per-test SQLite databases are used. These regressions never connect to
the PostgreSQL development database, Redis, or a real model provider.
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, insert, select, update
from test_chat import (
    PREFIX,
    assert_error,
    command,
    create_session,
    generation_path,
    identity,
    run_one,
    send,
)
from test_chat import chat_client as chat_client
from test_chat import chat_database as chat_database

from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage


@pytest.mark.parametrize("reason", ["stop", "length"])
def test_terminal_metadata_survives_snapshot_history_replay_and_cancel(
    chat_client, chat_database, monkeypatch, reason
):
    class LocalProvider:
        name = "mock"

        async def stream(self, messages, system_prompt):
            yield "答" * (9000 if reason == "length" else 3)

    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_: LocalProvider())
    identity(chat_client)
    session = create_session(chat_client)
    key, client_message_id = str(uuid4()), str(uuid4())
    accepted = send(chat_client, session["id"], key=key, client_message_id=client_message_id)
    assert accepted["generation"]["finish_reason"] is None
    assert accepted["assistant_message"]["finish_reason"] is None
    run_one(chat_client)
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"])

    # The first read is an already-terminal snapshot: no SSE has been consumed.
    snapshot = chat_client.get(path).json()
    assert snapshot["generation"]["state"] == "completed"
    assert snapshot["generation"]["finish_reason"] == reason
    assert snapshot["assistant_message"]["finish_reason"] == reason
    history = chat_client.get(PREFIX + f"/sessions/{session['id']}/messages").json()["items"]
    assert history[0]["finish_reason"] is None
    assert history[-1] == snapshot["assistant_message"]
    replay = send(chat_client, session["id"], key=key, client_message_id=client_message_id)
    assert replay["idempotent_replay"] is True
    assert replay["generation"]["finish_reason"] == reason
    assert replay["assistant_message"] == snapshot["assistant_message"]
    cancellation = command(chat_client, "POST", path.removeprefix(PREFIX) + "/cancel", {})
    assert cancellation.status_code == 200
    assert cancellation.json()["generation"]["finish_reason"] == reason

    # The journal remains the source even after the SSE replay window expires.
    with chat_database[0].begin() as db:
        db.execute(
            update(ChatGeneration)
            .where(ChatGeneration.id == UUID(accepted["generation"]["id"]))
            .values(finished_at=datetime.now(UTC) - timedelta(days=2))
        )
    assert chat_client.get(path + "/events").status_code == 410
    restored = chat_client.get(path).json()
    assert restored["generation"]["finish_reason"] == reason
    assert restored["assistant_message"] == snapshot["assistant_message"]


def test_legacy_history_and_missing_terminal_reason_are_unknown(chat_client, chat_database):
    owner = identity(chat_client)
    session = create_session(chat_client)
    # A historical assistant message predating generations has no finish reason.
    legacy_id = uuid4()
    with chat_database[0].begin() as db:
        db.execute(
            insert(ChatMessage).values(
                id=legacy_id,
                owner_id=UUID(owner["id"]),
                session_id=UUID(session["id"]),
                sequence=0,
                role="assistant",
                status="completed",
                content="A preserved pre-P3 message",
                provider="mock",
                completed_at=datetime.now(UTC),
            )
        )
    history = chat_client.get(PREFIX + f"/sessions/{session['id']}/messages").json()["items"]
    assert history[0]["id"] == str(legacy_id)
    assert history[0]["generation_id"] is None
    assert history[0]["finish_reason"] is None

    current = create_session(chat_client)
    accepted = send(chat_client, current["id"])
    run_one(chat_client)
    # Older completed journal payloads may lack this optional metadata.
    with chat_database[0].begin() as db:
        record = db.execute(
            select(ChatGenerationEvent.id, ChatGenerationEvent.payload).where(
                ChatGenerationEvent.generation_id == UUID(accepted["generation"]["id"]),
                ChatGenerationEvent.event_type == "completed",
            )
        ).one()
        payload = {key: value for key, value in record.payload.items() if key != "finish_reason"}
        db.execute(
            update(ChatGenerationEvent)
            .where(ChatGenerationEvent.id == record.id)
            .values(payload=payload)
        )
    snapshot = chat_client.get(
        PREFIX + generation_path(current["id"], accepted["generation"]["id"])
    ).json()
    assert snapshot["generation"]["finish_reason"] is None
    assert snapshot["assistant_message"]["finish_reason"] is None


def test_terminal_metadata_does_not_cross_account_or_soft_delete(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    run_one(chat_client)
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"])
    assert chat_client.get(path).json()["generation"]["finish_reason"] == "stop"
    identity(chat_client, "different-owner@example.com")
    assert_error(chat_client.get(path), 404, "RESOURCE_NOT_FOUND")
    assert_error(
        chat_client.get(PREFIX + f"/sessions/{session['id']}/messages"),
        404,
        "RESOURCE_NOT_FOUND",
    )
    assert_error(
        command(chat_client, "POST", path.removeprefix(PREFIX) + "/cancel", {}),
        404,
        "RESOURCE_NOT_FOUND",
    )
    identity(chat_client, "owner-with-deleted-session@example.com")
    owned = create_session(chat_client)
    generation = send(chat_client, owned["id"])
    run_one(chat_client)
    assert command(chat_client, "DELETE", f"/sessions/{owned['id']}").status_code == 204
    assert_error(
        chat_client.get(PREFIX + generation_path(owned["id"], generation["generation"]["id"])),
        404,
        "RESOURCE_NOT_FOUND",
    )


def test_history_loads_terminal_metadata_in_one_join_not_per_message(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    for number in range(3):
        send(chat_client, session["id"], f"round {number}")
        run_one(chat_client)
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        if "chat_generation_events" in statement:
            statements.append(statement)

    engine = chat_client.app.state.engine.sync_engine
    event.listen(engine, "before_cursor_execute", capture)
    try:
        response = chat_client.get(PREFIX + f"/sessions/{session['id']}/messages")
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 6
    assert [item["finish_reason"] for item in items] == [None, "stop"] * 3
    assert len(statements) == 1
