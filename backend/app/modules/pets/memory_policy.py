"""Authoritative owner-scoped eligibility and committed, lazy privacy invalidation."""

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select

from app.agent.chat_protocol import terminalize
from app.agent.memory_boundary import MemoryEpoch
from app.core.errors import AppError
from app.db.capabilities import read_revision, require_capability
from app.modules.companion.models import ChatGeneration, ChatMessage, ChatSession
from app.modules.pets.models import Pet, PetChatBinding, PetGenerationContext
from app.modules.pets.models import PetMemory as Memory
from app.modules.pets.models import PetMemoryConsent as MemoryConsentEvent
from app.modules.pets.models import PetMemoryPreferences as MemoryPreferences
from app.modules.pets.models import PetMemorySource as MemorySource
from app.modules.users.models import User


def clock():
    return datetime.now(UTC)


def aware(value):
    return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)


async def source_groups(db, owner_id, pet_id, memory_ids):
    if not memory_ids:
        return {}, set()
    rows = list(
        (
            await db.scalars(
                select(MemorySource)
                .where(
                    MemorySource.pet_id == pet_id,
                    MemorySource.owner_id == owner_id,
                    MemorySource.memory_id.in_(memory_ids),
                )
                .order_by(MemorySource.id)
            )
        ).all()
    )
    groups = {key: [] for key in memory_ids}
    for row in rows:
        groups[row.memory_id].append(row)
    query = (
        select(MemorySource.id)
        .join(
            ChatMessage,
            (MemorySource.message_id == ChatMessage.id)
            & (MemorySource.session_id == ChatMessage.session_id)
            & (MemorySource.owner_id == ChatMessage.owner_id),
        )
        .join(
            ChatSession,
            (ChatSession.id == ChatMessage.session_id)
            & (ChatSession.owner_id == ChatMessage.owner_id),
        )
        .where(
            MemorySource.pet_id == pet_id,
            MemorySource.owner_id == owner_id,
            MemorySource.memory_id.in_(memory_ids),
            MemorySource.kind == "chat_message",
            MemorySource.source_message_version == 1,
            ChatSession.deleted_at.is_(None),
            ChatMessage.role == "user",
            ChatMessage.status == "completed",
        )
    )
    query = (
        query.join(
            PetChatBinding,
            (PetChatBinding.session_id == ChatSession.id)
            & (PetChatBinding.owner_id == ChatSession.owner_id),
        )
        .join(Pet, (Pet.id == PetChatBinding.pet_id) & (Pet.owner_id == ChatSession.owner_id))
        .where(PetChatBinding.pet_id == pet_id, Pet.companion_id == ChatSession.companion_id)
    )
    valid = set((await db.scalars(query)).all())
    return groups, valid


def valid_sources(sources, valid_ids):
    if len(sources) == 1 and sources[0].kind == "manual":
        return True
    return 1 <= len(sources) <= 5 and all(
        source.kind == "chat_message" and source.id in valid_ids for source in sources
    )


async def active_rows(db, owner_id, pet_id):
    rows = list(
        (
            await db.scalars(
                select(Memory)
                .where(
                    Memory.pet_id == pet_id,
                    Memory.owner_id == owner_id,
                    Memory.status == "active",
                    Memory.deleted_at.is_(None),
                )
                .order_by(Memory.id)
                .limit(201)
            )
        ).all()
    )
    if len(rows) > 200:
        raise AppError(503, "MEMORY_STORAGE_UNAVAILABLE", "记忆容量状态暂不可用。")
    return rows


async def current_grants(db, owner_id, pet_id, rows):
    ids = [row.active_consent_id for row in rows if row.active_consent_id]
    if not ids:
        return {}
    return {
        event.id: event
        for event in (
            await db.scalars(
                select(MemoryConsentEvent).where(
                    MemoryConsentEvent.pet_id == pet_id,
                    MemoryConsentEvent.owner_id == owner_id,
                    MemoryConsentEvent.id.in_(ids),
                    MemoryConsentEvent.action.in_(("confirmed", "corrected")),
                )
            )
        ).all()
    }


def grant_valid(row, grants):
    event = grants.get(row.active_consent_id)
    return event is not None and event.memory_id == row.id and event.memory_version == row.version


async def eligible_candidates(db, owner_id, pet_id, *, at=None):
    """Filter database consent and provenance BEFORE constructing lexical candidates."""
    from app.modules.memory.retrieval import MemoryCandidate

    at = at or clock()
    pref = await db.scalar(
        select(MemoryPreferences).where(
            MemoryPreferences.pet_id == pet_id, MemoryPreferences.owner_id == owner_id
        )
    )
    if pref is None or not pref.long_term_memory_enabled:
        return []
    rows = await active_rows(db, owner_id, pet_id)
    sources, valid_ids = await source_groups(db, owner_id, pet_id, [row.id for row in rows])
    grants = await current_grants(db, owner_id, pet_id, rows)
    output = []
    for row in rows:
        if (
            row.consent_revoked_at is not None
            or row.expires_at is None
            or aware(row.expires_at) <= at
            or not grant_valid(row, grants)
            or not valid_sources(sources[row.id], valid_ids)
        ):
            continue
        refs = tuple(
            {
                "kind": source.kind,
                "session_id": str(source.session_id) if source.session_id else None,
                "message_id": str(source.message_id) if source.message_id else None,
            }
            for source in sources[row.id]
        )
        output.append(
            MemoryCandidate(
                id=row.id,
                owner_id=owner_id,
                version=row.version,
                title=row.title,
                content=row.content,
                category=row.category,
                confirmed_at=aware(row.consent_granted_at),
                grant_id=row.active_consent_id,
                source_refs=refs,
                expires_at=aware(row.expires_at),
            )
        )
    return output


async def materialize_pet_invalidations(db, owner_id, pet_id, *, at=None):
    """Caller owns User; acquire Prefs before any chat or memory row lock.

    The caller MUST commit these changes even when it decides not to dispatch a job.
    Worker code uses a separate transaction before potentially raising FenceLost.
    """
    if await read_revision(db) != "0006":
        return []
    pref = await db.scalar(
        select(MemoryPreferences)
        .where(MemoryPreferences.pet_id == pet_id, MemoryPreferences.owner_id == owner_id)
        .with_for_update()
    )
    if pref is None:
        return []
    at = at or clock()
    rows = await active_rows(db, owner_id, pet_id)
    sources, valid_ids = await source_groups(db, owner_id, pet_id, [row.id for row in rows])
    grants = await current_grants(db, owner_id, pet_id, rows)
    invalid = []
    for row in rows:
        if row.expires_at is None or aware(row.expires_at) <= at:
            invalid.append((row, "expired", "expired"))
        elif (
            row.consent_revoked_at is not None
            or not grant_valid(row, grants)
            or not valid_sources(sources[row.id], valid_ids)
        ):
            invalid.append((row, "revoked", "source_invalidated"))
    if not invalid:
        return []
    if (
        pref.privacy_epoch + len(invalid) >= 9223372036854775807
        or pref.last_revision + len(invalid) >= 9223372036854775807
        or any(row.version >= 2147483647 for row, _, _ in invalid)
    ):
        raise AppError(503, "MEMORY_STORAGE_UNAVAILABLE", "记忆版本状态暂不可用。")
    # Lock all affected chat rows first, then memory rows. The common User lock
    # serializes all legitimate writes for this owner, including source deletion.
    cancelled = await invalidate_pet_generations(db, owner_id, pet_id)
    ids = [row.id for row, _, _ in invalid]
    await db.execute(
        select(Memory.id)
        .where(Memory.pet_id == pet_id, Memory.owner_id == owner_id, Memory.id.in_(ids))
        .order_by(Memory.id)
        .with_for_update()
    )
    for row, status, action in invalid:
        pref.privacy_epoch += 1
        pref.last_revision += 1
        pref.context_epoch_floor = pref.privacy_epoch
        pref.context_not_before = at
        row.status, row.active_consent_id = status, None
        row.version += 1
        row.consent_revoked_at, row.updated_at = at, at
        db.add(
            MemoryConsentEvent(
                owner_id=owner_id,
                pet_id=pet_id,
                id=uuid4(),
                revision=pref.last_revision,
                action=action,
                memory_id=row.id,
                memory_version=row.version,
                policy_version="memory-policy/1",
                notice_version="memory-notice/1",
                affected_all=False,
                origin_client="server",
                privacy_epoch=pref.privacy_epoch,
            )
        )
    await db.flush()
    return cancelled


async def materialize_pet(session_factory, owner_id, pet_id):
    """A committed boundary, never nested inside a worker's uncommitted transaction."""
    async with session_factory() as db, db.begin():
        revision = await read_revision(db)
        if revision != "0006":
            return []
        await require_capability(db, "pets")
        user = await db.scalar(select(User.id).where(User.id == owner_id).with_for_update())
        if user is None:
            return []
        await db.scalar(
            select(Pet.id).where(Pet.id == pet_id, Pet.owner_id == owner_id).with_for_update()
        )
        return await materialize_pet_invalidations(db, owner_id, pet_id)


async def pet_memory_epoch(db, owner_id, pet_id, *, lock=False):
    query = select(MemoryPreferences).where(
        MemoryPreferences.pet_id == pet_id, MemoryPreferences.owner_id == owner_id
    )
    if lock:
        query = query.with_for_update()
    pref = await db.scalar(query)
    if pref is None:
        return MemoryEpoch()
    return MemoryEpoch(pref.privacy_epoch, pref.context_epoch_floor, pref.context_not_before)


async def invalidate_pet_generations(db, owner_id, pet_id, *, reason="memory_policy_changed"):
    """User, Pet and Prefs are already locked; never cancel a sibling pet/legacy job."""
    session_ids = select(PetChatBinding.session_id).where(
        PetChatBinding.owner_id == owner_id, PetChatBinding.pet_id == pet_id
    )
    sessions = list(
        await db.scalars(
            select(ChatSession)
            .where(ChatSession.owner_id == owner_id, ChatSession.id.in_(session_ids))
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
            context = await db.scalar(
                select(PetGenerationContext).where(
                    PetGenerationContext.generation_id == generation.id,
                    PetGenerationContext.owner_id == owner_id,
                    PetGenerationContext.pet_id == pet_id,
                    PetGenerationContext.session_id == session.id,
                )
            )
            if context is None:
                raise AppError(503, "MEMORY_STORAGE_UNAVAILABLE", "宠物生成上下文暂不可用。")
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
                raise AppError(503, "MEMORY_STORAGE_UNAVAILABLE", "宠物消息暂不可用。")
            if await terminalize(db, session, generation, assistant, "cancelled", reason=reason):
                cancelled.append(generation.id)
    return cancelled
