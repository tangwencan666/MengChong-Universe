from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from app.core.errors import AppError
from app.core.security import Authenticated, get_principal
from app.modules.auth.store import rate_limit
from app.modules.memory.schemas import (
    Category,
    ClearMemories,
    ExportRequest,
    MemoryConfirm,
    MemoryCreate,
    MemoryEdit,
    PreferencesChange,
    ResourceVersion,
    RetrievalPreview,
)
from app.modules.pets.memory_previews import PreviewRequest
from app.modules.pets.memory_service import PetMemoryService


class MemoryRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def bounded(request):
            if request.method in {"POST", "PATCH", "DELETE"}:
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 32768:
                        raise AppError(422, "VALIDATION_ERROR", "请求内容超过大小限制。")
                    chunks.append(chunk)
                request._body = b"".join(chunks)
            response = await original(request)
            response.headers["Cache-Control"] = "no-store"
            return response

        return bounded


async def limit_memory(request: Request, principal: Authenticated, pet_id: UUID):
    purpose, maximum = "request", 120
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        if request.url.path.endswith("/export"):
            purpose, maximum = "export", 2
        elif request.url.path.endswith("/previews"):
            purpose, maximum = "preview", 10
        elif request.url.path.endswith("/retrieval-preview"):
            purpose, maximum = "retrieval", 10
    try:
        await rate_limit(
            request,
            "pet-memory-" + purpose,
            maximum,
            str(principal.user_id) + ":" + str(pet_id),
            seconds=60,
        )
    except AppError as exc:
        if exc.status == 429:
            exc.headers = {"Retry-After": "60"}
        raise


router = APIRouter(
    prefix="/{pet_id}/memory",
    tags=["pet-memory"],
    route_class=MemoryRoute,
    dependencies=[Depends(get_principal), Depends(limit_memory)],
)


@router.get("/preferences")
async def preferences(request: Request, principal: Authenticated, pet_id: UUID):
    return await PetMemoryService(request, principal, pet_id).preferences()


@router.patch("/preferences")
async def update_preferences(
    payload: PreferencesChange,
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await PetMemoryService(request, principal, pet_id).update_preferences(payload, key)


@router.post("/items", status_code=201)
async def create(
    payload: MemoryCreate,
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await PetMemoryService(request, principal, pet_id).create(payload, key)


@router.get("/items")
async def listing(
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, max_length=1024),
    status: Literal["active", "revoked", "expired", "legacy_unconfirmed"] | None = None,
    category: Category | None = None,
    snapshot_revision: str | None = Query(None, pattern=r"^(0|[1-9][0-9]{0,18})$"),
):
    return await PetMemoryService(request, principal, pet_id).listing(
        limit, cursor, status, category, snapshot_revision
    )


@router.get("/items/{memory_id}")
async def detail(memory_id: UUID, request: Request, principal: Authenticated, pet_id: UUID):
    return await PetMemoryService(request, principal, pet_id).detail(memory_id)


@router.patch("/items/{memory_id}")
async def edit(
    memory_id: UUID,
    payload: MemoryEdit,
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await PetMemoryService(request, principal, pet_id).edit(memory_id, payload, key)


@router.post("/items/{memory_id}/confirm")
async def confirm(
    memory_id: UUID,
    payload: MemoryConfirm,
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await PetMemoryService(request, principal, pet_id).edit(
        memory_id, payload, key, reconfirm=True
    )


@router.post("/items/{memory_id}/revocations")
async def revoke(
    memory_id: UUID,
    payload: ResourceVersion,
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await PetMemoryService(request, principal, pet_id).remove(memory_id, payload, key)


@router.delete("/items/{memory_id}", status_code=204)
async def delete(
    memory_id: UUID,
    payload: ResourceVersion,
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    await PetMemoryService(request, principal, pet_id).remove(memory_id, payload, key, erase=True)
    return Response(status_code=204)


@router.get("/items/{memory_id}/sources")
async def sources(memory_id: UUID, request: Request, principal: Authenticated, pet_id: UUID):
    return await PetMemoryService(request, principal, pet_id).sources(memory_id)


@router.post("/clear", status_code=204)
async def clear(
    payload: ClearMemories,
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    await PetMemoryService(request, principal, pet_id).clear(payload, key)
    return Response(status_code=204)


@router.get("/changes")
async def changes(
    request: Request,
    principal: Authenticated,
    pet_id: UUID,
    limit: int = Query(100, ge=1, le=200),
    cursor: str | None = Query(None, max_length=1024),
):
    return await PetMemoryService(request, principal, pet_id).changes(limit, cursor)


@router.post("/export")
async def export(payload: ExportRequest, request: Request, principal: Authenticated, pet_id: UUID):
    data = await PetMemoryService(request, principal, pet_id).export(payload)
    return JSONResponse(
        data,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'attachment; filename="weibiye-memories.json"',
        },
    )


@router.post("/previews")
async def preview(
    payload: PreviewRequest, request: Request, principal: Authenticated, pet_id: UUID
):
    return await PetMemoryService(request, principal, pet_id).preview(payload)


@router.post("/retrieval-preview")
async def retrieval_preview(
    payload: RetrievalPreview, request: Request, principal: Authenticated, pet_id: UUID
):
    return await PetMemoryService(request, principal, pet_id).retrieval_preview(payload)
