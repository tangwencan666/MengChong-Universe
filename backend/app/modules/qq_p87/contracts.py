"""Channel, identity, pet context and model are separate, bounded contracts."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID, uuid5


class Rejected(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def uuid(value: str) -> str:
    try:
        if str(UUID(value)) != value:
            raise ValueError
        return value
    except (ValueError, TypeError, AttributeError):
        raise Rejected("INVALID_ID") from None


@dataclass(frozen=True, repr=False)
class Receipt:
    bot: str
    subject: str
    message_id: str
    message_index: str
    text: str
    timestamp: int
    scene: str = "c2c"


@dataclass(frozen=True)
class Scope:
    owner: str
    pet: str
    bot: str
    subject_hash: str
    binding_version: int
    memory_allowed: bool

    @property
    def conversation_id(self) -> str:
        return str(uuid5(UUID(self.pet), f"qq-p87:{self.owner}:{self.bot}:{self.subject_hash}"))


@dataclass(frozen=True, repr=False)
class Memory:
    owner: str
    pet: str
    id: str
    grant: str
    version: int
    content: str


@dataclass(frozen=True, repr=False)
class Context:
    owner: str
    pet: str
    name: str
    description: str
    tone: str
    persona_version: int
    privacy_epoch: int
    memories: tuple[Memory, ...] = ()


class ContextReader(Protocol):
    async def read(self, owner: str, pet: str, *, allow_memory: bool) -> Context: ...


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    cache_hit_tokens: int = 0


@dataclass(frozen=True, repr=False)
class Candidate:
    text: str
    usage: Usage


@dataclass(frozen=True, repr=False)
class ModelRequest:
    conversation_id: str
    context: Context
    text: str


class CandidateModel(Protocol):
    name: str

    async def generate(self, request: ModelRequest) -> Candidate: ...


class SendNotAccepted(Exception):
    """Adapter positively knows that no message was accepted."""


class SendUncertain(Exception):
    """A send may have reached the platform: never blindly retry."""


class ReplyChannel(Protocol):
    name: str

    def verify(self, body: bytes, signature: str | Mapping[str, str], now: int) -> Receipt: ...

    async def reply(self, receipt: Receipt, text: str, *, sequence: int) -> str: ...

    def clear_captures(self): ...
