"""Pet scope adapters for the established P3 chat state machine."""

from sqlalchemy import exists, select

from app.agent.chat_protocol import terminalize
from app.db.capabilities import read_revision, require_capability
from app.modules.companion.models import ChatGeneration, ChatMessage


async def session_scope(db, owner_id, pet_id):
    revision = await read_revision(db)
    if pet_id is not None:
        await require_capability(db, "pets")
    if revision != "0006":
        return True
    from app.modules.companion.models import ChatSession
    from app.modules.pets.models import Pet, PetChatBinding

    binding_query = select(PetChatBinding.session_id).where(
        PetChatBinding.session_id == ChatSession.id, PetChatBinding.owner_id == owner_id
    )
    if pet_id is not None:
        binding_query = binding_query.join(Pet, Pet.id == PetChatBinding.pet_id).where(
            PetChatBinding.pet_id == pet_id,
            Pet.owner_id == owner_id,
            Pet.companion_id == ChatSession.companion_id,
        )
    binding = exists(binding_query)
    return binding if pet_id is not None else ~binding


async def archive_pet_generations(db, owner_id, pet_id, settings=None):
    """Caller owns User -> Pet locks. Reuse P3 terminal transitions atomically."""
    from app.modules.companion.models import ChatSession
    from app.modules.pets.models import PetChatBinding, PetMemoryPreferences

    await db.scalar(
        select(PetMemoryPreferences)
        .where(
            PetMemoryPreferences.owner_id == owner_id,
            PetMemoryPreferences.pet_id == pet_id,
        )
        .with_for_update()
    )
    sessions = list(
        await db.scalars(
            select(ChatSession)
            .join(PetChatBinding, PetChatBinding.session_id == ChatSession.id)
            .where(PetChatBinding.owner_id == owner_id, PetChatBinding.pet_id == pet_id)
            .order_by(ChatSession.id)
            .with_for_update()
        )
    )
    cancelled = []
    for session in sessions:
        jobs = list(
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
        for generation in jobs:
            assistant = await db.scalar(
                select(ChatMessage)
                .where(
                    ChatMessage.id == generation.assistant_message_id,
                    ChatMessage.owner_id == owner_id,
                    ChatMessage.session_id == session.id,
                )
                .with_for_update()
            )
            if assistant is None:
                raise ValueError("Generation assistant unavailable")
            if await terminalize(
                db, session, generation, assistant, "cancelled", reason="pet_archived"
            ):
                cancelled.append(generation.id)
    return cancelled


def scoped_result(value, pet_id):
    """P3 response fields are retained; every pet resource carries its explicit scope."""
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    if isinstance(value, list):
        return [scoped_result(item, pet_id) for item in value]
    if isinstance(value, dict):
        result = {
            key: scoped_result(item, pet_id) if isinstance(item, (dict, list)) else item
            for key, item in value.items()
        }
        if (
            "id" in result
            or "session_id" in result
            or "items" in result
            or "session" in result
            or "generation" in result
        ):
            result["pet_id"] = str(pet_id)
        return result
    return value
