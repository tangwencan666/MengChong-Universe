from typing import Protocol
from uuid import UUID

from app.agent.state import Message
from app.core.security import Principal


class ConversationContextStore(Protocol):
    """Require authenticated owner-scoped reads/writes and bounded context windows.

    No persistence implementation or global shared conversation buffer is installed.
    """

    async def load(
        self, principal: Principal, session_id: UUID, *, limit: int = 20
    ) -> list[Message]: ...
    async def append(self, principal: Principal, session_id: UUID, message: Message) -> None: ...
