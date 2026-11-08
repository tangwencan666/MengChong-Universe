from typing import Protocol
from uuid import UUID

from app.core.security import Principal
from app.modules.memory.retrieval import RankedHit


class MemoryStore(Protocol):
    """Implementations must filter owner, consent, revocation, and deletion on EVERY access.

    Do not supply private memories to public community views or moderation prompts.
    Implementations return structured provenance; vectors and model summarization remain absent.
    """

    async def retrieve(
        self, principal: Principal, query: str, *, limit: int = 5
    ) -> list[RankedHit]: ...
    async def save(self, principal: Principal, content: str, *, consent_id: UUID) -> UUID: ...
    async def revoke_and_delete(self, principal: Principal, memory_id: UUID) -> None: ...
