"""Additive adoption/instance API. No schema migration or alternate authorization."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import Field, field_validator

from app.core.errors import AppError
from app.core.security import Authenticated, get_principal
from app.modules.companion.router import command
from app.modules.memory.router import MemoryRoute
from app.modules.pet_instances.catalog import (
    DEFAULT_APPEARANCE,
    SPECIES,
    TEMPLATES,
    configuration,
    instance,
)
from app.modules.pets.router import read_limit
from app.modules.pets.schemas import (
    Input,
    PersonaConfig,
    PetArchive,
    PetCreate,
    PetStatus,
    PetUpdate,
    Version,
)
from app.modules.pets.service import PetService


class Adoption(Input):
    species_id: Literal["moon", "doubao", "xiaoyun", "maodie", "hajimi", "niwa", "daodun", "whale"]
    appearance_id: str | None = Field(
        default=None, max_length=64, pattern=r"^[a-z][a-z0-9-]{0,63}$"
    )
    name: str | None = Field(default=None, min_length=1, max_length=60)
    persona_config: PersonaConfig | None = None

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        return PetCreate.plain_name(value) if value is not None else None


class InstanceEdit(Input):
    expected_version: Version
    name: str = Field(min_length=1, max_length=60)
    persona_config: PersonaConfig

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        return PetCreate.plain_name(value)


class Removal(Input):
    expected_version: Version
    confirmation_instance_id: UUID
    data_handling: Literal["archive_keep_data"]


router = APIRouter(
    prefix="/pet-instances",
    tags=["pet-instances"],
    route_class=MemoryRoute,
    dependencies=[Depends(get_principal), Depends(read_limit)],
)


@router.get("/species")
async def catalog():
    return {
        "items": [
            {
                "species_id": identifier,
                **configuration(identifier).model_dump(mode="json"),
                "greeting": TEMPLATES[identifier]["greeting"],
                "appearance_id": DEFAULT_APPEARANCE[identifier]["appearance_id"],
                "appearance_restriction": DEFAULT_APPEARANCE[identifier]["restriction"],
            }
            for identifier in SPECIES
        ]
    }


@router.post("", status_code=201, dependencies=[Depends(command)])
async def adopt(
    payload: Adoption,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    value = await PetService(request, principal).create(
        configuration(
            payload.species_id, payload.name, payload.persona_config, payload.appearance_id
        ),
        key,
    )
    return instance(value, principal.user_id)


@router.get("")
async def listing(
    request: Request,
    principal: Authenticated,
    status: PetStatus = "active",
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, max_length=1024),
):
    page = await PetService(request, principal).listing(status, limit, cursor)
    return {
        **page.model_dump(mode="json"),
        "items": [instance(value, principal.user_id) for value in page.items],
    }


@router.get("/{pet_instance_id}")
async def detail(pet_instance_id: UUID, request: Request, principal: Authenticated):
    return instance(await PetService(request, principal).detail(pet_instance_id), principal.user_id)


@router.patch("/{pet_instance_id}", dependencies=[Depends(command)])
async def edit(
    pet_instance_id: UUID, payload: InstanceEdit, request: Request, principal: Authenticated
):
    value = await PetService(request, principal).update(
        pet_instance_id, PetUpdate(**payload.model_dump(mode="json"))
    )
    return instance(value, principal.user_id)


@router.delete("/{pet_instance_id}", dependencies=[Depends(command)])
async def remove(
    pet_instance_id: UUID, payload: Removal, request: Request, principal: Authenticated
):
    if payload.confirmation_instance_id != pet_instance_id:
        raise AppError(422, "INSTANCE_CONFIRMATION_REQUIRED", "请重新确认要删除的宠物实例。")
    value = await PetService(request, principal).archive(
        pet_instance_id, PetArchive(expected_version=payload.expected_version)
    )
    return {
        "instance": instance(value, principal.user_id),
        "lifecycle": {
            "instance": "archived",
            "chat": "retained_read_only",
            "memory": "retained_manageable",
            "can_undo_archive": False,
        },
    }
