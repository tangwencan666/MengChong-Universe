"""Real PostgreSQL privacy barriers fence writes from already-running chat jobs.

Only the isolated P4-A fixture is used. No model providers execute, no migrations
or cleanup statements run here, and synthetic records remain as acceptance evidence.
"""

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from time import monotonic
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, select, text
from test_memory_postgres import (
    CHAT,
    client_for,
    command,
    create_memory,
    enable,
)
from test_memory_postgres import (
    isolated_memory_postgres as isolated_memory_postgres,
)
from test_memory_postgres import (
    pg_memory_accounts as pg_memory_accounts,
)

from app.agent.chat_protocol import utcnow
from app.agent.chat_runner import _Claim, _FenceLost, _Identity
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.memory.models import Memory, MemoryPreferences
from app.modules.memory.service import MemoryService

pytestmark = pytest.mark.skipif(
    not os.environ.get("WEIBIYE_P4A_TEST_DATABASE_URL"),
    reason="Requires the strictly guarded isolated P4-A PostgreSQL fixture",
)


@pytest.mark.parametrize("late_operation", ["flush", "finish"])
def test_pg_privacy_delete_fences_an_inflight_running_generation(
    pg_memory_accounts, monkeypatch, late_operation
):
    engine, settings, ((account, owner), _) = pg_memory_accounts
    enable(account)
    memory, _ = create_memory(account)
    created = command(
        account, "POST", "/sessions", {"title": "P4APG privacy barrier race"}, prefix=CHAT
    )
    assert created.status_code == 201
    session_id = created.json()["session"]["id"]
    sent = command(
        account,
        "POST",
        f"/sessions/{session_id}/messages",
        {"client_message_id": str(uuid4()), "content": "P4APG privacy race probe"},
        prefix=CHAT,
    )
    assert sent.status_code == 202
    generation_id = UUID(sent.json()["generation"]["id"])
    identity = _Identity(generation_id, owner, UUID(session_id))
    runner = account.app.state.chat_runner

    async def claim_without_provider():
        # A public API has already committed the owned queued task and messages.
        # Advance its worker state explicitly, without starting a real/mock provider.
        async with runner._locked(identity) as locked:
            assert locked is not None
            db, _, generation, assistant = locked
            assert generation.state == "queued"
            generation.state = "running"
            generation.started_at = utcnow()
            generation.lease_version += 1
            generation.lease_expires_at = utcnow() + timedelta(seconds=60)
            assistant.status = "streaming"
            return _Claim(
                identity,
                generation.lease_version,
                generation.provider,
                generation.model,
                generation.prompt_version,
                tuple(generation.context_message_ids),
                generation.user_message_id,
                db.info["generation_memory_epoch"],
            )

    claim = account.portal.call(claim_without_provider)
    committed_prefix = "P4APG prefix committed before privacy deletion."
    late_text = "P4APG stale write must never be persisted."
    account.portal.call(runner._flush, claim, committed_prefix)

    deletion_holds_owner = Event()
    release_deletion = Event()
    writer_requested_owner = Event()
    backends = {}
    original_advance = MemoryService.advance

    async def pause_privacy_transaction(service, db, preference, *, removal=False):
        if service.owner == owner and removal:
            # remove() has obtained User then Prefs; it has not cancelled the job yet.
            backends["delete"] = await db.scalar(text("SELECT pg_backend_pid()"))
            assert preference.privacy_epoch == claim.memory_epoch
            deletion_holds_owner.set()
            released = await asyncio.to_thread(release_deletion.wait, 30)
            assert released, "Test coordinator did not release the isolated privacy transaction"
        return await original_advance(service, db, preference, removal=removal)

    monkeypatch.setattr(MemoryService, "advance", pause_privacy_transaction)

    def note_writer_lock_request(connection, _cursor, statement, _parameters, _context, _many):
        normalized = " ".join(statement.lower().replace('"', "").split())
        if " from users " in normalized and "for update" in normalized:
            driver = connection.connection.driver_connection
            backends["writer"] = driver.info.backend_pid
            writer_requested_owner.set()

    writer_engine = account.app.state.engine.sync_engine
    event.listen(writer_engine, "before_cursor_execute", note_writer_lock_request)
    cookies = dict(account.cookies)

    def delete_memory_from_a_second_connection():
        with client_for(settings) as deletion_client:
            deletion_client.cookies.update(cookies)
            return command(
                deletion_client,
                "DELETE",
                f"/items/{memory['id']}",
                {"expected_version": memory["version"]},
            )

    async def attempt_old_worker_write():
        if late_operation == "flush":
            with pytest.raises(_FenceLost):
                await runner._flush(claim, late_text)
            return "fenced"
        return await runner._finish(claim, "completed", pending=late_text, reason="stop")

    def write_from_the_old_running_claim():
        return account.portal.call(attempt_old_worker_write)

    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            deletion_future = workers.submit(delete_memory_from_a_second_connection)
            try:
                assert deletion_holds_owner.wait(30), "Privacy command never acquired owner locks"
                old_write_future = workers.submit(write_from_the_old_running_claim)
                assert writer_requested_owner.wait(30), "Old worker never attempted User FOR UPDATE"
                # Observe actual PostgreSQL blocking, not a sleep-based timing assumption.
                deadline = monotonic() + 20
                blocked_by_privacy_command = False
                with engine.connect() as probe:
                    probe.execute(text("SET TRANSACTION READ ONLY"))
                    while monotonic() < deadline:
                        blockers = probe.scalar(
                            text("SELECT pg_blocking_pids(:backend)"),
                            {"backend": backends["writer"]},
                        )
                        if backends["delete"] in blockers:
                            blocked_by_privacy_command = True
                            break
                assert blocked_by_privacy_command, "Old write did not actually wait for deletion"
                release_deletion.set()
                deleted = deletion_future.result(timeout=30)
                assert deleted.status_code == 204
                result = old_write_future.result(timeout=30)
                assert result == ("fenced" if late_operation == "flush" else None)
            finally:
                # Even a failed assertion must release only this test's held transaction.
                release_deletion.set()
    finally:
        event.remove(writer_engine, "before_cursor_execute", note_writer_lock_request)
        release_deletion.set()

    with engine.connect() as db:
        generation = db.execute(
            select(ChatGeneration.state, ChatGeneration.lease_version).where(
                ChatGeneration.id == generation_id, ChatGeneration.owner_id == owner
            )
        ).one()
        assert generation.state == "cancelled" and generation.lease_version > claim.lease_version
        assistant = db.execute(
            select(ChatMessage.content, ChatMessage.status).where(
                ChatMessage.id == UUID(sent.json()["assistant_message"]["id"]),
                ChatMessage.owner_id == owner,
            )
        ).one()
        assert assistant.content == committed_prefix and assistant.status == "cancelled"
        journal = list(
            db.execute(
                select(
                    ChatGenerationEvent.event_sequence,
                    ChatGenerationEvent.event_type,
                    ChatGenerationEvent.payload,
                )
                .where(
                    ChatGenerationEvent.generation_id == generation_id,
                    ChatGenerationEvent.owner_id == owner,
                )
                .order_by(ChatGenerationEvent.event_sequence)
            ).mappings()
        )
        assert [row["event_sequence"] for row in journal] == [1, 2, 3]
        assert [row["event_type"] for row in journal] == ["start", "delta", "cancelled"]
        assert journal[1]["payload"]["text"] == committed_prefix
        assert journal[-1]["payload"]["reason"] == "memory_policy_changed"
        assert journal[-1]["payload"]["content"] == committed_prefix
        erased = db.execute(
            select(Memory.status, Memory.content, Memory.title, Memory.summary).where(
                Memory.id == UUID(memory["id"]), Memory.owner_id == owner
            )
        ).one()
        assert tuple(erased) == ("deleted", "", "", "")
        policy = db.execute(
            select(MemoryPreferences.privacy_epoch, MemoryPreferences.context_epoch_floor).where(
                MemoryPreferences.user_id == owner
            )
        ).one()
        assert policy.privacy_epoch > claim.memory_epoch
        assert policy.context_epoch_floor == policy.privacy_epoch
