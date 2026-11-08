from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

Category = Literal[
    "career_goal", "communication_preference", "experience", "open_topic", "explicit_note"
]
Version = Annotated[StrictInt, Field(ge=0, le=2147483647)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("confirmed", mode="before", check_fields=False)
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("Confirmation must be the JSON boolean true")
        return value


class Consent(Input):
    confirmed: Literal[True]
    policy_version: Literal["memory-policy/1"]
    notice_version: Literal["memory-notice/1"]


class PreferencesChange(Input):
    long_term_memory_enabled: bool = Field(strict=True)
    expected_version: Version
    consent: Consent | None = None


class Source(Input):
    kind: Literal["manual", "chat_message"]
    session_id: UUID | None = None
    message_ids: list[UUID] | None = Field(None, min_length=1, max_length=5)
    preview_token: str | None = Field(None, max_length=2048)

    @model_validator(mode="after")
    def shape(self):
        if self.kind == "manual" and any(
            item is not None for item in (self.session_id, self.message_ids, self.preview_token)
        ):
            raise ValueError("Manual sources cannot specify chat identifiers")
        return self


class MemoryContent(Input):
    title: str = Field(min_length=1, max_length=80, strict=True)
    content: str = Field(min_length=1, max_length=1000, strict=True)
    category: Category
    expires_at: datetime | None = None
    expected_preferences_version: Version
    consent: Consent

    @field_validator("title", "content", mode="before")
    @classmethod
    def normalize(cls, value):
        if not isinstance(value, str):
            raise ValueError("Text is required")
        return value.replace("\r\n", "\n").replace("\r", "\n").strip()


class MemoryCreate(MemoryContent):
    source: Source


class MemoryEdit(MemoryContent):
    expected_version: Version


class MemoryConfirm(MemoryEdit):
    source: Source | None = None


class RetrievalPreview(Input):
    query: str = Field(min_length=1, max_length=1000, strict=True)
    limit: int = Field(default=5, ge=1, le=5, strict=True)
    expected_preferences_version: Version

    @field_validator("query", mode="before")
    @classmethod
    def normalize_query(cls, value):
        if not isinstance(value, str):
            raise ValueError("Text is required")
        return value.replace("\r\n", "\n").replace("\r", "\n").strip()


class ResourceVersion(Input):
    expected_version: Version


class ClearMemories(Input):
    confirmed: Literal[True]
    expected_revision: str = Field(pattern=r"^(0|[1-9][0-9]{0,18})$")


class ExportRequest(Input):
    format: Literal["json"] = "json"
    include_inactive: bool = Field(default=True, strict=True)
