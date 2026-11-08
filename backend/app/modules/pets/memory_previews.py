"""Explicit, non-persistent previews of the authenticated user's selected messages."""

import base64
import hashlib
import hmac
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID, uuid4

from pydantic import Field, field_validator
from sqlalchemy import select

from app.core.errors import AppError
from app.core.security import Principal
from app.modules.companion.models import ChatMessage, ChatSession
from app.modules.memory.privacy import screen
from app.modules.memory.schemas import Input, Source, Version
from app.modules.pets.models import Pet, PetChatBinding

DOMAIN = b"weibiye-pet-memory-preview/v1\0"
SOURCE_DOMAIN = b"weibiye-pet-memory-preview-source/v1\0"
EXTRACTOR_VERSION = "local-excerpt/1"
TTL = timedelta(minutes=5)
MAX_TOKEN_LENGTH = 2048
DEFAULT_DAYS = {
    "career_goal": 90,
    "communication_preference": 180,
    "experience": 180,
    "open_topic": 30,
    "explicit_note": 180,
}


class PreviewConsent(Input):
    confirmed: Literal[True]
    notice_version: Literal["memory-preview/1"]


class PreviewRequest(Input):
    session_id: UUID
    message_ids: list[UUID] = Field(min_length=1, max_length=5)
    expected_preferences_version: Version
    consent: PreviewConsent

    @field_validator("message_ids")
    @classmethod
    def distinct_messages(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("Message selections must be distinct")
        return value


def _stale():
    return AppError(409, "PREVIEW_STALE", "预览已失效，请重新选择来源并确认。")


def _input_error():
    return AppError(422, "VALIDATION_ERROR", "请选择有效的聊天来源。")


def _clock(at):
    if at.tzinfo is None:
        raise ValueError("Preview clock must be timezone-aware")
    return at.astimezone(UTC)


def _stamp(at):
    return _clock(at).isoformat().replace("+00:00", "Z")


def _identity(principal):
    if principal.session_id is None:
        raise AppError(401, "AUTHENTICATION_REQUIRED", "请重新登录后再确认来源。")


def _enabled(pref, expected=None):
    if pref is None or not pref.long_term_memory_enabled:
        raise AppError(409, "MEMORY_DISABLED", "长期记忆尚未开启。")
    if expected is not None and pref.version != expected:
        raise AppError(409, "PREFERENCES_CONFLICT", "记忆设置已更新，请重新查看后再确认。")


def _key(key):
    if not isinstance(key, bytes) or len(key) < 32:
        raise AppError(503, "MEMORY_FEATURE_DISABLED", "记忆预览配置尚未就绪。")
    return key


async def _selected(db, principal, pet_id, session_id, message_ids):
    if not session_id or not message_ids or not 1 <= len(message_ids) <= 5:
        raise _input_error()
    if len(set(message_ids)) != len(message_ids):
        raise _input_error()
    session = await db.scalar(
        select(ChatSession)
        .join(
            PetChatBinding,
            (PetChatBinding.session_id == ChatSession.id)
            & (PetChatBinding.owner_id == ChatSession.owner_id),
        )
        .join(Pet, (Pet.id == PetChatBinding.pet_id) & (Pet.owner_id == ChatSession.owner_id))
        .where(
            PetChatBinding.pet_id == pet_id,
            Pet.companion_id == ChatSession.companion_id,
            ChatSession.id == session_id,
            ChatSession.owner_id == principal.user_id,
            ChatSession.deleted_at.is_(None),
        )
    )
    if session is None:
        raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
    rows = list(
        (
            await db.scalars(
                select(ChatMessage)
                .where(
                    ChatMessage.session_id == session_id,
                    ChatMessage.owner_id == principal.user_id,
                    ChatMessage.id.in_(message_ids),
                    ChatMessage.role == "user",
                    ChatMessage.status == "completed",
                )
                .order_by(ChatMessage.sequence, ChatMessage.id)
            )
        ).all()
    )
    if len(rows) != len(message_ids):
        raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
    return rows


def _fingerprint(key, principal, session_id, message):
    value = (
        SOURCE_DOMAIN
        + principal.user_id.bytes
        + session_id.bytes
        + message.id.bytes
        + message.content.encode("utf-8")
    )
    return hmac.new(key, value, hashlib.sha256).hexdigest()


def _sign(key, value):
    body = base64.urlsafe_b64encode(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).rstrip(b"=")
    signature = hmac.new(key, DOMAIN + body, hashlib.sha256).hexdigest()
    token = body.decode("ascii") + "." + signature
    if len(token) > MAX_TOKEN_LENGTH:
        raise RuntimeError("Preview receipt exceeded its bounded encoding")
    return token


def _decode(key, token):
    try:
        if not isinstance(token, str) or not 1 <= len(token) <= MAX_TOKEN_LENGTH:
            raise ValueError
        body, signature = token.split(".")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", body) or not re.fullmatch(
            r"[0-9a-f]{64}", signature
        ):
            raise ValueError
        expected = hmac.new(key, DOMAIN + body.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise ValueError
        raw = base64.b64decode(body + "=" * (-len(body) % 4), altchars=b"-_", validate=True)
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {
            "v",
            "t",
            "o",
            "a",
            "s",
            "p",
            "e",
            "i",
            "x",
            "m",
        }:
            raise ValueError
        return value
    except (ValueError, TypeError, UnicodeError):
        raise _stale() from None


def _excerpt(content, limit):
    return content if len(content) <= limit else content[: limit - 1] + "…"


def _category(content):
    if any(term in content for term in ("交流", "沟通", "简短", "详细", "语气", "称呼")):
        return "communication_preference", "交流偏好"
    if any(term in content for term in ("求职", "岗位", "职业", "后端", "前端", "开发", "方向")):
        return "career_goal", "求职方向"
    if any(term in content for term in ("待办", "还没", "未完成", "明天", "下周")):
        return "open_topic", "待续事项"
    if any(term in content for term in ("经历", "曾经", "实习", "毕业", "面试")):
        return "experience", "重要经历"
    return "explicit_note", "希望记住的事项"


async def preview_selected(
    db,
    principal: Principal,
    pet_id: UUID,
    payload: PreviewRequest,
    pref,
    *,
    key: bytes,
    at: datetime,
) -> dict:
    """Read only the selected messages; the returned candidates have no storage side effects."""
    _identity(principal)
    _enabled(pref, payload.expected_preferences_version)
    key, at = _key(key), _clock(at)
    rows = await _selected(db, principal, pet_id, payload.session_id, payload.message_ids)
    for row in rows:
        screen("", row.content)
    expires = at + TTL
    token = _sign(
        key,
        {
            "v": 1,
            "t": pet_id.hex,
            "o": principal.user_id.hex,
            "a": principal.session_id.hex,
            "s": payload.session_id.hex,
            "p": pref.version,
            "e": str(pref.privacy_epoch),
            "i": _stamp(at),
            "x": _stamp(expires),
            "m": [
                [row.id.hex, _fingerprint(key, principal, payload.session_id, row)] for row in rows
            ],
        },
    )
    candidates = []
    for row in rows[:3]:
        # The input is an immutable user message, not an inferred user fact.
        content = _excerpt(row.content.strip(), 1000)
        if not content:
            continue
        category, title = _category(content)
        candidates.append(
            {
                "candidate_id": str(uuid4()),
                "title": title,
                "content": content,
                "summary": _excerpt(content, 240),
                "category": category,
                "source_refs": [
                    {
                        "kind": "chat_message",
                        "session_id": str(payload.session_id),
                        "message_id": str(row.id),
                        "source_message_version": 1,
                        "availability": "available",
                    }
                ],
                "suggested_expires_at": _stamp(at + timedelta(days=DEFAULT_DAYS[category])),
            }
        )
    return {
        "pet_id": str(pet_id),
        "candidates": candidates,
        "preview_token": token,
        "expires_at": _stamp(expires),
        "extractor_version": EXTRACTOR_VERSION,
        "persisted": False,
    }


async def validate_chat_source(
    db, principal: Principal, pet_id: UUID, source: Source, pref, *, key: bytes, at: datetime
) -> list[ChatMessage]:
    """Verify the full signed selection, then return only its requested, owned subset."""
    _identity(principal)
    _enabled(pref)
    if source.kind != "chat_message":
        raise _input_error()
    # Reject source IDOR before inspecting an otherwise valid receipt from another account.
    selected = await _selected(db, principal, pet_id, source.session_id, source.message_ids)
    key, at = _key(key), _clock(at)
    value = _decode(key, source.preview_token)
    try:
        if (value["v"], value["t"], value["o"], value["a"], value["s"], value["p"], value["e"]) != (
            1,
            pet_id.hex,
            principal.user_id.hex,
            principal.session_id.hex,
            source.session_id.hex,
            pref.version,
            str(pref.privacy_epoch),
        ):
            raise ValueError
        issued = datetime.fromisoformat(value["i"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(value["x"].replace("Z", "+00:00"))
        if issued.tzinfo is None or expires.tzinfo is None or expires - issued != TTL:
            raise ValueError
        if at < issued or at >= expires:
            raise ValueError
        signed = value["m"]
        if not isinstance(signed, list) or not 1 <= len(signed) <= 5:
            raise ValueError
        identifiers, digests = [], {}
        for item in signed:
            if not isinstance(item, list) or len(item) != 2:
                raise ValueError
            identifier = UUID(item[0])
            if not isinstance(item[1], str) or not re.fullmatch(r"[0-9a-f]{64}", item[1]):
                raise ValueError
            identifiers.append(identifier)
            digests[identifier] = item[1]
        if len(digests) != len(identifiers) or not set(source.message_ids) <= set(identifiers):
            raise ValueError
    except (ValueError, KeyError, TypeError, AttributeError):
        raise _stale() from None
    original = await _selected(db, principal, pet_id, source.session_id, identifiers)
    for row in original:
        if not hmac.compare_digest(
            _fingerprint(key, principal, source.session_id, row), digests[row.id]
        ):
            raise _stale()
        screen("", row.content)
    return selected
