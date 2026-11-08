"""Bounded consumer-facing configuration, never executable desktop instructions."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)

Version = Annotated[StrictInt, Field(ge=1, le=2147483647)]
PetStatus = Literal["active", "hidden", "archived"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class PersonaConfig(Input):
    description: str = Field(default="", max_length=600)
    tone: Literal["warm", "playful", "calm"] = "warm"


class AppearanceConfig(Input):
    asset_id: str = Field(default="pet-default", pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    tint: str = Field(default="#7E9F84", pattern=r"^#[0-9A-Fa-f]{6}$")
    scale: float = Field(default=1.0, ge=0.5, le=2.0, allow_inf_nan=False, strict=True)


class PetCreate(Input):
    name: str = Field(min_length=1, max_length=60)
    role_type: Literal["cat", "dog", "custom"] = "custom"
    persona_config: PersonaConfig = Field(default_factory=PersonaConfig)
    appearance_config: AppearanceConfig = Field(default_factory=AppearanceConfig)

    @field_validator("name")
    @classmethod
    def plain_name(cls, value):
        if any(ord(character) < 32 for character in value):
            raise ValueError("名称不能包含控制字符。")
        return value


class PetUpdate(Input):
    expected_version: Version
    name: str | None = Field(default=None, min_length=1, max_length=60)
    role_type: Literal["cat", "dog", "custom"] | None = None
    persona_config: PersonaConfig | None = None
    appearance_config: AppearanceConfig | None = None

    @model_validator(mode="after")
    def meaningful_edit(self):
        fields = self.model_fields_set - {"expected_version"}
        if not fields or any(getattr(self, field) is None for field in fields):
            raise ValueError("请选择需要修改的配置。")
        if self.name is not None:
            PetCreate.plain_name(self.name)
        return self


class PetVisibility(Input):
    hidden: StrictBool
    expected_version: Version


class PetArchive(Input):
    expected_version: Version


class PetView(BaseModel):
    pet_id: UUID
    name: str
    role_type: str
    persona_config: PersonaConfig
    appearance_config: AppearanceConfig
    status: PetStatus
    version: int
    created_at: datetime
    updated_at: datetime


class PetPage(BaseModel):
    items: list[PetView]
    next_cursor: str | None
    has_more: bool
