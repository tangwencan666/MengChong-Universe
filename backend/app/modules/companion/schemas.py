from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, field_validator


def utc_rfc3339(value: datetime) -> str:
    # SQLite returns naive values for timezone-aware columns; stored values are UTC.
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


UTCDateTime = Annotated[datetime, PlainSerializer(utc_rfc3339, return_type=str, when_used="json")]
MessageStatus = Literal["queued", "streaming", "completed", "failed", "cancelled"]
GenerationState = Literal[
    "queued", "running", "cancel_requested", "completed", "failed", "cancelled"
]


def normalize_text(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Text must be a string")
    if "\x00" in value:
        raise ValueError("Text cannot contain a null character")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError("Text must contain valid Unicode scalar values")
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_default=True)


class CreateSession(Command):
    companion_id: UUID | None = None
    title: str = Field(default="新的聊天", min_length=1, max_length=120)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: object) -> str:
        return normalize_text(value)


class RenameSession(Command):
    title: str = Field(min_length=1, max_length=120)
    expected_version: int = Field(ge=1, strict=True)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: object) -> str:
        return normalize_text(value)


class SendMessage(Command):
    client_message_id: UUID
    content: str = Field(min_length=1, max_length=4000)

    @field_validator("content", mode="before")
    @classmethod
    def normalize_content(cls, value: object) -> str:
        return normalize_text(value)


class RetryGeneration(Command):
    retry_of_generation_id: UUID


class UpdatePreferences(Command):
    recent_topic_enabled: bool = Field(strict=True)
    expected_version: int = Field(ge=0, strict=True)


class DismissTopic(Command):
    summary_version: str = Field(min_length=1, max_length=200)

    @field_validator("summary_version", mode="before")
    @classmethod
    def normalize_version(cls, value: object) -> str:
        return normalize_text(value)


class View(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ChatRuntimeView(BaseModel):
    """P8 disclosure: only allowlisted public configuration, never Settings serialization."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["chat-runtime/1"] = "chat-runtime/1"
    provider: str
    model: str | None
    mode: Literal["mock", "real"]
    billing: Literal["none", "external_provider"]
    memory_injection_enabled: bool


class CompanionView(View):
    id: UUID
    name: str
    persona: str
    prompt_version: str


class GenerationError(View):
    code: str
    message: str


class GenerationView(View):
    id: UUID
    session_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    retry_of_generation_id: UUID | None
    state: GenerationState
    provider: str
    model: str | None
    prompt_version: str
    created_at: UTCDateTime
    started_at: UTCDateTime | None
    finished_at: UTCDateTime | None
    last_event_id: str
    error: GenerationError | None
    finish_reason: Literal["stop", "length"] | None = None


class SessionView(View):
    id: UUID
    companion_id: UUID
    title: str
    created_at: UTCDateTime
    updated_at: UTCDateTime
    last_message_at: UTCDateTime | None
    last_activity_at: UTCDateTime
    version: int = Field(ge=1)
    active_generation: GenerationView | None = None


class MessageView(View):
    id: UUID
    session_id: UUID
    client_message_id: UUID | None = None
    sequence: int = Field(ge=0)
    role: Literal["user", "assistant"]
    content: str
    status: MessageStatus
    provider: str | None = None
    created_at: UTCDateTime
    completed_at: UTCDateTime | None = None
    generation_id: UUID | None = None
    finish_reason: Literal["stop", "length"] | None = None


class GenerationSnapshot(View):
    generation: GenerationView
    assistant_message: MessageView
    resume_after_event_id: str


class GenerationAccepted(View):
    generation: GenerationView
    user_message: MessageView
    assistant_message: MessageView
    events_url: str
    idempotent_replay: bool


class GenerationResult(View):
    generation: GenerationView


class SessionPage(View):
    items: list[SessionView]
    next_cursor: str | None
    has_more: bool


class MessagePage(View):
    items: list[MessageView]
    next_cursor: str | None
    has_more: bool


class SessionCreated(View):
    session: SessionView
    idempotent_replay: bool


class PreferencesView(View):
    recent_topic_enabled: bool
    version: int = Field(ge=0)
    consented_at: UTCDateTime | None


class RecentConversationSummary(View):
    conversation_id: UUID
    title: str
    summary: str
    last_message_at: UTCDateTime
    follow_up_text: str
    dismissed: Literal[False] = False
    source: Literal["message-excerpt"] = "message-excerpt"
    source_message_ids: list[UUID] = Field(min_length=2, max_length=2)
    summary_version: str


class RecentTopicView(View):
    item: RecentConversationSummary | None


# Kept while the existing read router is upgraded to the paginated P3 contract.
ConversationView = SessionView
