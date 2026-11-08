"""Owner-local memory policy fences; no extraction, retrieval or model injection."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select, update

from app.agent.chat_protocol import terminalize
from app.db.capabilities import read_revision
from app.modules.companion.models import ChatGeneration, ChatMessage, ChatSession


@dataclass(frozen=True)
class MemoryEpoch:
    epoch: int = 0
    floor: int = 0
    context_not_before: datetime | None = None


async def read_memory_epoch(db, owner_id: UUID, *, lock: bool = False) -> MemoryEpoch:
    if await read_revision(db) not in {"0005", "0006"}:
        return MemoryEpoch()
    from app.modules.memory.models import MemoryPreferences

    query = select(MemoryPreferences).where(MemoryPreferences.user_id == owner_id)
    if lock:
        query = query.with_for_update()
    row = await db.scalar(query)
    if row is None:
        return MemoryEpoch()
    return MemoryEpoch(row.privacy_epoch, row.context_epoch_floor, row.context_not_before)


async def generation_memory_epoch(db, generation_id: UUID, owner_id: UUID) -> int:
    if await read_revision(db) not in {"0005", "0006"}:
        return 0
    table = ChatGeneration.__table__
    value = await db.scalar(
        select(table.c.memory_epoch).where(
            table.c.id == generation_id, table.c.owner_id == owner_id
        )
    )
    return value or 0


async def pin_generation_memory_epoch(
    db, generation_id: UUID, owner_id: UUID, policy: MemoryEpoch
) -> None:
    if await read_revision(db) not in {"0005", "0006"}:
        return
    table = ChatGeneration.__table__
    await db.execute(
        update(table)
        .where(table.c.id == generation_id, table.c.owner_id == owner_id)
        .values(memory_epoch=policy.epoch, memory_context_not_before=policy.context_not_before)
    )


def historical_epoch_condition(floor: int):
    return func.coalesce(ChatGeneration.__table__.c.memory_epoch, 0) >= floor


async def invalidate_owner_generations(db, owner_id: UUID) -> list[UUID]:
    """Caller holds User then MemoryPreferences; preserve P3's remaining lock order."""
    from app.modules.pets.chat import session_scope

    legacy_scope = await session_scope(db, owner_id, None)
    sessions = list(
        await db.scalars(
            select(ChatSession)
            .where(
                ChatSession.owner_id == owner_id,
                legacy_scope,
                ChatSession.id.in_(
                    select(ChatGeneration.session_id).where(
                        ChatGeneration.owner_id == owner_id,
                        ChatGeneration.state.in_(("queued", "running", "cancel_requested")),
                    )
                ),
            )
            .order_by(ChatSession.id)
            .with_for_update()
        )
    )
    cancelled = []
    for session in sessions:
        generations = list(
            await db.scalars(
                select(ChatGeneration)
                .where(
                    ChatGeneration.owner_id == owner_id,
                    ChatGeneration.session_id == session.id,
                    ChatGeneration.state.in_(("queued", "running", "cancel_requested")),
                )
                .order_by(ChatGeneration.id)
                .with_for_update()
            )
        )
        for generation in generations:
            assistant = await db.scalar(
                select(ChatMessage)
                .where(
                    ChatMessage.id == generation.assistant_message_id,
                    ChatMessage.owner_id == owner_id,
                    ChatMessage.session_id == session.id,
                    ChatMessage.role == "assistant",
                )
                .with_for_update()
            )
            if assistant is None:
                raise ValueError("Generation assistant is unavailable")
            if await terminalize(
                db, session, generation, assistant, "cancelled", reason="memory_policy_changed"
            ):
                cancelled.append(generation.id)
    return cancelled
