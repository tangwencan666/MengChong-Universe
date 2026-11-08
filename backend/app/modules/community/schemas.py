from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PublicPost(BaseModel):
    """Explicit allowlist: never serialize an ORM user or owner_id publicly."""

    model_config = ConfigDict(from_attributes=True)
    id: UUID
    title: str
    body: str
    category: str
    created_at: datetime


class CreatePost(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=10000)
