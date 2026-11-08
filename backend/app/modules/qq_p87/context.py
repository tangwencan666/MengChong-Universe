"""Read the existing owner/pet memory store. Never create another memory DB."""

from uuid import UUID

from sqlalchemy import select, text

from app.modules.pets.memory_policy import eligible_candidates
from app.modules.pets.models import Pet, PetMemoryPreferences
from app.modules.users.models import User

from .contracts import Context, Memory, Rejected, uuid


class ExistingPetContextReader:
    def __init__(self, session_factory):
        # Explicit injection only: no Settings(), URL, engine creation or migrations.
        self.session_factory = session_factory

    async def read(self, owner: str, pet: str, *, allow_memory: bool) -> Context:
        owner, pet = uuid(owner), uuid(pet)
        async with self.session_factory() as db, db.begin():
            if db.bind.dialect.name == "postgresql":
                await db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
            user = await db.get(User, UUID(owner))
            row = await db.scalar(
                select(Pet).where(Pet.id == UUID(pet), Pet.owner_id == UUID(owner))
            )
            if not user or user.status != "active" or not row or row.status == "archived":
                raise Rejected("PET_ACCESS_DENIED")
            pref = await db.scalar(
                select(PetMemoryPreferences).where(
                    PetMemoryPreferences.pet_id == row.id,
                    PetMemoryPreferences.owner_id == user.id,
                )
            )
            if pref is None:
                raise Rejected("CONTEXT_UNAVAILABLE")
            memories = ()
            if allow_memory:
                candidates = await eligible_candidates(db, user.id, row.id)
                memories = tuple(
                    Memory(owner, pet, str(v.id), str(v.grant_id), v.version, v.content)
                    for v in sorted(candidates, key=lambda v: str(v.id))[:3]
                )
            return Context(
                owner,
                pet,
                row.name,
                row.persona_config["description"],
                row.persona_config["tone"],
                row.version,
                pref.privacy_epoch,
                memories,
            )
