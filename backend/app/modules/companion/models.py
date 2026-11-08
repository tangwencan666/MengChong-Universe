from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    JSON,
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Entity


class AICompanion(Entity, Base):
    __tablename__ = "ai_companions"
    __table_args__ = (
        UniqueConstraint("id", "owner_id"),
        Index(
            "uq_ai_companions_default_owner",
            "owner_id",
            unique=True,
            postgresql_where=text("is_default"),
            sqlite_where=text("is_default"),
        ),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    persona: Mapped[str] = mapped_column(Text)
    prompt_version: Mapped[str] = mapped_column(String(30), server_default="v1")
    is_default: Mapped[bool] = mapped_column(Boolean, server_default=false())


class ChatSession(Entity, Base):
    __tablename__ = "chat_sessions"
    __table_args__ = (
        UniqueConstraint("id", "owner_id"),
        UniqueConstraint("owner_id", "create_key"),
        ForeignKeyConstraint(
            ["companion_id", "owner_id"], ["ai_companions.id", "ai_companions.owner_id"]
        ),
        Index("ix_chat_sessions_owner_id_created_at", "owner_id", "created_at"),
        CheckConstraint("version >= 1", name="version_positive"),
        CheckConstraint("next_message_sequence >= 0", name="next_sequence_nonnegative"),
        CheckConstraint(
            "(create_key IS NULL AND create_fingerprint IS NULL) OR "
            "(create_key IS NOT NULL AND create_fingerprint IS NOT NULL)",
            name="create_identity_complete",
        ),
        Index(
            "ix_chat_sessions_owner_activity_visible",
            "owner_id",
            "last_activity_at",
            "id",
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    companion_id: Mapped[UUID] = mapped_column()
    title: Mapped[str] = mapped_column(String(120))
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    next_message_sequence: Mapped[int] = mapped_column(Integer, server_default="0")
    create_key: Mapped[str | None] = mapped_column(String(120))
    create_fingerprint: Mapped[str | None] = mapped_column(String(64))
    messages: Mapped[list["ChatMessage"]] = relationship(back_populates="session", lazy="raise")


class ChatMessage(Entity, Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        UniqueConstraint("session_id", "sequence"),
        UniqueConstraint("id", "session_id", "owner_id"),
        UniqueConstraint("owner_id", "session_id", "client_message_id"),
        ForeignKeyConstraint(
            ["session_id", "owner_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        CheckConstraint("role IN ('user','assistant','system')", name="role_valid"),
        CheckConstraint("sequence >= 0", name="sequence_nonnegative"),
        CheckConstraint(
            "(role IN ('user','system') AND status = 'completed') OR "
            "(role = 'assistant' AND status IN "
            "('queued','streaming','completed','failed','cancelled'))",
            name="role_status_valid",
        ),
        CheckConstraint(
            "client_message_id IS NULL OR role = 'user'", name="client_message_role_valid"
        ),
        Index("ix_chat_messages_owner_id_created_at", "owner_id", "created_at"),
    )
    owner_id: Mapped[UUID] = mapped_column()
    session_id: Mapped[UUID] = mapped_column()
    sequence: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    provider: Mapped[str | None] = mapped_column(String(40))
    client_message_id: Mapped[UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(20), server_default="completed")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    session: Mapped[ChatSession] = relationship(back_populates="messages", lazy="raise")


class ChatGeneration(Entity, Base):
    __tablename__ = "chat_generations"
    __table_args__ = (
        UniqueConstraint("id", "session_id", "owner_id"),
        UniqueConstraint("id", "session_id", "owner_id", "user_message_id"),
        UniqueConstraint("assistant_message_id"),
        UniqueConstraint("owner_id", "session_id", "operation", "idempotency_key"),
        ForeignKeyConstraint(
            ["session_id", "owner_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        ForeignKeyConstraint(
            ["user_message_id", "session_id", "owner_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
        ),
        ForeignKeyConstraint(
            ["assistant_message_id", "session_id", "owner_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
        ),
        ForeignKeyConstraint(
            ["retry_of_generation_id", "session_id", "owner_id", "user_message_id"],
            [
                "chat_generations.id",
                "chat_generations.session_id",
                "chat_generations.owner_id",
                "chat_generations.user_message_id",
            ],
        ),
        CheckConstraint(
            "state IN ('queued','running','cancel_requested','completed','failed','cancelled')",
            name="state_valid",
        ),
        CheckConstraint(
            "(operation = 'send' AND retry_of_generation_id IS NULL) OR "
            "(operation = 'retry' AND retry_of_generation_id IS NOT NULL)",
            name="operation_valid",
        ),
        CheckConstraint("user_message_id <> assistant_message_id", name="messages_distinct"),
        CheckConstraint("lease_version >= 0", name="lease_version_nonnegative"),
        CheckConstraint("last_event_sequence >= 0", name="event_sequence_nonnegative"),
        CheckConstraint(
            "(state IN ('completed','failed','cancelled') AND finished_at IS NOT NULL) OR "
            "(state IN ('queued','running','cancel_requested') AND finished_at IS NULL)",
            name="finished_state_valid",
        ),
        CheckConstraint(
            "(state = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL) OR "
            "(state <> 'failed' AND error_code IS NULL AND error_message IS NULL)",
            name="error_state_valid",
        ),
        Index(
            "uq_chat_generations_active_session",
            "session_id",
            unique=True,
            postgresql_where=text("state IN ('queued','running','cancel_requested')"),
            sqlite_where=text("state IN ('queued','running','cancel_requested')"),
        ),
        Index("ix_chat_generations_state_lease", "state", "lease_expires_at"),
        Index("ix_chat_generations_owner_state", "owner_id", "state"),
        Index("ix_chat_generations_owner_finished", "owner_id", "finished_at"),
    )
    owner_id: Mapped[UUID] = mapped_column()
    session_id: Mapped[UUID] = mapped_column()
    user_message_id: Mapped[UUID] = mapped_column()
    assistant_message_id: Mapped[UUID] = mapped_column()
    retry_of_generation_id: Mapped[UUID | None] = mapped_column()
    operation: Mapped[str] = mapped_column(String(10))
    idempotency_key: Mapped[str] = mapped_column(String(120))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(20), server_default="queued")
    provider: Mapped[str] = mapped_column(String(40))
    model: Mapped[str | None] = mapped_column(String(100))
    prompt_version: Mapped[str] = mapped_column(String(30))
    context_message_ids: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_version: Mapped[int] = mapped_column(Integer, server_default="0")
    last_event_sequence: Mapped[int] = mapped_column(Integer, server_default="0")
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(String(240))
    usage: Mapped[dict[str, Any] | None] = mapped_column(JSON(none_as_null=True))


class ChatGenerationEvent(Entity, Base):
    __tablename__ = "chat_generation_events"
    __table_args__ = (
        UniqueConstraint("generation_id", "event_sequence"),
        ForeignKeyConstraint(
            ["generation_id", "session_id", "owner_id"],
            ["chat_generations.id", "chat_generations.session_id", "chat_generations.owner_id"],
        ),
        CheckConstraint("event_sequence >= 1", name="event_sequence_positive"),
        CheckConstraint(
            "event_type IN ('start','delta','completed','error','cancelled')",
            name="event_type_valid",
        ),
        CheckConstraint(
            "(event_type = 'start' AND event_sequence = 1) OR "
            "(event_type <> 'start' AND event_sequence > 1)",
            name="start_sequence_valid",
        ),
        Index(
            "uq_chat_generation_events_terminal",
            "generation_id",
            unique=True,
            postgresql_where=text("event_type IN ('completed','error','cancelled')"),
            sqlite_where=text("event_type IN ('completed','error','cancelled')"),
        ),
        Index("ix_chat_generation_events_occurred_at", "occurred_at"),
        Index(
            "ix_chat_generation_events_owner_replay", "owner_id", "generation_id", "event_sequence"
        ),
    )
    owner_id: Mapped[UUID] = mapped_column()
    session_id: Mapped[UUID] = mapped_column()
    generation_id: Mapped[UUID] = mapped_column()
    event_sequence: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ChatPreferences(Base):
    __tablename__ = "chat_preferences"
    __table_args__ = (
        ForeignKeyConstraint(
            ["dismissed_session_id", "user_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        ForeignKeyConstraint(
            ["source_message_id", "dismissed_session_id", "user_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
        ),
        CheckConstraint("version >= 1", name="version_positive"),
        CheckConstraint(
            "(dismissed_session_id IS NULL AND source_message_id IS NULL "
            "AND summary_version IS NULL) OR (dismissed_session_id IS NOT NULL "
            "AND source_message_id IS NOT NULL AND summary_version IS NOT NULL)",
            name="dismissal_complete",
        ),
    )
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    recent_topic_enabled: Mapped[bool] = mapped_column(Boolean, server_default=false())
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    consented_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_session_id: Mapped[UUID | None] = mapped_column()
    source_message_id: Mapped[UUID | None] = mapped_column()
    summary_version: Mapped[str | None] = mapped_column(String(200))
