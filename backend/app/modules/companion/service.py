"""Owner-scoped chat commands. PostgreSQL is the authority for every accepted command."""

import base64
import hashlib
import json
from datetime import UTC, datetime
from functools import wraps
from uuid import UUID, uuid4

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import aliased

from app.agent.chat_protocol import append_event, terminalize
from app.agent.chat_runner import select_context_message_ids
from app.agent.memory_boundary import pin_generation_memory_epoch, read_memory_epoch
from app.agent.prompts import PROMPT_VERSION, get_prompt
from app.agent.provider_selection import select_chat_provider
from app.core.errors import AppError
from app.db.capabilities import SchemaUnavailable, read_revision, require_enabled_capabilities
from app.modules.companion.models import (
    AICompanion,
    ChatGeneration,
    ChatGenerationEvent,
    ChatMessage,
    ChatPreferences,
    ChatSession,
)
from app.modules.companion.schemas import (
    GenerationAccepted,
    GenerationError,
    GenerationSnapshot,
    GenerationView,
    MessagePage,
    MessageView,
    PreferencesView,
    RecentConversationSummary,
    RecentTopicView,
    SessionCreated,
    SessionPage,
    SessionView,
)
from app.modules.users.models import User

ACTIVE = ("queued", "running", "cancel_requested")


def requires_storage(operation):
    @wraps(operation)
    async def checked(self, *args, **kwargs):
        try:
            async with self.state.session_factory() as db:
                await require_enabled_capabilities(db, self.state.settings)
                if self.pet_id is not None:
                    from app.db.capabilities import require_capability

                    await require_capability(db, "pets")
        except (SQLAlchemyError, SchemaUnavailable):
            raise AppError(503, "CHAT_STORAGE_UNAVAILABLE", "聊天存储暂不可用。") from None
        return await operation(self, *args, **kwargs)

    return checked


def now():
    return datetime.now(UTC)


def aware(value):
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def not_found():
    return AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")


def conflict(code, message="状态已更新，请刷新后重试。"):
    return AppError(409, code, message)


def fingerprint(payload):
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def idempotency_key(value):
    if not value or not 16 <= len(value) <= 120 or any(not 32 <= ord(c) < 127 for c in value):
        raise AppError(422, "VALIDATION_ERROR", "请提供有效的 Idempotency-Key。")
    return value


def completion_reason(reason):
    # Legacy records may have no terminal journal. Never infer a successful reason.
    return reason if reason in ("stop", "length") else None


def completed_event_join():
    # The event and message must be read from the same database snapshot. Keeping
    # the high-water condition also prevents stale/corrupt metadata being applied.
    return and_(
        ChatGenerationEvent.generation_id == ChatGeneration.id,
        ChatGenerationEvent.session_id == ChatGeneration.session_id,
        ChatGenerationEvent.owner_id == ChatGeneration.owner_id,
        ChatGenerationEvent.event_type == "completed",
        ChatGenerationEvent.event_sequence == ChatGeneration.last_event_sequence,
        ChatGeneration.state == "completed",
    )


def generation_view(row, finish_reason=None):
    fields = {
        name: getattr(row, name)
        for name in GenerationView.model_fields
        if name not in {"last_event_id", "error", "finish_reason"}
    }
    return GenerationView(
        **fields,
        last_event_id=f"{row.id}:{row.last_event_sequence}",
        error=GenerationError(code=row.error_code, message=row.error_message)
        if row.error_code
        else None,
        finish_reason=finish_reason if row.state == "completed" else None,
    )


def message_view(row, generation_id=None, finish_reason=None):
    return MessageView.model_validate(row).model_copy(
        update={
            "generation_id": generation_id,
            "provider": None if row.role == "user" else row.provider,
            "finish_reason": finish_reason
            if row.role == "assistant" and row.status == "completed"
            else None,
        }
    )


def session_result(row, active=None):
    return SessionView.model_validate(row).model_copy(
        update={"active_generation": generation_view(active) if active else None}
    )


def encode_cursor(payload):
    return base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()


def decode_cursor(value, kind, owner, session_id=None, pet_id=None):
    try:
        if len(value) > 1024:
            raise ValueError
        data = json.loads(base64.b64decode(value, altchars=b"-_", validate=True))
        if not isinstance(data, dict):
            raise ValueError
        expected = (
            {"v", "kind", "owner", "at", "id"}
            if kind == "sessions"
            else {"v", "kind", "owner", "session", "before", "max"}
        )
        if pet_id is not None:
            expected.add("pet")
        if (
            set(data) != expected
            or type(data["v"]) is not int
            or data["v"] != 1
            or data["kind"] != kind
        ):
            raise ValueError
        if data["owner"] != str(owner) or (pet_id is not None and data["pet"] != str(pet_id)):
            raise ValueError
        if kind == "sessions":
            if not isinstance(data["at"], str) or not isinstance(data["id"], str):
                raise ValueError
            data["at"] = datetime.fromisoformat(data["at"])
            if data["at"].tzinfo is None:
                raise ValueError
            data["id"] = UUID(data["id"])
        elif (
            data["session"] != str(session_id)
            or type(data["before"]) is not int
            or type(data["max"]) is not int
            or not 0 <= data["before"] <= data["max"] <= 2_147_483_647
        ):
            raise ValueError
        return data
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise AppError(422, "INVALID_CURSOR", "分页游标无效，请重新加载。") from None


class ChatService:
    def __init__(self, request, principal, pet_id=None):
        self.request, self.principal = request, principal
        self.state = request.app.state
        self.owner = principal.user_id
        self.pet_id = pet_id

    async def scope(self, db):
        from app.modules.pets.chat import session_scope

        condition = await session_scope(db, self.owner, self.pet_id)
        if self.pet_id is not None:
            from app.modules.pets.access import owned_pet

            await owned_pet(db, self.owner, self.pet_id)
        return condition

    async def session(self, db, session_id, *, lock=False, deleted=False):
        scope = await self.scope(db)
        query = select(ChatSession).where(
            ChatSession.id == session_id, ChatSession.owner_id == self.owner, scope
        )
        if not deleted:
            query = query.where(ChatSession.deleted_at.is_(None))
        if lock:
            query = query.with_for_update()
        row = await db.scalar(query)
        if row is None:
            raise not_found()
        return row

    async def lock_user(self, db, *, allow_archived=False):
        user = await db.scalar(select(User.id).where(User.id == self.owner).with_for_update())
        if user is None:
            raise not_found()
        if self.pet_id is not None:
            from app.db.capabilities import require_capability

            await require_capability(db, "pets")
            from app.modules.pets.access import owned_pet
            from app.modules.pets.memory_policy import (
                materialize_pet_invalidations,
                pet_memory_epoch,
            )

            # Archived histories remain readable/cancellable, but cannot create work.
            pet = await owned_pet(db, self.owner, self.pet_id, write=not allow_archived)
            if allow_archived:
                await db.refresh(pet, with_for_update=True)
            await materialize_pet_invalidations(db, self.owner, self.pet_id)
            return await pet_memory_epoch(db, self.owner, self.pet_id, lock=True)
        from app.modules.memory.policy import materialize_invalidations

        await materialize_invalidations(db, self.owner)
        return await read_memory_epoch(db, self.owner, lock=True)

    async def session_view(self, db, row):
        active = await db.scalar(
            select(ChatGeneration).where(
                ChatGeneration.session_id == row.id,
                ChatGeneration.owner_id == self.owner,
                ChatGeneration.state.in_(ACTIVE),
            )
        )
        return session_result(row, active)

    @requires_storage
    async def create_session(self, payload, key):
        digest = fingerprint(payload.model_dump(mode="json"))
        if self.pet_id is not None:
            key = "pet:" + fingerprint({"pet": str(self.pet_id), "key": key})
        async with self.state.chat_admission, self.state.session_factory() as db, db.begin():
            await self.lock_user(db)
            old = await db.scalar(
                select(ChatSession).where(
                    ChatSession.owner_id == self.owner, ChatSession.create_key == key
                )
            )
            if old:
                await self.session(db, old.id, deleted=True)
                if old.create_fingerprint != digest:
                    raise conflict("IDEMPOTENCY_CONFLICT")
                if old.deleted_at is not None:
                    raise conflict("RESOURCE_DELETED")
                return SessionCreated(
                    session=await self.session_view(db, old), idempotent_replay=True
                )
            companion_id = payload.companion_id
            if self.pet_id is not None:
                from app.modules.pets.models import Pet

                companion_id = (await db.get(Pet, self.pet_id)).companion_id
            elif companion_id is not None and await read_revision(db) == "0006":
                from app.modules.pets.models import Pet

                if await db.scalar(select(Pet.id).where(Pet.companion_id == companion_id)):
                    raise not_found()
            query = select(AICompanion).where(AICompanion.owner_id == self.owner)
            companion = await db.scalar(
                query.where(AICompanion.id == companion_id)
                if companion_id
                else query.where(AICompanion.is_default.is_(True))
            )
            if companion_id and not companion:
                raise not_found()
            if companion is None:
                companion = AICompanion(
                    id=uuid4(),
                    owner_id=self.owner,
                    name="未毕业伙伴",
                    persona="温和、诚实地帮助用户梳理情绪和求职计划。",
                    prompt_version=PROMPT_VERSION,
                    is_default=True,
                )
                db.add(companion)
                await db.flush()
            row = ChatSession(
                id=uuid4(),
                owner_id=self.owner,
                companion_id=companion.id,
                title=payload.title,
                last_activity_at=now(),
                version=1,
                next_message_sequence=0,
                create_key=key,
                create_fingerprint=digest,
            )
            db.add(row)
            await db.flush()
            if self.pet_id is not None:
                from app.modules.pets.models import PetChatBinding

                db.add(PetChatBinding(session_id=row.id, owner_id=self.owner, pet_id=self.pet_id))
                await db.flush()
            return SessionCreated(session=await self.session_view(db, row), idempotent_replay=False)

    @requires_storage
    async def list_sessions(self, limit, cursor):
        query = select(ChatSession).where(
            ChatSession.owner_id == self.owner, ChatSession.deleted_at.is_(None)
        )
        if cursor:
            c = decode_cursor(cursor, "sessions", self.owner, pet_id=self.pet_id)
            query = query.where(
                or_(
                    ChatSession.last_activity_at < c["at"],
                    and_(ChatSession.last_activity_at == c["at"], ChatSession.id < c["id"]),
                )
            )
        async with self.state.session_factory() as db:
            query = query.where(await self.scope(db))
            rows = list(
                (
                    await db.scalars(
                        query.order_by(
                            ChatSession.last_activity_at.desc(), ChatSession.id.desc()
                        ).limit(limit + 1)
                    )
                ).all()
            )
            more, rows = len(rows) > limit, rows[:limit]
            next_cursor = (
                encode_cursor(
                    {
                        "v": 1,
                        "kind": "sessions",
                        **({"pet": str(self.pet_id)} if self.pet_id is not None else {}),
                        "owner": str(self.owner),
                        "at": aware(rows[-1].last_activity_at).isoformat(),
                        "id": str(rows[-1].id),
                    }
                )
                if more
                else None
            )
            active_by_session = {}
            if rows:
                active = await db.scalars(
                    select(ChatGeneration).where(
                        ChatGeneration.owner_id == self.owner,
                        ChatGeneration.session_id.in_([row.id for row in rows]),
                        ChatGeneration.state.in_(ACTIVE),
                    )
                )
                active_by_session = {gen.session_id: gen for gen in active}
            return SessionPage(
                items=[session_result(row, active_by_session.get(row.id)) for row in rows],
                next_cursor=next_cursor,
                has_more=more,
            )

    @requires_storage
    async def detail(self, session_id):
        async with self.state.session_factory() as db:
            return await self.session_view(db, await self.session(db, session_id))

    @requires_storage
    async def rename(self, session_id, payload):
        async with self.state.chat_admission, self.state.session_factory() as db, db.begin():
            await self.lock_user(db)
            row = await self.session(db, session_id, lock=True)
            if row.version != payload.expected_version:
                raise conflict("VERSION_CONFLICT")
            if row.title != payload.title:
                row.title, row.version = payload.title, row.version + 1
                row.updated_at = now()
            await db.flush()
            return await self.session_view(db, row)

    @requires_storage
    async def delete(self, session_id):
        gen_id = None
        invalidated = []
        async with self.state.chat_admission, self.state.session_factory() as db, db.begin():
            # Serialize provenance deletion with memory edits and final dispatch.
            # Every memory-sensitive command starts with User -> Preferences.
            await self.lock_user(db, allow_archived=True)
            row = await self.session(db, session_id, lock=True, deleted=True)
            if row.deleted_at:
                return
            row.deleted_at, row.version = now(), row.version + 1
            gen = await db.scalar(
                select(ChatGeneration)
                .where(
                    ChatGeneration.session_id == session_id,
                    ChatGeneration.owner_id == self.owner,
                    ChatGeneration.state.in_(ACTIVE),
                )
                .with_for_update()
            )
            if gen:
                gen_id = gen.id
                if gen.state == "queued":
                    assistant = await db.get(ChatMessage, gen.assistant_message_id)
                    await terminalize(
                        db, row, gen, assistant, "cancelled", reason="session_deleted"
                    )
                else:
                    gen.state = "cancel_requested"
            await db.flush()
            from app.modules.memory.policy import materialize_invalidations

            if self.pet_id is None:
                invalidated = await materialize_invalidations(db, self.owner)
            else:
                from app.modules.pets.memory_policy import materialize_pet_invalidations

                invalidated = await materialize_pet_invalidations(db, self.owner, self.pet_id)
        if gen_id:
            self.state.chat_runner.cancel(gen_id)
        for generation_id in invalidated:
            self.state.chat_runner.cancel(generation_id)
        self.state.chat_runner.notify()

    async def generation_row(self, db, session_id, generation_id, *, lock=False):
        query = select(ChatGeneration).where(
            ChatGeneration.id == generation_id,
            ChatGeneration.session_id == session_id,
            ChatGeneration.owner_id == self.owner,
        )
        if self.pet_id is not None:
            from app.modules.pets.models import PetGenerationContext

            query = query.where(
                ChatGeneration.id.in_(
                    select(PetGenerationContext.generation_id).where(
                        PetGenerationContext.pet_id == self.pet_id,
                        PetGenerationContext.owner_id == self.owner,
                        PetGenerationContext.session_id == session_id,
                    )
                )
            )
        if lock:
            query = query.with_for_update()
        row = await db.scalar(query)
        if row is None:
            raise not_found()
        return row

    async def completed_reason(self, db, gen):
        if gen.state != "completed":
            return None
        payload = await db.scalar(
            select(ChatGenerationEvent.payload["finish_reason"].as_string())
            .select_from(ChatGeneration)
            .join(ChatGenerationEvent, completed_event_join())
            .join(
                ChatSession,
                and_(
                    ChatSession.id == ChatGeneration.session_id,
                    ChatSession.owner_id == ChatGeneration.owner_id,
                ),
            )
            .where(
                ChatGeneration.id == gen.id,
                ChatGeneration.session_id == gen.session_id,
                ChatGeneration.owner_id == self.owner,
                ChatSession.deleted_at.is_(None),
            )
        )
        return completion_reason(payload)

    async def accepted(self, db, gen, replay):
        messages = await db.scalars(
            select(ChatMessage).where(
                ChatMessage.id.in_((gen.user_message_id, gen.assistant_message_id)),
                ChatMessage.session_id == gen.session_id,
                ChatMessage.owner_id == self.owner,
            )
        )
        by_id = {message.id: message for message in messages}
        user, assistant = by_id[gen.user_message_id], by_id[gen.assistant_message_id]
        reason = await self.completed_reason(db, gen)
        return GenerationAccepted(
            generation=generation_view(gen, reason),
            user_message=message_view(user),
            assistant_message=message_view(assistant, gen.id, reason),
            events_url=(
                f"/api/v1/pets/{self.pet_id}" if self.pet_id is not None else "/api/v1/companion"
            )
            + f"/sessions/{gen.session_id}/generations/{gen.id}/events",
            idempotent_replay=replay,
        )

    @requires_storage
    async def send(self, session_id, payload, key, *, retry=False):
        digest = fingerprint(payload.model_dump(mode="json"))
        operation = "retry" if retry else "send"
        async with self.state.chat_admission, self.state.session_factory() as db, db.begin():
            memory_policy = await self.lock_user(db)
            row = await self.session(db, session_id, lock=True)
            old = await db.scalar(
                select(ChatGeneration).where(
                    ChatGeneration.owner_id == self.owner,
                    ChatGeneration.session_id == session_id,
                    ChatGeneration.operation == operation,
                    ChatGeneration.idempotency_key == key,
                )
            )
            if old:
                if old.request_fingerprint != digest:
                    raise conflict("IDEMPOTENCY_CONFLICT")
                return await self.accepted(db, old, True)
            parent = None
            if not retry:
                duplicate = await db.scalar(
                    select(ChatMessage.id).where(
                        ChatMessage.owner_id == self.owner,
                        ChatMessage.session_id == session_id,
                        ChatMessage.client_message_id == payload.client_message_id,
                    )
                )
                if duplicate:
                    raise conflict("DUPLICATE_CLIENT_MESSAGE")
            else:
                parent = await self.generation_row(db, session_id, payload.retry_of_generation_id)
                latest_user = await db.scalar(
                    select(ChatMessage.id)
                    .where(
                        ChatMessage.owner_id == self.owner,
                        ChatMessage.session_id == session_id,
                        ChatMessage.role == "user",
                    )
                    .order_by(ChatMessage.sequence.desc())
                    .limit(1)
                )
                success = await db.scalar(
                    select(ChatGeneration.id)
                    .where(
                        ChatGeneration.owner_id == self.owner,
                        ChatGeneration.session_id == session_id,
                        ChatGeneration.user_message_id == parent.user_message_id,
                        ChatGeneration.state == "completed",
                    )
                    .limit(1)
                )
                if (
                    parent.state not in ("failed", "cancelled")
                    or latest_user != parent.user_message_id
                    or success
                ):
                    raise conflict("RETRY_NOT_ALLOWED")
            await self.check_capacity(db, session_id, retry=retry)
            companion = await db.scalar(
                select(AICompanion).where(
                    AICompanion.id == row.companion_id, AICompanion.owner_id == self.owner
                )
            )
            prompt_version = (
                PROMPT_VERSION if companion.prompt_version == "v1" else companion.prompt_version
            )
            try:
                get_prompt(prompt_version)
            except KeyError:
                raise AppError(503, "PROMPT_UNAVAILABLE", "伙伴的提示词版本暂不可用。") from None
            selection = select_chat_provider(self.state.settings, self.owner, self.pet_id)
            timestamp = now()
            if retry:
                user = await db.get(ChatMessage, parent.user_message_id)
            else:
                user = ChatMessage(
                    id=uuid4(),
                    owner_id=self.owner,
                    session_id=session_id,
                    client_message_id=payload.client_message_id,
                    sequence=row.next_message_sequence,
                    role="user",
                    content=payload.content,
                    status="completed",
                    provider=None,
                    created_at=timestamp,
                    completed_at=timestamp,
                )
                db.add(user)
                row.next_message_sequence += 1
            assistant = ChatMessage(
                id=uuid4(),
                owner_id=self.owner,
                session_id=session_id,
                sequence=row.next_message_sequence,
                role="assistant",
                content="",
                status="queued",
                provider=selection.provider,
                created_at=timestamp,
            )
            row.next_message_sequence += 1
            row.last_message_at = row.last_activity_at = timestamp
            row.version += 1
            db.add(assistant)
            await db.flush()
            gen = ChatGeneration(
                id=uuid4(),
                owner_id=self.owner,
                session_id=session_id,
                user_message_id=user.id,
                assistant_message_id=assistant.id,
                retry_of_generation_id=parent.id if parent else None,
                operation=operation,
                idempotency_key=key,
                request_fingerprint=digest,
                state="queued",
                provider=selection.provider,
                model=selection.model,
                prompt_version=prompt_version,
                lease_version=0,
                last_event_sequence=0,
                context_message_ids=await select_context_message_ids(
                    db,
                    self.owner,
                    session_id,
                    user,
                    context_epoch_floor=memory_policy.floor,
                    pet_id=self.pet_id,
                ),
                created_at=timestamp,
            )
            db.add(gen)
            await db.flush()
            from app.modules.beta_quota.service import reserve as reserve_beta_quota

            await reserve_beta_quota(db, gen, self.state.settings)
            if self.pet_id is None:
                await pin_generation_memory_epoch(db, gen.id, self.owner, memory_policy)
            else:
                from app.modules.pets.models import Pet, PetGenerationContext

                pet = await db.get(Pet, self.pet_id)
                db.add(
                    PetGenerationContext(
                        generation_id=gen.id,
                        owner_id=self.owner,
                        pet_id=self.pet_id,
                        session_id=session_id,
                        persona_version=pet.version,
                        persona_snapshot={
                            "name": pet.name,
                            "role_type": pet.role_type,
                            "persona_config": pet.persona_config,
                        },
                        memory_epoch=memory_policy.epoch,
                        context_not_before=memory_policy.context_not_before,
                        memory_refs=[],
                    )
                )
                await db.flush()
            await append_event(
                db,
                gen,
                "start",
                {
                    "user_message_id": str(user.id),
                    "state": "queued",
                    "mode": "mock" if gen.provider == "mock" else "real",
                    "persisted": True,
                },
            )
            result = await self.accepted(db, gen, False)
        self.state.chat_runner.notify()
        return result

    async def check_capacity(self, db, session_id, *, retry=False):
        active = (
            select(func.count()).select_from(ChatGeneration).where(ChatGeneration.state.in_(ACTIVE))
        )
        in_session = await db.scalar(
            active.where(
                ChatGeneration.owner_id == self.owner, ChatGeneration.session_id == session_id
            )
        )
        if in_session:
            raise conflict(
                "RETRY_NOT_ALLOWED" if retry else "GENERATION_IN_PROGRESS",
                "这段会话还有一条回复正在生成。",
            )
        settings = self.state.settings
        owned = await db.scalar(active.where(ChatGeneration.owner_id == self.owner))
        total = await db.scalar(active)
        if owned >= settings.chat_user_active_limit or total >= settings.chat_total_active_limit:
            raise AppError(
                429, "CHAT_CAPACITY_LIMIT", "当前生成任务较多，请稍后再试。", {"Retry-After": "5"}
            )

    @requires_storage
    async def messages(self, session_id, limit, cursor):
        async with self.state.session_factory() as db:
            await self.session(db, session_id)
            query = (
                select(
                    ChatMessage,
                    ChatGeneration.id,
                    ChatGenerationEvent.payload["finish_reason"].as_string(),
                )
                .select_from(ChatMessage)
                .join(
                    ChatSession,
                    and_(
                        ChatSession.id == ChatMessage.session_id,
                        ChatSession.owner_id == ChatMessage.owner_id,
                        ChatSession.deleted_at.is_(None),
                    ),
                )
                .outerjoin(
                    ChatGeneration,
                    and_(
                        ChatGeneration.assistant_message_id == ChatMessage.id,
                        ChatGeneration.session_id == session_id,
                        ChatGeneration.owner_id == self.owner,
                    ),
                )
                .outerjoin(ChatGenerationEvent, completed_event_join())
            )
            query = query.where(
                ChatMessage.session_id == session_id,
                ChatMessage.owner_id == self.owner,
                ChatMessage.role.in_(("user", "assistant")),
            )
            if cursor:
                c = decode_cursor(cursor, "messages", self.owner, session_id, self.pet_id)
                high = c["max"]
                query = query.where(ChatMessage.sequence < c["before"])
            else:
                high = await db.scalar(
                    select(func.max(ChatMessage.sequence))
                    .join(
                        ChatSession,
                        and_(
                            ChatSession.id == ChatMessage.session_id,
                            ChatSession.owner_id == ChatMessage.owner_id,
                            ChatSession.deleted_at.is_(None),
                        ),
                    )
                    .where(ChatMessage.session_id == session_id, ChatMessage.owner_id == self.owner)
                )
                high = high if high is not None else -1
            pairs = list(
                (
                    await db.execute(
                        query.where(ChatMessage.sequence <= high)
                        .order_by(ChatMessage.sequence.desc())
                        .limit(limit + 1)
                    )
                ).all()
            )
            if not pairs:
                await self.session(db, session_id)
            more, pairs = len(pairs) > limit, pairs[:limit]
            next_cursor = (
                encode_cursor(
                    {
                        "v": 1,
                        "kind": "messages",
                        **({"pet": str(self.pet_id)} if self.pet_id is not None else {}),
                        "owner": str(self.owner),
                        "session": str(session_id),
                        "before": pairs[-1][0].sequence,
                        "max": high,
                    }
                )
                if more
                else None
            )
            return MessagePage(
                items=[
                    message_view(m, g, completion_reason(payload))
                    for m, g, payload in reversed(pairs)
                ],
                next_cursor=next_cursor,
                has_more=more,
            )

    @requires_storage
    async def snapshot(self, session_id, generation_id):
        # Content and event high-water mark share a DB snapshot.
        async with self.state.session_factory() as db:
            await self.session(db, session_id)
            await self.generation_row(db, session_id, generation_id)
            pair = (
                await db.execute(
                    select(
                        ChatGeneration,
                        ChatMessage,
                        ChatGenerationEvent.payload["finish_reason"].as_string(),
                    )
                    .join(
                        ChatMessage,
                        and_(
                            ChatMessage.id == ChatGeneration.assistant_message_id,
                            ChatMessage.owner_id == ChatGeneration.owner_id,
                            ChatMessage.session_id == ChatGeneration.session_id,
                        ),
                    )
                    .join(
                        ChatSession,
                        and_(
                            ChatSession.id == ChatGeneration.session_id,
                            ChatSession.owner_id == ChatGeneration.owner_id,
                        ),
                    )
                    .outerjoin(ChatGenerationEvent, completed_event_join())
                    .where(
                        ChatGeneration.id == generation_id,
                        ChatGeneration.session_id == session_id,
                        ChatGeneration.owner_id == self.owner,
                        ChatSession.deleted_at.is_(None),
                    )
                )
            ).one_or_none()
            if pair is None:
                raise not_found()
            gen, assistant, payload = pair
            reason = completion_reason(payload)
            view = generation_view(gen, reason)
            return GenerationSnapshot(
                generation=view,
                assistant_message=message_view(assistant, gen.id, reason),
                resume_after_event_id=view.last_event_id,
            )

    @requires_storage
    async def cancel(self, session_id, generation_id):
        async with self.state.chat_admission, self.state.session_factory() as db, db.begin():
            await self.lock_user(db, allow_archived=True)
            row = await self.session(db, session_id, lock=True)
            gen = await self.generation_row(db, session_id, generation_id, lock=True)
            if gen.state == "queued":
                assistant = await db.get(ChatMessage, gen.assistant_message_id)
                await terminalize(db, row, gen, assistant, "cancelled", reason="user_requested")
            elif gen.state in ("running", "cancel_requested"):
                gen.state = "cancel_requested"
            await db.flush()
            result = generation_view(gen, await self.completed_reason(db, gen))
            pending = gen.state == "cancel_requested"
        self.state.chat_runner.cancel(generation_id)
        self.state.chat_runner.notify()
        return result, pending

    @requires_storage
    async def memory_refs(self, session_id, generation_id):
        from app.agent.memory_boundary import generation_memory_epoch
        from app.db.capabilities import require_capability
        from app.modules.memory.models import MemoryGenerationRef
        from app.modules.memory.policy import eligible_candidates

        async with self.state.session_factory() as db:
            await self.session(db, session_id)
            await self.generation_row(db, session_id, generation_id)
            try:
                await require_capability(db, "memory")
            except SchemaUnavailable:
                raise AppError(503, "MEMORY_STORAGE_UNAVAILABLE", "记忆引用尚未就绪。") from None
            refs = (
                await db.scalars(
                    select(MemoryGenerationRef)
                    .where(
                        MemoryGenerationRef.owner_id == self.owner,
                        MemoryGenerationRef.session_id == session_id,
                        MemoryGenerationRef.generation_id == generation_id,
                    )
                    .order_by(MemoryGenerationRef.rank)
                )
            ).all()
            eligible = {item.id: item for item in await eligible_candidates(db, self.owner)}
            return {
                "items": [
                    {
                        "memory_id": str(ref.memory_id),
                        "memory_version": ref.memory_version,
                        "availability": "available"
                        if ref.memory_id in eligible
                        and eligible[ref.memory_id].version == ref.memory_version
                        else "unavailable",
                    }
                    for ref in refs
                ],
                "privacy_epoch": str(await generation_memory_epoch(db, generation_id, self.owner)),
            }

    @requires_storage
    async def preferences(self):
        async with self.state.session_factory() as db:
            row = await db.get(ChatPreferences, self.owner)
            return (
                PreferencesView.model_validate(row)
                if row
                else PreferencesView(recent_topic_enabled=False, version=0, consented_at=None)
            )

    @requires_storage
    async def update_preferences(self, payload):
        async with self.state.chat_admission, self.state.session_factory() as db, db.begin():
            await self.lock_user(db)
            row = await db.get(ChatPreferences, self.owner, with_for_update=True)
            if payload.expected_version != (row.version if row else 0):
                raise conflict("VERSION_CONFLICT")
            if row is None:
                row = ChatPreferences(user_id=self.owner, version=1, recent_topic_enabled=False)
                db.add(row)
            else:
                row.version += 1
            if payload.recent_topic_enabled and not row.recent_topic_enabled:
                row.consented_at = now()
                row.dismissed_session_id = row.source_message_id = row.summary_version = None
            row.recent_topic_enabled = payload.recent_topic_enabled
            await db.flush()
            return PreferencesView.model_validate(row)

    async def topic_candidate(self, db):
        scope = await self.scope(db)
        user, assistant = aliased(ChatMessage), aliased(ChatMessage)
        pair = (
            await db.execute(
                select(ChatSession, ChatGeneration, user)
                .join(
                    ChatGeneration,
                    and_(
                        ChatGeneration.session_id == ChatSession.id,
                        ChatGeneration.owner_id == ChatSession.owner_id,
                    ),
                )
                .join(
                    user,
                    and_(
                        user.id == ChatGeneration.user_message_id,
                        user.session_id == ChatSession.id,
                        user.owner_id == self.owner,
                        user.role == "user",
                        user.status == "completed",
                    ),
                )
                .join(
                    assistant,
                    and_(
                        assistant.id == ChatGeneration.assistant_message_id,
                        assistant.session_id == ChatSession.id,
                        assistant.owner_id == self.owner,
                        assistant.role == "assistant",
                        assistant.status == "completed",
                    ),
                )
                .where(
                    ChatSession.owner_id == self.owner,
                    ChatSession.deleted_at.is_(None),
                    scope,
                    ChatGeneration.state == "completed",
                )
                .order_by(ChatGeneration.finished_at.desc(), ChatGeneration.id.desc())
                .limit(1)
            )
        ).one_or_none()
        if pair is None:
            return None
        session, gen, user_message = pair
        text = " ".join(user_message.content.split())
        return RecentConversationSummary(
            conversation_id=session.id,
            title=session.title,
            summary=text if len(text) <= 80 else text[:79] + "…",
            last_message_at=gen.finished_at,
            follow_up_text="如果你愿意，我们可以从上次的这段话接着聊。",
            source_message_ids=[gen.user_message_id, gen.assistant_message_id],
            summary_version=f"{session.id}:{gen.user_message_id}:{gen.assistant_message_id}",
        )

    @requires_storage
    async def recent_topic(self):
        async with self.state.session_factory() as db:
            pref = await db.get(ChatPreferences, self.owner)
            if not pref or not pref.recent_topic_enabled:
                return RecentTopicView(item=None)
            item = await self.topic_candidate(db)
            if item and item.summary_version == pref.summary_version:
                item = None
            if item and pref.source_message_id:
                # A deleted hidden session remains a privacy tombstone, not permission
                # to replace its dismissed topic with an even older conversation.
                hidden_time = await db.scalar(
                    select(ChatGeneration.finished_at)
                    .where(
                        ChatGeneration.owner_id == self.owner,
                        ChatGeneration.session_id == pref.dismissed_session_id,
                        ChatGeneration.user_message_id == pref.source_message_id,
                        ChatGeneration.state == "completed",
                    )
                    .order_by(ChatGeneration.finished_at.desc())
                    .limit(1)
                )
                if hidden_time and aware(item.last_message_at) <= aware(hidden_time):
                    item = None
            return RecentTopicView(item=item)

    @requires_storage
    async def dismiss_topic(self, session_id, payload):
        async with self.state.chat_admission, self.state.session_factory() as db, db.begin():
            await self.lock_user(db)
            await self.session(db, session_id, lock=True)
            pref = await db.get(ChatPreferences, self.owner, with_for_update=True)
            if (
                pref
                and pref.summary_version == payload.summary_version
                and pref.dismissed_session_id == session_id
            ):
                return
            if not pref or not pref.recent_topic_enabled:
                raise conflict("RECENT_TOPIC_DISABLED")
            candidate = await self.topic_candidate(db)
            if (
                not candidate
                or candidate.conversation_id != session_id
                or candidate.summary_version != payload.summary_version
            ):
                raise conflict("TOPIC_STALE")
            pref.dismissed_session_id, pref.source_message_id = (
                session_id,
                candidate.source_message_ids[0],
            )
            pref.summary_version = candidate.summary_version
            pref.version += 1
