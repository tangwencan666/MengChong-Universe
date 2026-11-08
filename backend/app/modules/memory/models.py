from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    false,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Entity
from app.modules.companion.models import ChatGeneration


class Memory(Entity, Base):
    __tablename__ = "memories"
    __table_args__ = (
        UniqueConstraint("id", "owner_id"),
        ForeignKeyConstraint(
            ["source_session_id", "owner_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        CheckConstraint(
            "consent_granted_at IS NOT NULL AND "
            "(consent_revoked_at IS NULL OR consent_revoked_at >= consent_granted_at)",
            name="consent_valid",
        ),
        ForeignKeyConstraint(
            ["active_consent_id", "id", "owner_id", "version"],
            [
                "memory_consent_events.id",
                "memory_consent_events.memory_id",
                "memory_consent_events.owner_id",
                "memory_consent_events.memory_version",
            ],
            use_alter=True,
        ),
        CheckConstraint(
            "status IN ('active','revoked','expired','deleted','legacy_unconfirmed')",
            name="status_valid",
        ),
        CheckConstraint("version BETWEEN 1 AND 2147483647", name="version_valid"),
        CheckConstraint(
            "category IS NULL OR category IN ('career_goal','communication_preference',"
            "'experience','open_topic','explicit_note')",
            name="category_valid",
        ),
        CheckConstraint(
            "status <> 'active' OR (length(content) BETWEEN 1 AND 1000 "
            "AND length(title) BETWEEN 1 AND 80 AND category IS NOT NULL "
            "AND expires_at IS NOT NULL AND active_consent_id IS NOT NULL "
            "AND deleted_at IS NULL AND consent_revoked_at IS NULL)",
            name="active_complete",
        ),
        CheckConstraint(
            "status <> 'deleted' OR (content = '' AND title = '' AND summary = '' "
            "AND active_consent_id IS NULL AND deleted_at IS NOT NULL)",
            name="deleted_content_erased",
        ),
        CheckConstraint("status = 'active' OR active_consent_id IS NULL", name="grant_state_valid"),
        CheckConstraint("length(summary) <= 240", name="summary_bounded"),
        Index("ix_memories_owner_id_created_at", "owner_id", "created_at"),
        Index("ix_memories_owner_status_expiry", "owner_id", "status", "expires_at", "id"),
        Index("ix_memories_owner_updated", "owner_id", "updated_at", "id"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    source_session_id: Mapped[UUID | None] = mapped_column()
    content: Mapped[str] = mapped_column(Text)
    consent_granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consent_revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    title: Mapped[str] = mapped_column(String(80), server_default="")
    summary: Mapped[str] = mapped_column(String(240), server_default="")
    category: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), server_default="legacy_unconfirmed")
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active_consent_id: Mapped[UUID | None] = mapped_column()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    corrected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MemoryPreferences(Base):
    __tablename__ = "memory_preferences"
    __table_args__ = (
        CheckConstraint("version BETWEEN 1 AND 2147483647", name="version_valid"),
        CheckConstraint(
            "privacy_epoch >= 0 AND context_epoch_floor >= 0 "
            "AND context_epoch_floor <= privacy_epoch AND last_revision >= 0",
            name="epoch_revision_valid",
        ),
    )
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    long_term_memory_enabled: Mapped[bool] = mapped_column(Boolean, server_default=false())
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    privacy_epoch: Mapped[int] = mapped_column(BigInteger, server_default="0")
    context_epoch_floor: Mapped[int] = mapped_column(BigInteger, server_default="0")
    context_not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_revision: Mapped[int] = mapped_column(BigInteger, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class MemoryConsentEvent(Entity, Base):
    __tablename__ = "memory_consent_events"
    __table_args__ = (
        UniqueConstraint("owner_id", "revision"),
        UniqueConstraint("id", "memory_id", "owner_id", "memory_version"),
        ForeignKeyConstraint(["memory_id", "owner_id"], ["memories.id", "memories.owner_id"]),
        CheckConstraint(
            "action IN ('enabled','disabled','confirmed','corrected','revoked',"
            "'deleted','expired','source_invalidated')",
            name="action_valid",
        ),
        CheckConstraint("revision >= 1 AND privacy_epoch >= 0", name="revision_epoch_valid"),
        CheckConstraint(
            "(memory_id IS NULL AND memory_version IS NULL) OR "
            "(memory_id IS NOT NULL AND memory_version IS NOT NULL "
            "AND memory_version BETWEEN 1 AND 2147483647)",
            name="memory_identity_complete",
        ),
        CheckConstraint(
            "action NOT IN ('confirmed','corrected') OR "
            "(memory_id IS NOT NULL AND policy_version IS NOT NULL "
            "AND notice_version IS NOT NULL)",
            name="confirmation_complete",
        ),
        Index("ix_memory_consent_events_owner_revision", "owner_id", "revision"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    revision: Mapped[int] = mapped_column(BigInteger)
    action: Mapped[str] = mapped_column(String(30))
    memory_id: Mapped[UUID | None] = mapped_column()
    memory_version: Mapped[int | None] = mapped_column(Integer)
    affected_all: Mapped[bool] = mapped_column(Boolean, server_default=false())
    policy_version: Mapped[str | None] = mapped_column(String(60))
    notice_version: Mapped[str | None] = mapped_column(String(60))
    origin_client: Mapped[str] = mapped_column(String(30), server_default="web")
    # Audit correlation only: it must not extend an auth session's retention or authority.
    actor_session_id: Mapped[UUID | None] = mapped_column()
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    privacy_epoch: Mapped[int] = mapped_column(BigInteger)


class MemorySource(Entity, Base):
    __tablename__ = "memory_sources"
    __table_args__ = (
        ForeignKeyConstraint(["memory_id", "owner_id"], ["memories.id", "memories.owner_id"]),
        ForeignKeyConstraint(
            ["message_id", "session_id", "owner_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
        ),
        UniqueConstraint("memory_id", "message_id"),
        CheckConstraint(
            "(kind = 'manual' AND session_id IS NULL AND message_id IS NULL "
            "AND source_message_version IS NULL) OR "
            "(kind = 'chat_message' AND session_id IS NOT NULL AND message_id IS NOT NULL "
            "AND source_message_version IS NOT NULL AND source_message_version >= 1)",
            name="source_shape_valid",
        ),
        Index("ix_memory_sources_owner_memory", "owner_id", "memory_id"),
        Index("ix_memory_sources_owner_session", "owner_id", "session_id", "memory_id"),
        Index(
            "uq_memory_sources_manual",
            "memory_id",
            unique=True,
            postgresql_where=text("kind = 'manual'"),
            sqlite_where=text("kind = 'manual'"),
        ),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    memory_id: Mapped[UUID] = mapped_column()
    kind: Mapped[str] = mapped_column(String(20))
    session_id: Mapped[UUID | None] = mapped_column()
    message_id: Mapped[UUID | None] = mapped_column()
    source_message_version: Mapped[int | None] = mapped_column(Integer)


class MemoryGenerationRef(Base):
    __tablename__ = "memory_generation_refs"
    __table_args__ = (
        ForeignKeyConstraint(
            ["generation_id", "session_id", "owner_id"],
            ["chat_generations.id", "chat_generations.session_id", "chat_generations.owner_id"],
        ),
        ForeignKeyConstraint(["memory_id", "owner_id"], ["memories.id", "memories.owner_id"]),
        ForeignKeyConstraint(
            ["grant_event_id", "memory_id", "owner_id", "memory_version"],
            [
                "memory_consent_events.id",
                "memory_consent_events.memory_id",
                "memory_consent_events.owner_id",
                "memory_consent_events.memory_version",
            ],
        ),
        CheckConstraint(
            "memory_version BETWEEN 1 AND 2147483647 AND privacy_epoch >= 0 "
            "AND used_tokens >= 0 AND rank BETWEEN 1 AND 5",
            name="reference_bounds_valid",
        ),
        Index("ix_memory_generation_refs_owner_memory", "owner_id", "memory_id", "generation_id"),
    )
    generation_id: Mapped[UUID] = mapped_column(primary_key=True)
    memory_id: Mapped[UUID] = mapped_column(primary_key=True)
    session_id: Mapped[UUID] = mapped_column()
    owner_id: Mapped[UUID] = mapped_column()
    memory_version: Mapped[int] = mapped_column(Integer)
    grant_event_id: Mapped[UUID] = mapped_column()
    privacy_epoch: Mapped[int] = mapped_column(BigInteger)
    used_tokens: Mapped[int] = mapped_column(Integer)
    counter_version: Mapped[str] = mapped_column(String(60))
    rank: Mapped[int] = mapped_column(Integer)


class MemoryOperation(Entity, Base):
    __tablename__ = "memory_operations"
    __table_args__ = (
        UniqueConstraint("owner_id", "operation_scope", "idempotency_key"),
        ForeignKeyConstraint(
            ["target_memory_id", "owner_id"], ["memories.id", "memories.owner_id"]
        ),
        CheckConstraint("length(request_fingerprint) = 64", name="fingerprint_valid"),
        Index("ix_memory_operations_owner_target", "owner_id", "target_memory_id"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    operation_scope: Mapped[str] = mapped_column(String(80))
    idempotency_key: Mapped[str] = mapped_column(String(120))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    fingerprint_key_version: Mapped[str] = mapped_column(String(30))
    target_memory_id: Mapped[UUID | None] = mapped_column()
    result_code: Mapped[str] = mapped_column(String(60))


# Deliberately keep the P3 mapper at the V4 column projection. Nullable metadata-only
# extensions allow Alembic comparison while V4 ORM SELECT/INSERT stay compatible.
for _column in (
    Column("memory_epoch", BigInteger, nullable=True),
    Column("memory_context_not_before", DateTime(timezone=True), nullable=True),
    Column("memory_snapshot_at", DateTime(timezone=True), nullable=True),
):
    ChatGeneration.__table__.append_column(_column)
