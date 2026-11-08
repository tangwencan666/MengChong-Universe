"""Read-only event journal subscription, independent from generation execution."""

import asyncio
import time
from uuid import UUID

from anyio import move_on_after
from sqlalchemy import select

from app.agent.chat_protocol import connection_error, encode_event
from app.core.errors import AppError
from app.modules.auth.service import session_user
from app.modules.companion.access import stream_slot
from app.modules.companion.models import ChatGenerationEvent, ChatSession
from app.modules.companion.service import ACTIVE, ChatService, aware, now


async def prepare_events(request, principal, session_id, generation_id, last_event_id, pet_id=None):
    snapshot = await ChatService(request, principal, pet_id).snapshot(session_id, generation_id)
    cursor = 0
    if last_event_id is not None:
        try:
            if len(last_event_id) > 64:
                raise ValueError
            identifier, sequence = last_event_id.split(":")
            if (
                UUID(identifier) != generation_id
                or not sequence.isascii()
                or not sequence.isdecimal()
            ):
                raise ValueError
            cursor = int(sequence)
            if cursor < 1 or cursor > int(snapshot.resume_after_event_id.rsplit(":", 1)[1]):
                raise ValueError
        except (ValueError, TypeError):
            raise AppError(422, "INVALID_EVENT_ID", "事件游标无效。") from None
    gen = snapshot.generation
    if (
        gen.finished_at
        and (now() - aware(gen.finished_at)).total_seconds()
        >= request.app.state.settings.chat_event_retention_seconds
    ):
        raise AppError(410, "EVENT_REPLAY_EXPIRED", "事件重放窗口已过，请重新读取消息快照。")
    token = await stream_slot(request, principal)
    return event_iterator(request, principal, session_id, generation_id, cursor, token, pet_id)


async def event_iterator(request, principal, session_id, generation_id, cursor, token, pet_id=None):
    state, service = request.app.state, ChatService(request, principal, pet_id)
    last_heartbeat = time.monotonic()
    try:
        while True:
            if await request.is_disconnected():
                return
            async with asyncio.timeout(1):
                identity = await session_user(request)
            if (
                not identity
                or identity[0].id != principal.session_id
                or identity[1].id != principal.user_id
            ):
                yield connection_error("AUTHENTICATION_REQUIRED", "请重新登录。", retryable=False)
                return
            async with state.session_factory() as db:
                await service.session(db, session_id)
                gen = await service.generation_row(db, session_id, generation_id)
                rows = list(
                    (
                        await db.scalars(
                            select(ChatGenerationEvent)
                            .join(
                                ChatSession,
                                (ChatSession.id == ChatGenerationEvent.session_id)
                                & (ChatSession.owner_id == ChatGenerationEvent.owner_id),
                            )
                            .where(
                                ChatGenerationEvent.owner_id == principal.user_id,
                                ChatGenerationEvent.session_id == session_id,
                                ChatGenerationEvent.generation_id == generation_id,
                                ChatGenerationEvent.event_sequence > cursor,
                                ChatSession.deleted_at.is_(None),
                            )
                            .order_by(ChatGenerationEvent.event_sequence)
                            .limit(50)
                        )
                    ).all()
                )
                terminal, high = gen.state not in ACTIVE, gen.last_event_sequence
            if not rows and cursor < high:
                # The committed high-water mark was read before the journal, so
                # an intact journal must contain a remaining row. Do not wait
                # forever when its suffix is missing.
                yield connection_error("STREAM_UNAVAILABLE", "请重新读取消息快照。", retryable=True)
                return
            for row in rows:
                async with asyncio.timeout(1):
                    await stream_slot(request, principal, token)
                    identity = await session_user(request)
                    async with state.session_factory() as db:
                        await service.session(db, session_id)
                if (
                    not identity
                    or identity[0].id != principal.session_id
                    or identity[1].id != principal.user_id
                ):
                    yield connection_error(
                        "AUTHENTICATION_REQUIRED", "请重新登录。", retryable=False
                    )
                    return
                if pet_id is not None and row.payload.get("pet_id") != str(pet_id):
                    yield connection_error("STREAM_UNAVAILABLE", "Event scope mismatch.")
                    return
                if row.event_sequence != cursor + 1:
                    yield connection_error(
                        "STREAM_UNAVAILABLE", "请重新读取消息快照。", retryable=True
                    )
                    return
                yield encode_event(
                    row.event_type, row.payload, f"{generation_id}:{row.event_sequence}"
                )
                cursor = row.event_sequence
                if row.event_type in ("completed", "error", "cancelled"):
                    return
            if terminal and cursor >= high:
                return
            if time.monotonic() - last_heartbeat >= state.settings.chat_heartbeat_seconds:
                await stream_slot(request, principal, token)
                yield ": ping\n\n"
                last_heartbeat = time.monotonic()
            await asyncio.sleep(state.settings.chat_poll_seconds)
    except AppError as exc:
        if exc.status != 404:
            yield connection_error(
                "STREAM_UNAVAILABLE", "连接暂时中断，请稍后重新连接。", retryable=True
            )
    except Exception:
        yield connection_error(
            "STREAM_UNAVAILABLE", "连接暂时中断，请稍后重新连接。", retryable=True
        )
    finally:
        # ASGI disconnects cancel the surrounding AnyIO scope. Give this one
        # connection's release a bounded chance to finish; TTL remains the fallback.
        with move_on_after(1, shield=True):
            try:
                await stream_slot(request, principal, token, release=True)
            except AppError:
                pass
