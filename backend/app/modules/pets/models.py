"""Additive, owner-and-pet constrained storage; no legacy rows are reassigned."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
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


class Pet(Entity, Base):
    __tablename__ = "pets"
    __table_args__ = (
        UniqueConstraint("id", "owner_id"),
        UniqueConstraint("owner_id", "create_key"),
        UniqueConstraint("companion_id"),
        ForeignKeyConstraint(
            ["companion_id", "owner_id"], ["ai_companions.id", "ai_companions.owner_id"]
        ),
        CheckConstraint("status IN ('active','hidden','archived')", name="status_valid"),
        CheckConstraint("version BETWEEN 1 AND 2147483647", name="version_valid"),
        CheckConstraint("length(name) BETWEEN 1 AND 60", name="name_bounded"),
        CheckConstraint("length(role_type) BETWEEN 1 AND 40", name="role_bounded"),
        CheckConstraint("length(create_fingerprint) = 64", name="fingerprint_valid"),
        Index("ix_pets_owner_status_created", "owner_id", "status", "created_at", "id"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    companion_id: Mapped[UUID] = mapped_column()
    name: Mapped[str] = mapped_column(String(60))
    role_type: Mapped[str] = mapped_column(String(40))
    persona_config: Mapped[dict] = mapped_column(JSON)
    appearance_config: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), server_default="active")
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    create_key: Mapped[str] = mapped_column(String(120))
    create_fingerprint: Mapped[str] = mapped_column(String(64))


class PetChatBinding(Base):
    __tablename__ = "pet_chat_bindings"
    __table_args__ = (
        ForeignKeyConstraint(
            ["session_id", "owner_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        ForeignKeyConstraint(["pet_id", "owner_id"], ["pets.id", "pets.owner_id"]),
        UniqueConstraint("session_id", "owner_id", "pet_id"),
        Index("ix_pet_chat_bindings_owner_pet", "owner_id", "pet_id", "session_id"),
    )
    session_id: Mapped[UUID] = mapped_column(primary_key=True)
    owner_id: Mapped[UUID] = mapped_column()
    pet_id: Mapped[UUID] = mapped_column()


class PetGenerationContext(Base):
    __tablename__ = "pet_generation_contexts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["generation_id", "session_id", "owner_id"],
            ["chat_generations.id", "chat_generations.session_id", "chat_generations.owner_id"],
        ),
        ForeignKeyConstraint(
            ["session_id", "owner_id", "pet_id"],
            [
                "pet_chat_bindings.session_id",
                "pet_chat_bindings.owner_id",
                "pet_chat_bindings.pet_id",
            ],
        ),
        CheckConstraint("persona_version >= 1 AND memory_epoch >= 0", name="versions_valid"),
        Index("ix_pet_generation_contexts_owner_pet", "owner_id", "pet_id", "generation_id"),
    )
    generation_id: Mapped[UUID] = mapped_column(primary_key=True)
    owner_id: Mapped[UUID] = mapped_column()
    pet_id: Mapped[UUID] = mapped_column()
    session_id: Mapped[UUID] = mapped_column()
    persona_version: Mapped[int] = mapped_column(Integer)
    persona_snapshot: Mapped[dict] = mapped_column(JSON)
    memory_epoch: Mapped[int] = mapped_column(BigInteger, server_default="0")
    context_not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    memory_refs: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")


class PetMemoryPreferences(Base):
    __tablename__ = "pet_memory_preferences"
    __table_args__ = (
        ForeignKeyConstraint(["pet_id", "owner_id"], ["pets.id", "pets.owner_id"]),
        CheckConstraint("version BETWEEN 1 AND 2147483647", name="version_valid"),
        CheckConstraint(
            "privacy_epoch >= 0 AND context_epoch_floor >= 0 "
            "AND context_epoch_floor <= privacy_epoch AND last_revision >= 0",
            name="epoch_revision_valid",
        ),
    )
    pet_id: Mapped[UUID] = mapped_column(primary_key=True)
    owner_id: Mapped[UUID] = mapped_column()
    long_term_memory_enabled: Mapped[bool] = mapped_column(Boolean, server_default=false())
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    privacy_epoch: Mapped[int] = mapped_column(BigInteger, server_default="0")
    context_epoch_floor: Mapped[int] = mapped_column(BigInteger, server_default="0")
    context_not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_revision: Mapped[int] = mapped_column(BigInteger, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PetMemory(Entity, Base):
    __tablename__ = "pet_memories"
    __table_args__ = (
        ForeignKeyConstraint(["pet_id", "owner_id"], ["pets.id", "pets.owner_id"]),
        UniqueConstraint("id", "owner_id", "pet_id"),
        UniqueConstraint("id", "owner_id", "pet_id", "version"),
        ForeignKeyConstraint(
            ["active_consent_id", "id", "owner_id", "pet_id", "version"],
            [
                "pet_memory_consents.id",
                "pet_memory_consents.memory_id",
                "pet_memory_consents.owner_id",
                "pet_memory_consents.pet_id",
                "pet_memory_consents.memory_version",
            ],
            use_alter=True,
        ),
        CheckConstraint(
            "consent_granted_at IS NOT NULL AND "
            "(consent_revoked_at IS NULL OR consent_revoked_at >= consent_granted_at)",
            name="consent_valid",
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
        Index(
            "ix_pet_memories_owner_pet_status", "owner_id", "pet_id", "status", "expires_at", "id"
        ),
        Index("ix_pet_memories_owner_pet_updated", "owner_id", "pet_id", "updated_at", "id"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    pet_id: Mapped[UUID] = mapped_column()
    title: Mapped[str] = mapped_column(String(80), server_default="")
    content: Mapped[str] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(String(240), server_default="")
    category: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), server_default="legacy_unconfirmed")
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consent_granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consent_revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active_consent_id: Mapped[UUID | None] = mapped_column()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    corrected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PetMemoryConsent(Entity, Base):
    __tablename__ = "pet_memory_consents"
    __table_args__ = (
        ForeignKeyConstraint(["pet_id", "owner_id"], ["pets.id", "pets.owner_id"]),
        ForeignKeyConstraint(
            ["memory_id", "owner_id", "pet_id"],
            ["pet_memories.id", "pet_memories.owner_id", "pet_memories.pet_id"],
        ),
        UniqueConstraint("owner_id", "pet_id", "revision"),
        UniqueConstraint("id", "memory_id", "owner_id", "pet_id", "memory_version"),
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
            "(memory_id IS NOT NULL AND policy_version IS NOT NULL AND notice_version IS NOT NULL)",
            name="confirmation_complete",
        ),
        Index("ix_pet_memory_consents_owner_pet_revision", "owner_id", "pet_id", "revision"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    pet_id: Mapped[UUID] = mapped_column()
    revision: Mapped[int] = mapped_column(BigInteger)
    action: Mapped[str] = mapped_column(String(30))
    memory_id: Mapped[UUID | None] = mapped_column()
    memory_version: Mapped[int | None] = mapped_column(Integer)
    affected_all: Mapped[bool] = mapped_column(Boolean, server_default=false())
    policy_version: Mapped[str | None] = mapped_column(String(60))
    notice_version: Mapped[str | None] = mapped_column(String(60))
    actor_session_id: Mapped[UUID | None] = mapped_column()
    origin_client: Mapped[str] = mapped_column(String(30), server_default="web")
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    privacy_epoch: Mapped[int] = mapped_column(BigInteger)


class PetMemorySource(Entity, Base):
    __tablename__ = "pet_memory_sources"
    __table_args__ = (
        ForeignKeyConstraint(
            ["memory_id", "owner_id", "pet_id"],
            ["pet_memories.id", "pet_memories.owner_id", "pet_memories.pet_id"],
        ),
        ForeignKeyConstraint(
            ["session_id", "owner_id", "pet_id"],
            [
                "pet_chat_bindings.session_id",
                "pet_chat_bindings.owner_id",
                "pet_chat_bindings.pet_id",
            ],
        ),
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
        Index("ix_pet_memory_sources_owner_pet_memory", "owner_id", "pet_id", "memory_id"),
        Index("ix_pet_memory_sources_owner_pet_session", "owner_id", "pet_id", "session_id"),
        Index(
            "uq_pet_memory_sources_manual",
            "memory_id",
            unique=True,
            postgresql_where=text("kind = 'manual'"),
            sqlite_where=text("kind = 'manual'"),
        ),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    pet_id: Mapped[UUID] = mapped_column()
    memory_id: Mapped[UUID] = mapped_column()
    kind: Mapped[str] = mapped_column(String(20))
    session_id: Mapped[UUID | None] = mapped_column()
    message_id: Mapped[UUID | None] = mapped_column()
    source_message_version: Mapped[int | None] = mapped_column(Integer)


class PetMemoryOperation(Entity, Base):
    __tablename__ = "pet_memory_operations"
    __table_args__ = (
        ForeignKeyConstraint(["pet_id", "owner_id"], ["pets.id", "pets.owner_id"]),
        ForeignKeyConstraint(
            ["target_memory_id", "owner_id", "pet_id"],
            ["pet_memories.id", "pet_memories.owner_id", "pet_memories.pet_id"],
        ),
        UniqueConstraint("owner_id", "pet_id", "operation_scope", "idempotency_key"),
        CheckConstraint("length(request_fingerprint) = 64", name="fingerprint_valid"),
        Index(
            "ix_pet_memory_operations_owner_pet_target", "owner_id", "pet_id", "target_memory_id"
        ),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    pet_id: Mapped[UUID] = mapped_column()
    operation_scope: Mapped[str] = mapped_column(String(80))
    idempotency_key: Mapped[str] = mapped_column(String(120))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    fingerprint_key_version: Mapped[str] = mapped_column(String(30))
    target_memory_id: Mapped[UUID | None] = mapped_column()
    result_code: Mapped[str | None] = mapped_column(String(60))
