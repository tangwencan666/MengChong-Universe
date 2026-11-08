"""Local synthetic signature + in-memory send recorder. Neither speaks real QQ."""

import asyncio
import hashlib
import hmac
import json
import re
from collections import deque
from dataclasses import dataclass

from .contracts import (
    Candidate,
    Context,
    ModelRequest,
    Receipt,
    Rejected,
    SendNotAccepted,
    SendUncertain,
    Usage,
)


def mock_input_tokens(request: ModelRequest) -> int:
    # Explicit byte-based MOCK accounting, not a DeepSeek tokenizer estimate.
    from dataclasses import asdict

    return len(json.dumps(asdict(request), ensure_ascii=False).encode("utf-8"))


@dataclass(frozen=True, repr=False)
class Sent:
    bot: str
    subject: str
    reply_to: str
    sequence: int
    text: str


class MockQQAdapter:
    name = "mock-qq-only"

    def __init__(self, signing_keys: dict[str, bytes]):
        if not signing_keys or any(len(k) != 32 for k in signing_keys.values()):
            raise Rejected("LAB_SIGNER_REQUIRED")
        self._keys = dict(signing_keys)
        self.sent: deque[Sent] = deque(maxlen=128)
        self._accepted: set[tuple] = set()
        self.failure: str | None = None
        self.attempts = 0

    def envelope(self, receipt: Receipt) -> tuple[bytes, str]:
        from dataclasses import asdict

        body = json.dumps(asdict(receipt), ensure_ascii=False, separators=(",", ":")).encode()
        key = self._keys[receipt.bot]
        return body, hmac.new(key, b"P87-MOCK-NOT-QQ\0" + body, hashlib.sha256).hexdigest()

    def verify(self, body: bytes, signature: str, now: int) -> Receipt:
        try:
            if not isinstance(body, bytes) or len(body) > 8192:
                raise ValueError
            data = json.loads(body)
            if set(data) != {
                "bot",
                "subject",
                "message_id",
                "message_index",
                "text",
                "timestamp",
                "scene",
            }:
                raise ValueError
            key = self._keys.get(data["bot"])
            expected = hmac.new(key or b"", b"P87-MOCK-NOT-QQ\0" + body, hashlib.sha256).hexdigest()
            if (
                not key
                or not isinstance(signature, str)
                or not hmac.compare_digest(expected, signature)
            ):
                raise ValueError
            for field in ("bot", "subject", "message_id", "message_index"):
                if not isinstance(data[field], str) or not re.fullmatch(
                    r"[A-Za-z0-9_-]{1,128}", data[field]
                ):
                    raise ValueError
            if (
                data["scene"] != "c2c"
                or type(data["timestamp"]) is not int
                or not now - 120 <= data["timestamp"] <= now + 15
                or not isinstance(data["text"], str)
            ):
                raise ValueError
            return Receipt(**data)
        except (ValueError, TypeError, KeyError):
            raise Rejected("UNVERIFIED_MOCK_EVENT") from None

    async def reply(self, receipt: Receipt, text: str, *, sequence: int) -> str:
        self.attempts += 1
        if sequence != 1:
            raise Rejected("FIXED_REPLY_SEQUENCE_REQUIRED")
        failure, self.failure = self.failure, None
        if failure == "not-accepted":
            raise SendNotAccepted
        key = (receipt.bot, receipt.subject, receipt.message_id, sequence)
        if key in self._accepted:
            raise SendUncertain
        self._accepted.add(key)
        self.sent.append(Sent(*key, text))
        if failure == "uncertain":
            raise SendUncertain
        if failure == "timeout-after-accept":
            await asyncio.Event().wait()
        return "mock-message-" + str(len(self.sent))

    def clear_captures(self):
        self.sent.clear()
        self._accepted.clear()


class MockModel:
    name = "mock-pet-v1"

    def __init__(self):
        self.requests: deque[ModelRequest] = deque(maxlen=32)
        self.calls = 0
        self.calls_changed = asyncio.Condition()
        self.wait: asyncio.Event | None = None
        self.reply_override: str | None = None
        self.failure = False
        self.active = self.peak = self.closed = 0

    async def generate(self, request: ModelRequest) -> Candidate:
        self.requests.append(request)
        self.calls += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            async with self.calls_changed:
                self.calls_changed.notify_all()
            if self.wait:
                await self.wait.wait()
            if self.failure:
                raise RuntimeError("SYNTHETIC raw error must never be audited")
            answer = self.reply_override or f"我是{request.context.name}，在这里陪你。"
            if self.reply_override is None and request.context.memories:
                answer += "你允许我记住：" + request.context.memories[0].content
            return Candidate(answer, Usage(mock_input_tokens(request), len(answer.encode("utf-8"))))
        finally:
            self.active -= 1
            self.closed += 1


class FixtureContextReader:
    """Synthetic fixtures only. Product memory reads use ExistingPetContextReader."""

    def __init__(self, contexts: list[Context]):
        self.values = {(c.owner, c.pet): c for c in contexts}

    async def read(self, owner, pet, *, allow_memory):
        from dataclasses import replace

        value = self.values.get((owner, pet))
        if not value:
            raise Rejected("PET_ACCESS_DENIED")
        return value if allow_memory else replace(value, memories=())
