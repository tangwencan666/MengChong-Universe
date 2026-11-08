from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class ModerationDecision:
    outcome: Literal["allow", "review", "block"]
    reason_code: str


class ContentModerator(Protocol):
    """Unavailable moderation must hold public writes for review, never auto-publish."""

    async def review_public_content(self, text: str) -> ModerationDecision: ...


class SafetyPolicy(Protocol):
    """Separate private-session policy; high-risk routing needs a tested implementation.

    A prompt or keyword list alone is not a production crisis detection system.
    """

    async def assess_private_input(self, text: str) -> ModerationDecision: ...
