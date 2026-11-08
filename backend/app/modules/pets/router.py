"""Authenticated pet APIs share the existing origin, Cookie and CSRF middleware."""

from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request

from app.core.security import Authenticated, get_principal
from app.modules.auth.store import rate_limit
from app.modules.companion.router import command
from app.modules.memory.router import MemoryRoute
from app.modules.pets.schemas import PetArchive, PetCreate, PetStatus, PetUpdate, PetVisibility
from app.modules.pets.service import PetService


async def read_limit(request: Request, principal: Authenticated):
    if request.method in {"GET", "HEAD"}:
        await rate_limit(request, "pet-read", 120, str(principal.user_id), seconds=60)


router = APIRouter(
    prefix="/pets",
    tags=["pets"],
    route_class=MemoryRoute,
    dependencies=[Depends(get_principal), Depends(read_limit)],
)


@router.post("", status_code=201, dependencies=[Depends(command)])
async def create(
    payload: PetCreate,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await PetService(request, principal).create(payload, key)


@router.get("")
async def listing(
    request: Request,
    principal: Authenticated,
    status: PetStatus = "active",
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, max_length=1024),
):
    return await PetService(request, principal).listing(status, limit, cursor)


@router.get("/{pet_id}")
async def detail(pet_id: UUID, request: Request, principal: Authenticated):
    return await PetService(request, principal).detail(pet_id)


@router.patch("/{pet_id}", dependencies=[Depends(command)])
async def update(pet_id: UUID, payload: PetUpdate, request: Request, principal: Authenticated):
    return await PetService(request, principal).update(pet_id, payload)


@router.post("/{pet_id}/visibility", dependencies=[Depends(command)])
async def visibility(
    pet_id: UUID, payload: PetVisibility, request: Request, principal: Authenticated
):
    return await PetService(request, principal).visibility(pet_id, payload)


@router.post("/{pet_id}/archive", dependencies=[Depends(command)])
async def archive(pet_id: UUID, payload: PetArchive, request: Request, principal: Authenticated):
    return await PetService(request, principal).archive(pet_id, payload)


# Child routers retain their scoped pet_id parameter and authenticated parent.
from app.modules.pets.chat_router import chat_router  # noqa: E402
from app.modules.pets.memory_router import router as memory_router  # noqa: E402

router.include_router(chat_router)
router.include_router(memory_router)
