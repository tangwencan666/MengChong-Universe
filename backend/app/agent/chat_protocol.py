"""Persisted private-chat events. The public demo keeps its separate protocol."""

import json
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.capabilities import read_revision
from app.modules.companion.models import (
    ChatGeneration,
    ChatGenerationEvent,
    ChatMessage,
    ChatSession,
)

PersistentEvent = Literal["start", "delta", "completed", "error", "cancelled"]
TERMINAL_STATES = frozenset({"completed", "failed", "cancelled"})
ERROR_MESSAGES = {
    "LOCAL_MODEL_BUDGET_EXHAUSTED": "本次本地体验的模型请求额度已用完，请联系运行者确认。",
    "LOCAL_MODEL_INPUT_LIMIT": "对话超过本次模型输入上限，请开启新会话或缩短消息。",
    "LOCAL_MODEL_POLICY_CHANGED": "模型配置已改变，请联系运行者重新确认。",
    "BETA_QUOTA_UNAVAILABLE": "内测额度或请求预算暂不可用，请查看额度后重试。",
    "MEMORY_CONTEXT_UNAVAILABLE": "当前记忆或上下文预算暂不可用，请稍后重试。",
    "SERVER_RESTARTED": "服务重启，回复未能完成。",
    "QUEUE_TIMEOUT": "等待回复超时，请稍后重试。",
    "GENERATION_TIMEOUT": "回复生成超时，请稍后重试。",
    "FIRST_CHUNK_TIMEOUT": "等待回复超时，请稍后重试。",
    "PROVIDER_FAILED": "回复生成失败，请稍后重试。",
    "PROMPT_UNAVAILABLE": "当前提示词暂不可用。",
    "CHAT_CONTEXT_UNAVAILABLE": "当前聊天上下文暂不可用。",
    "CHAT_STORAGE_UNAVAILABLE": "聊天存储暂不可用。",
}


def utcnow() -> datetime:
    return datetime.now(UTC)


def utc_string(value: datetime) -> str:
    # SQLite loses timezone information even for timezone=True columns.
    return (
        value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC).isoformat().replace("+00:00", "Z")
    )


def encode_event(event_type: PersistentEvent, data: dict, event_id: str | None = None) -> str:
    """Encode a database event, or an unnumbered connection-level error."""
    if event_type not in {"start", "delta", "completed", "error", "cancelled"}:
        raise ValueError("Unknown private chat event")
    if event_id is None and data.get("scope") == "generation":
        event_id = f"{data['generation_id']}:{data['sequence']}"
    prefix = f"id: {event_id}\n" if event_id is not None else ""
    frame = f"{prefix}event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    if len(frame.encode("utf-8")) > 64 * 1024:
        raise ValueError("Private chat event exceeds frame limit")
    return frame


def connection_error(code: str, message: str, *, retryable: bool = False) -> str:
    return encode_event(
        "error",
        {
            "version": 1,
            "scope": "connection",
            "error": {"code": code, "message": message, "retryable": retryable},
        },
    )


async def append_event(
    db: AsyncSession, generation: ChatGeneration, event_type: PersistentEvent, payload: dict
) -> ChatGenerationEvent:
    """Append under the caller's generation lock and transaction; never commit here."""
    sequence = (generation.last_event_sequence or 0) + 1
    if (event_type == "start") != (sequence == 1):
        raise ValueError("Start must be the first and only acceptance event")
    if event_type == "delta" and not payload.get("text"):
        raise ValueError("A delta must contain nonempty text")
    occurred_at = utcnow()
    if await read_revision(db) == "0006":
        from app.modules.pets.models import PetGenerationContext

        pet_id = await db.scalar(
            select(PetGenerationContext.pet_id).where(
                PetGenerationContext.generation_id == generation.id,
                PetGenerationContext.owner_id == generation.owner_id,
                PetGenerationContext.session_id == generation.session_id,
            )
        )
        if pet_id is not None:
            payload = {**payload, "pet_id": str(pet_id)}
    data = {
        **payload,
        "version": 1,
        "scope": "generation",
        "generation_id": str(generation.id),
        "session_id": str(generation.session_id),
        "message_id": str(generation.assistant_message_id),
        "sequence": sequence,
        "occurred_at": utc_string(occurred_at),
    }
    # Validate frame size before any event can be committed and become replayable.
    encode_event(event_type, data)
    event = ChatGenerationEvent(
        owner_id=generation.owner_id,
        session_id=generation.session_id,
        generation_id=generation.id,
        event_sequence=sequence,
        event_type=event_type,
        payload=data,
        occurred_at=occurred_at,
    )
    generation.last_event_sequence = sequence
    db.add(event)
    await db.flush()
    return event


async def terminalize(
    db: AsyncSession,
    session: ChatSession,
    generation: ChatGeneration,
    assistant: ChatMessage,
    state: Literal["completed", "failed", "cancelled"],
    *,
    error_code: str | None = None,
    reason: str = "stop",
    error_message: str | None = None,
) -> bool:
    """Atomically finish a locked generation and its message in the caller's transaction.

    The caller must lock User -> ChatSession -> ChatGeneration and must check its
    lease fence before adding any body text. This helper never adds body text.
    """
    if generation.state in TERMINAL_STATES:
        return False
    if session.deleted_at is not None or generation.state == "cancel_requested":
        state = "cancelled"
        if session.deleted_at is not None:
            reason = "session_deleted"
        elif reason != "memory_policy_changed":
            reason = "user_cancelled"
    if state not in TERMINAL_STATES:
        raise ValueError("Invalid terminal state")
    now = utcnow()
    generation.state = state
    generation.finished_at = now
    generation.lease_expires_at = None
    generation.lease_version = (generation.lease_version or 0) + 1
    generation.error_code = error_code if state == "failed" else None
    generation.error_message = (
        error_message or ERROR_MESSAGES.get(error_code or "", ERROR_MESSAGES["PROVIDER_FAILED"])
        if state == "failed"
        else None
    )
    assistant.status = state
    assistant.completed_at = now
    session.last_message_at = now
    session.last_activity_at = now
    session.updated_at = now
    session.version += 1
    if state == "completed":
        await append_event(
            db,
            generation,
            "completed",
            {
                "state": state,
                "content": assistant.content,
                "finish_reason": reason if reason in {"stop", "length"} else "stop",
                "usage": generation.usage,
            },
        )
    elif state == "cancelled":
        await append_event(
            db,
            generation,
            "cancelled",
            {"state": state, "reason": reason, "content": assistant.content},
        )
    else:
        if not error_code:
            raise ValueError("Failed generations need a safe error code")
        await append_event(
            db,
            generation,
            "error",
            {
                "state": state,
                "error": {
                    "code": generation.error_code,
                    "message": generation.error_message,
                    "retryable": True,
                },
                "content": assistant.content,
            },
        )
    from app.modules.beta_quota.service import settle as settle_beta_quota

    await settle_beta_quota(db, generation)
    return True
