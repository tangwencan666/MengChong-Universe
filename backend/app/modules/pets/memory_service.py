"""Explicit pet-local memory commands; no automatic extraction or legacy sharing."""

import base64
import hashlib
import hmac
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.core.errors import AppError
from app.db.capabilities import SchemaUnavailable, require_capability
from app.modules.auth.store import rate_limit
from app.modules.memory.privacy import screen
from app.modules.pets.access import owned_pet
from app.modules.pets.memory_policy import invalidate_pet_generations, source_groups, valid_sources
from app.modules.pets.models import (
    PetMemory as Memory,
)
from app.modules.pets.models import (
    PetMemoryConsent as MemoryConsentEvent,
)
from app.modules.pets.models import (
    PetMemoryOperation as MemoryOperation,
)
from app.modules.pets.models import (
    PetMemoryPreferences as MemoryPreferences,
)
from app.modules.pets.models import (
    PetMemorySource as MemorySource,
)
from app.modules.users.models import User

POLICY = "memory-policy/1"
NOTICE = "memory-notice/1"
DEFAULT_DAYS = {
    "career_goal": 90,
    "communication_preference": 180,
    "experience": 180,
    "open_topic": 30,
    "explicit_note": 180,
}


def now():
    return datetime.now(UTC)


def aware(value):
    return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)


def stamp(value):
    return aware(value).isoformat().replace("+00:00", "Z") if value else None


def missing():
    return AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")


def conflict(code="VERSION_CONFLICT"):
    return AppError(409, code, "状态已更新，请重新查看后再确认。")


def effective_status(row):
    if row.status == "active" and row.expires_at and aware(row.expires_at) <= now():
        return "expired"
    return row.status


def display_summary(content):
    return content if len(content) <= 240 else content[:239] + "…"


class PetMemoryService:
    def __init__(self, request, principal, pet_id):
        self.request, self.state, self.principal = request, request.app.state, principal
        self.owner = principal.user_id
        self.pet_id = pet_id
        self.cancelled = []

    def key(self):
        settings = self.state.settings
        if not settings.memory_management_enabled or settings.memory_hmac_key is None:
            raise AppError(503, "MEMORY_FEATURE_DISABLED", "长期记忆管理尚未启用。")
        return settings.memory_hmac_key.get_secret_value().encode()

    @asynccontextmanager
    async def transaction(self, *, write=False, privacy_reducing=False):
        self.key()
        try:
            async with self.state.session_factory() as db, db.begin():
                if not write and db.bind.dialect.name == "postgresql":
                    await db.execute(
                        text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                    )
                elif write and db.bind.dialect.name == "sqlite":
                    # SQLite ignores FOR UPDATE; serialize isolated test writers explicitly.
                    await db.execute(text("BEGIN IMMEDIATE"))
                await require_capability(db, "pets")
                if write:
                    user = await db.scalar(
                        select(User)
                        .where(User.id == self.owner, User.status == "active")
                        .with_for_update()
                    )
                    if user is None:
                        raise AppError(401, "AUTHENTICATION_REQUIRED", "请重新登录。")
                await owned_pet(
                    db,
                    self.owner,
                    self.pet_id,
                    write=write,
                    allow_archived=write and privacy_reducing,
                )
                yield db
            for generation_id in self.cancelled:
                self.state.chat_runner.cancel(generation_id)
        except (SchemaUnavailable, SQLAlchemyError):
            raise AppError(503, "MEMORY_STORAGE_UNAVAILABLE", "记忆存储暂不可用。") from None

    async def preference(self, db, *, lock=False, create=False):
        row = await db.get(MemoryPreferences, self.pet_id, with_for_update=lock)
        if row is None and create:
            row = MemoryPreferences(
                pet_id=self.pet_id,
                owner_id=self.owner,
                long_term_memory_enabled=False,
                version=1,
                privacy_epoch=0,
                context_epoch_floor=0,
                last_revision=0,
            )
            db.add(row)
            await db.flush()
        return row

    def sign(self, payload):
        body = (
            base64.urlsafe_b64encode(
                json.dumps(
                    {
                        "v": 1,
                        "contract": "pet-memory/1",
                        "pet_id": str(self.pet_id),
                        "owner": str(self.owner),
                        **payload,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            )
            .rstrip(b"=")
            .decode()
        )
        signature = hmac.new(self.key(), body.encode(), hashlib.sha256).hexdigest()
        return body + "." + signature

    def decode(self, token, scope):
        try:
            if not token or len(token) > 1024:
                raise ValueError
            body, signature = token.split(".")
            expected = hmac.new(self.key(), body.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature):
                raise ValueError
            data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
            if data.get("v") != 1 or data.get("owner") != str(self.owner):
                raise ValueError
            if data.get("contract") != "pet-memory/1" or data.get("pet_id") != str(self.pet_id):
                raise ValueError
            if data.get("scope") != scope:
                raise ValueError
            return data
        except (ValueError, TypeError, UnicodeError):
            raise AppError(422, "INVALID_CURSOR", "同步游标无效。") from None

    def pref_view(self, row):
        revision = row.last_revision if row else 0
        return {
            "pet_id": str(self.pet_id),
            "long_term_memory_enabled": row.long_term_memory_enabled if row else False,
            "version": row.version if row else 0,
            "privacy_epoch": str(row.privacy_epoch if row else 0),
            "context_epoch_floor": str(row.context_epoch_floor if row else 0),
            "context_not_before": stamp(row.context_not_before) if row else None,
            "revision": str(revision),
            "sync_cursor": self.sign({"scope": "changes", "after": str(revision)}),
            "policy_version": POLICY,
            "notice_version": NOTICE,
        }

    @staticmethod
    def check_version(actual, expected):
        if actual != expected:
            raise conflict()

    @staticmethod
    def enabled(pref, expected):
        if pref is None or not pref.long_term_memory_enabled:
            raise conflict("MEMORY_DISABLED")
        if pref.version != expected:
            raise conflict("PREFERENCES_CONFLICT")

    async def owned(self, db, memory_id, *, deleted=False, lock=False):
        query = select(Memory).where(
            Memory.id == memory_id, Memory.pet_id == self.pet_id, Memory.owner_id == self.owner
        )
        if not deleted:
            query = query.where(Memory.status != "deleted")
        if lock:
            query = query.with_for_update()
        row = await db.scalar(query)
        if row is None:
            raise missing()
        return row

    async def operation(self, db, scope, key, payload):
        if not key or not 16 <= len(key) <= 120 or any(not 33 <= ord(c) <= 126 for c in key):
            raise AppError(422, "VALIDATION_ERROR", "请提供有效的 Idempotency-Key。")
        canonical = payload.model_dump(mode="json")
        # Preserve the P4-A wire fingerprint for manual confirmations without source.
        if scope.startswith("confirm:") and canonical.get("source") is None:
            canonical.pop("source", None)
        data = json.dumps(
            canonical,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        fingerprint = hmac.new(
            self.key(), (str(self.pet_id) + "\n" + scope + "\n" + data).encode(), hashlib.sha256
        ).hexdigest()
        row = await db.scalar(
            select(MemoryOperation).where(
                MemoryOperation.pet_id == self.pet_id,
                MemoryOperation.owner_id == self.owner,
                MemoryOperation.operation_scope == scope,
                MemoryOperation.idempotency_key == key,
            )
        )
        if row and not hmac.compare_digest(row.request_fingerprint, fingerprint):
            raise conflict("IDEMPOTENCY_CONFLICT")
        return row, fingerprint

    def record(self, db, scope, key, fingerprint, target=None):
        db.add(
            MemoryOperation(
                pet_id=self.pet_id,
                owner_id=self.owner,
                operation_scope=scope,
                idempotency_key=key,
                request_fingerprint=fingerprint,
                fingerprint_key_version="v1",
                target_memory_id=target,
                result_code="committed",
            )
        )

    async def admit(self, scope, key, payload):
        # Read-only precheck permits committed retries without charging another write.
        # Recheck the key under the owner lock before modifying any business state.
        async with self.transaction() as db:
            previous, _ = await self.operation(db, scope, key, payload)
        if previous is None:
            try:
                await rate_limit(
                    self.request,
                    "pet-memory-business",
                    20,
                    str(self.owner) + ":" + str(self.pet_id),
                    seconds=60,
                )
            except AppError as exc:
                if exc.status == 429:
                    exc.headers = {"Retry-After": "60"}
                raise

    async def advance(self, db, pref, *, removal=False):
        if max(pref.privacy_epoch, pref.last_revision) >= 9223372036854775806:
            raise conflict()
        pref.privacy_epoch += 1
        pref.last_revision += 1
        if removal:
            pref.context_epoch_floor = pref.privacy_epoch
            pref.context_not_before = now()
        await db.flush()
        self.cancelled.extend(await invalidate_pet_generations(db, self.owner, self.pet_id))

    async def event(self, db, pref, action, *, row=None, version=None, all_items=False):
        event = MemoryConsentEvent(
            id=uuid4(),
            pet_id=self.pet_id,
            owner_id=self.owner,
            revision=pref.last_revision,
            action=action,
            memory_id=row.id if row else None,
            memory_version=version,
            affected_all=all_items,
            policy_version=POLICY,
            notice_version=NOTICE,
            origin_client="web",
            actor_session_id=self.principal.session_id,
            privacy_epoch=pref.privacy_epoch,
        )
        db.add(event)
        await db.flush()
        return event

    async def views(self, db, rows, revision):
        if not rows:
            return []
        sources = list(
            (
                await db.scalars(
                    select(MemorySource)
                    .where(
                        MemorySource.pet_id == self.pet_id,
                        MemorySource.owner_id == self.owner,
                        MemorySource.memory_id.in_([r.id for r in rows]),
                    )
                    .order_by(MemorySource.id)
                )
            ).all()
        )
        grants = {
            r.id: r
            for r in (
                await db.scalars(
                    select(MemoryConsentEvent).where(
                        MemoryConsentEvent.pet_id == self.pet_id,
                        MemoryConsentEvent.owner_id == self.owner,
                        MemoryConsentEvent.id.in_(
                            [r.active_consent_id for r in rows if r.active_consent_id]
                        ),
                    )
                )
            ).all()
        }
        _, valid_ids = await source_groups(db, self.owner, self.pet_id, [row.id for row in rows])
        output = []
        for row in rows:
            refs = [
                {
                    "kind": source.kind,
                    "session_id": str(source.session_id) if source.session_id else None,
                    "message_id": str(source.message_id) if source.message_id else None,
                    "availability": "available"
                    if source.kind == "manual" or source.id in valid_ids
                    else "source_deleted",
                }
                for source in sources
                if source.memory_id == row.id
            ]
            if not refs and row.status == "legacy_unconfirmed":
                refs = [
                    {
                        "kind": "legacy_unverified",
                        "session_id": None,
                        "message_id": None,
                        "availability": "legacy_unverified",
                    }
                ]
            grant = grants.get(row.active_consent_id)
            output.append(
                {
                    "pet_id": str(self.pet_id),
                    "id": str(row.id),
                    "title": row.title,
                    "content": row.content,
                    "summary": row.summary,
                    "category": row.category,
                    "status": "revoked"
                    if row.status == "active"
                    and any(ref["availability"] == "source_deleted" for ref in refs)
                    else effective_status(row),
                    "version": row.version,
                    "created_at": stamp(row.created_at),
                    "updated_at": stamp(row.updated_at),
                    "last_confirmed_at": stamp(row.consent_granted_at),
                    "expires_at": stamp(row.expires_at),
                    "revision": str(revision),
                    "sources": refs,
                    "consent_ref": {
                        "id": str(grant.id),
                        "policy_version": grant.policy_version,
                        "notice_version": grant.notice_version,
                        "occurred_at": stamp(grant.occurred_at),
                    }
                    if grant
                    else None,
                }
            )
        return output

    async def replay_item(self, db, operation, revision):
        row = await self.owned(db, operation.target_memory_id, deleted=True)
        if row.status == "deleted":
            raise AppError(410, "MEMORY_UNAVAILABLE", "这条记忆已删除，原请求不会恢复它。")
        if effective_status(row) != "active":
            raise conflict("MEMORY_INACTIVE")
        return (await self.views(db, [row], revision))[0]

    async def preferences(self):
        async with self.transaction() as db:
            return self.pref_view(await self.preference(db))

    async def update_preferences(self, payload, key):
        await self.admit("preferences", key, payload)
        async with self.transaction(
            write=True, privacy_reducing=not payload.long_term_memory_enabled
        ) as db:
            pref = await self.preference(db, lock=True)
            old, fingerprint = await self.operation(db, "preferences", key, payload)
            if old:
                return self.pref_view(pref)
            self.check_version(pref.version if pref else 0, payload.expected_version)
            if payload.long_term_memory_enabled and payload.consent is None:
                raise AppError(422, "VALIDATION_ERROR", "开启前请明确确认记忆说明。")
            if (
                pref.long_term_memory_enabled if pref else False
            ) != payload.long_term_memory_enabled:
                if pref:
                    if pref.version == 2147483647:
                        raise conflict()
                    pref.version += 1
                else:
                    pref = await self.preference(db, lock=True, create=True)
                pref.long_term_memory_enabled = payload.long_term_memory_enabled
                await self.advance(db, pref, removal=not payload.long_term_memory_enabled)
                if not payload.long_term_memory_enabled:
                    rows = (
                        await db.scalars(
                            select(Memory)
                            .where(
                                Memory.pet_id == self.pet_id,
                                Memory.owner_id == self.owner,
                                Memory.status == "active",
                            )
                            .order_by(Memory.id)
                            .with_for_update()
                        )
                    ).all()
                    for row in rows:
                        self.deactivate(row, "revoked")
                await self.event(
                    db,
                    pref,
                    "enabled" if payload.long_term_memory_enabled else "disabled",
                    all_items=not payload.long_term_memory_enabled,
                )
            self.record(db, "preferences", key, fingerprint)
            await db.flush()
            return self.pref_view(pref)

    @staticmethod
    def expiry(payload):
        expires = payload.expires_at or now() + timedelta(days=DEFAULT_DAYS[payload.category])
        if expires.tzinfo is None or not now() < aware(expires) <= now() + timedelta(days=365):
            raise AppError(422, "VALIDATION_ERROR", "请选择未来一年以内的有效期。")
        return aware(expires)

    async def create(self, payload, key):
        await self.admit("create", key, payload)
        async with self.transaction(write=True) as db:
            pref = await self.preference(db, lock=True)
            previous, fingerprint = await self.operation(db, "create", key, payload)
            if previous:
                item = await self.replay_item(db, previous, pref.last_revision if pref else 0)
                return {"pet_id": str(self.pet_id), "item": item, "idempotent_replay": True}
            self.enabled(pref, payload.expected_preferences_version)
            source_messages = []
            if payload.source.kind == "chat_message":
                from app.modules.pets.memory_previews import validate_chat_source

                source_messages = await validate_chat_source(
                    db, self.principal, self.pet_id, payload.source, pref, key=self.key(), at=now()
                )
            screen(payload.title, payload.content)
            expires = self.expiry(payload)
            count = await db.scalar(
                select(func.count())
                .select_from(Memory)
                .where(
                    Memory.pet_id == self.pet_id,
                    Memory.owner_id == self.owner,
                    Memory.status != "deleted",
                )
            )
            if count >= 200:
                raise AppError(429, "MEMORY_CAPACITY_LIMIT", "请先整理现有记忆，再添加新条目。")
            await self.advance(db, pref)
            row = Memory(
                id=uuid4(),
                pet_id=self.pet_id,
                owner_id=self.owner,
                title=payload.title,
                content=payload.content,
                summary=display_summary(payload.content),
                category=payload.category,
                status="legacy_unconfirmed",
                version=1,
                consent_granted_at=now(),
                expires_at=expires,
            )
            db.add(row)
            await db.flush()
            event = await self.event(db, pref, "confirmed", row=row, version=1)
            row.active_consent_id, row.status = event.id, "active"
            row.updated_at = now()
            if source_messages:
                for message in source_messages:
                    db.add(
                        MemorySource(
                            pet_id=self.pet_id,
                            owner_id=self.owner,
                            memory_id=row.id,
                            kind="chat_message",
                            session_id=message.session_id,
                            message_id=message.id,
                            source_message_version=1,
                        )
                    )
            else:
                db.add(
                    MemorySource(
                        pet_id=self.pet_id, owner_id=self.owner, memory_id=row.id, kind="manual"
                    )
                )
            self.record(db, "create", key, fingerprint, row.id)
            await db.flush()
            item = (await self.views(db, [row], pref.last_revision))[0]
            return {"pet_id": str(self.pet_id), "item": item, "idempotent_replay": False}

    async def detail(self, memory_id):
        async with self.transaction() as db:
            pref = await self.preference(db)
            row = await self.owned(db, memory_id)
            return (await self.views(db, [row], pref.last_revision if pref else 0))[0]

    async def listing(self, limit, cursor, status, category, snapshot_revision):
        async with self.transaction() as db:
            pref = await self.preference(db)
            revision, boundary = pref.last_revision if pref else 0, None
            if cursor:
                data = self.decode(cursor, "items")
                if data.get("status") != status or data.get("category") != category:
                    raise AppError(422, "INVALID_CURSOR", "分页条件已改变。")
                snapshot_revision = data.get("revision")
                try:
                    boundary = (
                        datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00")),
                        UUID(data["id"]),
                    )
                    if boundary[0].tzinfo is None:
                        raise ValueError
                except (ValueError, KeyError, TypeError, AttributeError):
                    raise AppError(422, "INVALID_CURSOR", "分页游标无效。") from None
            if snapshot_revision is not None and snapshot_revision != str(revision):
                raise conflict("SYNC_RESTART_REQUIRED")
            query = select(Memory).where(
                Memory.pet_id == self.pet_id,
                Memory.owner_id == self.owner,
                Memory.status != "deleted",
            )
            if boundary:
                query = query.where(
                    (Memory.updated_at < boundary[0])
                    | ((Memory.updated_at == boundary[0]) & (Memory.id < boundary[1]))
                )
            if status == "expired":
                query = query.where(
                    (Memory.status == "expired")
                    | ((Memory.status == "active") & (Memory.expires_at <= now()))
                )
            elif status:
                query = query.where(Memory.status == status)
                if status == "active":
                    query = query.where(Memory.expires_at > now())
            if category:
                query = query.where(Memory.category == category)
            rows = list(
                (
                    await db.scalars(
                        query.order_by(Memory.updated_at.desc(), Memory.id.desc()).limit(limit + 1)
                    )
                ).all()
            )
            more, page = len(rows) > limit, rows[:limit]
            return {
                "pet_id": str(self.pet_id),
                "items": await self.views(db, page, revision),
                "has_more": more,
                "snapshot_revision": str(revision),
                "next_cursor": self.sign(
                    {
                        "scope": "items",
                        "revision": str(revision),
                        "updated_at": stamp(page[-1].updated_at),
                        "id": str(page[-1].id),
                        "status": status,
                        "category": category,
                    }
                )
                if more
                else None,
            }

    async def edit(self, memory_id, payload, key, *, reconfirm=False):
        scope = ("confirm:" if reconfirm else "edit:") + str(memory_id)
        await self.admit(scope, key, payload)
        async with self.transaction(write=True) as db:
            pref = await self.preference(db, lock=True)
            previous, fingerprint = await self.operation(db, scope, key, payload)
            if previous:
                return await self.replay_item(db, previous, pref.last_revision if pref else 0)
            row = await self.owned(db, memory_id)
            self.enabled(pref, payload.expected_preferences_version)
            self.check_version(row.version, payload.expected_version)
            if reconfirm and row.status == "legacy_unconfirmed":
                raise conflict("SOURCE_UNAVAILABLE")
            allowed = {"revoked", "expired"} if reconfirm else {"active"}
            if effective_status(row) not in allowed:
                raise conflict("MEMORY_INACTIVE")
            source = (
                await db.scalars(
                    select(MemorySource).where(
                        MemorySource.pet_id == self.pet_id,
                        MemorySource.owner_id == self.owner,
                        MemorySource.memory_id == row.id,
                    )
                )
            ).all()
            _, source_ids = await source_groups(db, self.owner, self.pet_id, [row.id])
            if not valid_sources(source, source_ids):
                raise conflict("SOURCE_UNAVAILABLE")
            if source[0].kind == "chat_message" and reconfirm:
                from app.modules.pets.memory_previews import validate_chat_source

                receipt = getattr(payload, "source", None)
                if receipt is None:
                    raise conflict("PREVIEW_STALE")
                if (
                    receipt.kind != "chat_message"
                    or receipt.session_id != source[0].session_id
                    or set(receipt.message_ids or []) != {item.message_id for item in source}
                ):
                    raise conflict("SOURCE_UNAVAILABLE")
                await validate_chat_source(
                    db, self.principal, self.pet_id, receipt, pref, key=self.key(), at=now()
                )
            elif getattr(payload, "source", None) is not None:
                receipt = payload.source
                if receipt.kind != source[0].kind or receipt.session_id is not None:
                    raise conflict("SOURCE_UNAVAILABLE")
            screen(payload.title, payload.content)
            expires = self.expiry(payload)
            if row.version == 2147483647:
                raise conflict()
            await self.advance(db, pref, removal=True)
            # User lock serializes this owner; generation locks were taken before memory locks.
            await db.refresh(row, with_for_update=True)
            version = row.version + 1
            event = await self.event(
                db, pref, "confirmed" if reconfirm else "corrected", row=row, version=version
            )
            row.version, row.active_consent_id = version, event.id
            row.title, row.content, row.summary = (
                payload.title,
                payload.content,
                display_summary(payload.content),
            )
            row.category, row.expires_at, row.status = payload.category, expires, "active"
            row.consent_granted_at, row.consent_revoked_at = now(), None
            row.corrected_at = now()
            row.updated_at = row.corrected_at
            self.record(db, scope, key, fingerprint, row.id)
            await db.flush()
            return (await self.views(db, [row], pref.last_revision))[0]

    @staticmethod
    def deactivate(row, status):
        if row.version == 2147483647:
            raise conflict()
        row.status, row.active_consent_id = status, None
        row.consent_revoked_at = now()
        row.updated_at = row.consent_revoked_at
        row.version += 1
        if status == "deleted":
            row.content = row.title = row.summary = ""
            row.deleted_at = now()

    async def remove(self, memory_id, payload, key, *, erase=False):
        scope = ("delete:" if erase else "revoke:") + str(memory_id)
        await self.admit(scope, key, payload)
        async with self.transaction(write=True, privacy_reducing=True) as db:
            pref = await self.preference(db, lock=True)
            previous, fingerprint = await self.operation(db, scope, key, payload)
            row = await self.owned(db, memory_id, deleted=True)
            if row.status == "deleted":
                if erase:
                    return None
                raise AppError(410, "MEMORY_UNAVAILABLE", "这条记忆已删除。")
            if previous:
                return {
                    "pet_id": str(self.pet_id),
                    "id": str(row.id),
                    "status": effective_status(row),
                    "version": row.version,
                    "revision": str(pref.last_revision if pref else 0),
                }
            self.check_version(row.version, payload.expected_version)
            pref = pref or await self.preference(db, lock=True, create=True)
            await self.advance(db, pref, removal=True)
            await db.refresh(row, with_for_update=True)
            self.deactivate(row, "deleted" if erase else "revoked")
            await self.event(
                db, pref, "deleted" if erase else "revoked", row=row, version=row.version
            )
            self.record(db, scope, key, fingerprint, row.id)
            await db.flush()
            return {
                "pet_id": str(self.pet_id),
                "id": str(row.id),
                "status": row.status,
                "version": row.version,
                "revision": str(pref.last_revision),
            }

    async def clear(self, payload, key):
        await self.admit("clear", key, payload)
        async with self.transaction(write=True, privacy_reducing=True) as db:
            pref = await self.preference(db, lock=True)
            previous, fingerprint = await self.operation(db, "clear", key, payload)
            if previous:
                return
            if payload.expected_revision != str(pref.last_revision if pref else 0):
                raise conflict("PREFERENCES_CONFLICT")
            pref = pref or await self.preference(db, lock=True, create=True)
            await self.advance(db, pref, removal=True)
            rows = (
                await db.scalars(
                    select(Memory)
                    .where(
                        Memory.pet_id == self.pet_id,
                        Memory.owner_id == self.owner,
                        Memory.status != "deleted",
                    )
                    .order_by(Memory.id)
                    .with_for_update()
                )
            ).all()
            for row in rows:
                self.deactivate(row, "deleted")
            await self.event(db, pref, "deleted", all_items=True)
            self.record(db, "clear", key, fingerprint)

    async def sources(self, memory_id):
        item = await self.detail(memory_id)
        return {
            "pet_id": str(self.pet_id),
            "memory_id": item["id"],
            "version": item["version"],
            "items": item["sources"],
        }

    async def preview(self, payload):
        from app.modules.pets.memory_previews import preview_selected

        async with self.transaction() as db:
            pref = await self.preference(db)
            return await preview_selected(
                db, self.principal, self.pet_id, payload, pref, key=self.key(), at=now()
            )

    async def retrieval_preview(self, payload):
        from app.modules.memory.budget import assemble_budgeted_context
        from app.modules.memory.retrieval import rank_memories
        from app.modules.pets.memory_policy import eligible_candidates, materialize_pet

        # Commit expiry/source tombstones independently of subsequent validation failures.
        self.key()
        await materialize_pet(self.state.session_factory, self.owner, self.pet_id)
        async with self.transaction() as db:
            pref = await self.preference(db)
            self.enabled(pref, payload.expected_preferences_version)
            screen("", payload.query)
            at = now()
            candidates = await eligible_candidates(db, self.owner, self.pet_id, at=at)
            hits = rank_memories(payload.query, candidates, self.owner, limit=payload.limit, at=at)
            settings = self.state.settings
            # This is an explanation of local Mock retrieval, never a model request.
            try:
                budget = assemble_budgeted_context(
                    [{"role": "user", "content": payload.query}],
                    "",
                    hits,
                    context_capacity=settings.memory_context_capacity,
                    output_reserve=settings.memory_output_reserve,
                    safety_margin=settings.memory_safety_margin,
                    max_memory_tokens=settings.memory_max_tokens,
                    max_memories=min(payload.limit, settings.memory_max_items),
                )
            except ValueError:
                raise AppError(503, "MEMORY_CONTEXT_UNAVAILABLE", "上下文预算暂不可用。") from None
            return {
                "pet_id": str(self.pet_id),
                "items": [
                    {
                        "memory_id": str(hit.candidate.id),
                        "version": hit.candidate.version,
                        "category": hit.candidate.category,
                        "matched_terms": list(hit.matched_terms),
                        "source_refs": list(hit.candidate.source_refs),
                    }
                    for hit in budget.selected_hits
                ],
                "privacy_epoch": str(pref.privacy_epoch),
                "counter_version": budget.report["counter_version"],
                "budget": budget.report,
                "reason": "no_match"
                if not hits
                else "budget_exhausted"
                if not budget.selected_hits
                else "matched",
            }

    async def changes(self, limit, cursor):
        async with self.transaction() as db:
            pref = await self.preference(db)
            current = pref.last_revision if pref else 0
            if not cursor:
                return {
                    "pet_id": str(self.pet_id),
                    "items": [],
                    "next_cursor": self.sign({"scope": "changes", "after": str(current)}),
                    "has_more": False,
                    "high_watermark": str(current),
                    "reset_required": True,
                }
            data = self.decode(cursor, "changes")
            try:
                after, high = int(data["after"]), int(data.get("high", current))
                if not 0 <= after <= high <= current:
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                raise AppError(422, "INVALID_CURSOR", "同步游标无效。") from None
            records = list(
                (
                    await db.scalars(
                        select(MemoryConsentEvent)
                        .where(
                            MemoryConsentEvent.pet_id == self.pet_id,
                            MemoryConsentEvent.owner_id == self.owner,
                            MemoryConsentEvent.revision > after,
                            MemoryConsentEvent.revision <= high,
                        )
                        .order_by(MemoryConsentEvent.revision)
                        .limit(limit + 1)
                    )
                ).all()
            )
            if records and aware(records[0].occurred_at) < now() - timedelta(days=90):
                raise AppError(410, "SYNC_CURSOR_EXPIRED", "请重新同步记忆设置和列表。")
            more, records = len(records) > limit, records[:limit]
            next_after = records[-1].revision if records else high
            next_data = {"scope": "changes", "after": str(next_after)}
            if more:
                next_data["high"] = str(high)
            return {
                "pet_id": str(self.pet_id),
                "items": [
                    {
                        "revision": str(row.revision),
                        "action": row.action,
                        "memory_id": str(row.memory_id) if row.memory_id else None,
                        "memory_version": row.memory_version,
                        "affected_all": row.affected_all,
                        "occurred_at": stamp(row.occurred_at),
                    }
                    for row in records
                ],
                "next_cursor": self.sign(next_data),
                "has_more": more,
                "high_watermark": str(high),
                "reset_required": False,
            }

    async def export(self, payload):
        async with self.transaction() as db:
            pref = await self.preference(db)
            query = select(Memory).where(
                Memory.pet_id == self.pet_id,
                Memory.owner_id == self.owner,
                Memory.status != "deleted",
            )
            if not payload.include_inactive:
                query = query.where(Memory.status == "active", Memory.expires_at > now())
            rows = list((await db.scalars(query.order_by(Memory.id).limit(201))).all())
            if len(rows) > 200:
                raise AppError(422, "VALIDATION_ERROR", "导出超过本阶段容量限制。")
            revision = pref.last_revision if pref else 0
            result = {
                "schema_version": "pet-memory/1",
                "pet_id": str(self.pet_id),
                "exported_at": stamp(now()),
                "snapshot_revision": str(revision),
                "items": await self.views(db, rows, revision),
            }
            if len(json.dumps(result, ensure_ascii=False).encode()) > 2 * 1024 * 1024:
                raise AppError(422, "VALIDATION_ERROR", "导出超过大小限制。")
            return result
