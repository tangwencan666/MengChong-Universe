"""Pet identities are explicit and do not adopt legacy conversations or memories."""

import base64
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.core.errors import AppError
from app.db.capabilities import SchemaUnavailable, require_capability
from app.modules.companion.models import AICompanion
from app.modules.companion.service import fingerprint, idempotency_key
from app.modules.pets.access import owned_pet
from app.modules.pets.models import Pet, PetMemoryPreferences
from app.modules.pets.schemas import PetPage, PetView
from app.modules.users.models import User


def view(row):
    return PetView(
        pet_id=row.id,
        **{field: getattr(row, field) for field in PetView.model_fields if field != "pet_id"},
    )


def conflict(code="VERSION_CONFLICT"):
    return AppError(409, code, "状态已更新，请刷新后重试。")


class PetService:
    def __init__(self, request, principal):
        self.request, self.state, self.owner = request, request.app.state, principal.user_id
        self.cancelled = []

    @asynccontextmanager
    async def transaction(self, *, write=False):
        try:
            async with self.state.session_factory() as db, db.begin():
                if write and db.bind.dialect.name == "sqlite":
                    await db.execute(text("BEGIN IMMEDIATE"))
                elif not write and db.bind.dialect.name == "postgresql":
                    await db.execute(
                        text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                    )
                await require_capability(db, "pets")
                if write:
                    user = await db.scalar(
                        select(User.id)
                        .where(User.id == self.owner, User.status == "active")
                        .with_for_update()
                    )
                    if user is None:
                        raise AppError(401, "AUTHENTICATION_REQUIRED", "请重新登录。")
                yield db
            runner = getattr(self.state, "chat_runner", None)
            if runner:
                for generation_id in self.cancelled:
                    runner.cancel(generation_id)
        except (SchemaUnavailable, SQLAlchemyError):
            raise AppError(503, "PET_STORAGE_UNAVAILABLE", "宠物存储暂不可用。") from None

    async def create(self, payload, key):
        key = idempotency_key(key)
        data = payload.model_dump(mode="json")
        digest = fingerprint(data)
        async with self.transaction(write=True) as db:
            existing = await db.scalar(
                select(Pet).where(Pet.owner_id == self.owner, Pet.create_key == key)
            )
            if existing:
                if existing.create_fingerprint != digest:
                    raise conflict("IDEMPOTENCY_CONFLICT")
                return view(existing)
            companion = AICompanion(
                id=uuid4(),
                owner_id=self.owner,
                name=payload.name,
                persona="宠物人格由经验证的 pet-v1 配置单独管理。",
                prompt_version="pet-v1",
                is_default=False,
            )
            db.add(companion)
            await db.flush()
            row = Pet(
                id=uuid4(),
                owner_id=self.owner,
                companion_id=companion.id,
                status="active",
                version=1,
                create_key=key,
                create_fingerprint=digest,
                **data,
            )
            db.add(row)
            await db.flush()
            db.add(
                PetMemoryPreferences(
                    pet_id=row.id,
                    owner_id=self.owner,
                    long_term_memory_enabled=False,
                    version=1,
                    privacy_epoch=0,
                    context_epoch_floor=0,
                    last_revision=0,
                )
            )
            await db.flush()
            return view(row)

    async def detail(self, pet_id):
        async with self.transaction() as db:
            return view(await owned_pet(db, self.owner, pet_id))

    def cursor(self, row, status):
        body = {
            "v": 1,
            "owner": str(self.owner),
            "status": status,
            "at": row.created_at.replace(tzinfo=row.created_at.tzinfo or UTC).isoformat(),
            "id": str(row.id),
        }
        return base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":")).encode()).decode()

    def decode_cursor(self, token, status):
        try:
            if len(token) > 1024:
                raise ValueError
            data = json.loads(base64.b64decode(token, altchars=b"-_", validate=True))
            if (
                not isinstance(data, dict)
                or set(data) != {"v", "owner", "status", "at", "id"}
                or type(data["v"]) is not int
                or data["v"] != 1
                or data["owner"] != str(self.owner)
                or data["status"] != status
                or not isinstance(data["at"], str)
                or not isinstance(data["id"], str)
            ):
                raise ValueError
            moment, identifier = datetime.fromisoformat(data["at"]), UUID(data["id"])
            if moment.tzinfo is None:
                raise ValueError
            return moment, identifier
        except (ValueError, TypeError, KeyError, UnicodeError):
            raise AppError(422, "INVALID_CURSOR", "分页信息已失效，请重新查看。") from None

    async def listing(self, status="active", limit=30, cursor=None):
        async with self.transaction() as db:
            query = select(Pet).where(Pet.owner_id == self.owner, Pet.status == status)
            # SQLite server timestamps omit fractional seconds, whereas bound
            # datetimes include them. Normalize both comparison and ordering;
            # PostgreSQL retains its native timestamp precision.
            sqlite = db.bind.dialect.name == "sqlite"
            created = func.datetime(Pet.created_at) if sqlite else Pet.created_at
            if cursor:
                moment, identifier = self.decode_cursor(cursor, status)
                boundary = func.datetime(moment) if sqlite else moment
                query = query.where(
                    or_(created < boundary, and_(created == boundary, Pet.id < identifier))
                )
            rows = list(
                (
                    await db.scalars(query.order_by(created.desc(), Pet.id.desc()).limit(limit + 1))
                ).all()
            )
            more = len(rows) > limit
            rows = rows[:limit]
            return PetPage(
                items=[view(row) for row in rows],
                has_more=more,
                next_cursor=self.cursor(rows[-1], status) if more else None,
            )

    @staticmethod
    def check_version(row, expected):
        if row.version != expected or row.version >= 2147483647:
            raise conflict()

    async def update(self, pet_id, payload):
        async with self.transaction(write=True) as db:
            row = await owned_pet(db, self.owner, pet_id, write=True)
            self.check_version(row, payload.expected_version)
            for field, value in payload.model_dump(exclude_unset=True, mode="json").items():
                if field != "expected_version":
                    setattr(row, field, value)
            row.version += 1
            await db.flush()
            await db.refresh(row)
            return view(row)

    async def visibility(self, pet_id, payload):
        async with self.transaction(write=True) as db:
            row = await owned_pet(db, self.owner, pet_id, write=True)
            self.check_version(row, payload.expected_version)
            row.status = "hidden" if payload.hidden else "active"
            row.version += 1
            await db.flush()
            await db.refresh(row)
            return view(row)

    async def archive(self, pet_id, payload):
        from app.modules.pets.chat import archive_pet_generations

        async with self.transaction(write=True) as db:
            row = await owned_pet(db, self.owner, pet_id, write=True)
            self.check_version(row, payload.expected_version)
            row.status = "archived"
            row.version += 1
            self.cancelled.extend(
                await archive_pet_generations(db, self.owner, pet_id, settings=self.state.settings)
            )
            await db.flush()
            await db.refresh(row)
            return view(row)
