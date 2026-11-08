from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import select

from app.core.errors import AppError
from app.core.security import Authenticated, get_principal
from app.db.capabilities import SchemaUnavailable, read_revision
from app.modules.auth.store import rate_limit
from app.modules.memory.models import Memory
from app.modules.memory.previews import PreviewRequest
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
from app.modules.memory.service import MemoryService, now, stamp


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


async def limit_memory(request: Request, principal: Authenticated):
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
            request, "p4-memory-" + purpose, maximum, str(principal.user_id), seconds=60
        )
    except AppError as exc:
        if exc.status == 429:
            exc.headers = {"Retry-After": "60"}
        raise


router = APIRouter(
    prefix="/memory",
    tags=["memory"],
    route_class=MemoryRoute,
    dependencies=[Depends(get_principal), Depends(limit_memory)],
)


@router.get("/preferences")
async def preferences(request: Request, principal: Authenticated):
    return await MemoryService(request, principal).preferences()


@router.patch("/preferences")
async def update_preferences(
    payload: PreferencesChange,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await MemoryService(request, principal).update_preferences(payload, key)


@router.post("/items", status_code=201)
async def create(
    payload: MemoryCreate,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await MemoryService(request, principal).create(payload, key)


@router.get("/items")
async def listing(
    request: Request,
    principal: Authenticated,
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, max_length=1024),
    status: Literal["active", "revoked", "expired", "legacy_unconfirmed"] | None = None,
    category: Category | None = None,
    snapshot_revision: str | None = Query(None, pattern=r"^(0|[1-9][0-9]{0,18})$"),
):
    return await MemoryService(request, principal).listing(
        limit, cursor, status, category, snapshot_revision
    )


@router.get("/items/{memory_id}")
async def detail(memory_id: UUID, request: Request, principal: Authenticated):
    return await MemoryService(request, principal).detail(memory_id)


@router.patch("/items/{memory_id}")
async def edit(
    memory_id: UUID,
    payload: MemoryEdit,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await MemoryService(request, principal).edit(memory_id, payload, key)


@router.post("/items/{memory_id}/confirm")
async def confirm(
    memory_id: UUID,
    payload: MemoryConfirm,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await MemoryService(request, principal).edit(memory_id, payload, key, reconfirm=True)


@router.post("/items/{memory_id}/revocations")
async def revoke(
    memory_id: UUID,
    payload: ResourceVersion,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    return await MemoryService(request, principal).remove(memory_id, payload, key)


@router.delete("/items/{memory_id}", status_code=204)
async def delete(
    memory_id: UUID,
    payload: ResourceVersion,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    await MemoryService(request, principal).remove(memory_id, payload, key, erase=True)
    return Response(status_code=204)


@router.get("/items/{memory_id}/sources")
async def sources(memory_id: UUID, request: Request, principal: Authenticated):
    return await MemoryService(request, principal).sources(memory_id)


@router.post("/clear", status_code=204)
async def clear(
    payload: ClearMemories,
    request: Request,
    principal: Authenticated,
    key: str | None = Header(None, alias="Idempotency-Key"),
):
    await MemoryService(request, principal).clear(payload, key)
    return Response(status_code=204)


@router.get("/changes")
async def changes(
    request: Request,
    principal: Authenticated,
    limit: int = Query(100, ge=1, le=200),
    cursor: str | None = Query(None, max_length=1024),
):
    return await MemoryService(request, principal).changes(limit, cursor)


@router.post("/export")
async def export(payload: ExportRequest, request: Request, principal: Authenticated):
    data = await MemoryService(request, principal).export(payload)
    return JSONResponse(
        data,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'attachment; filename="weibiye-memories.json"',
        },
    )


@router.post("/previews")
async def preview(payload: PreviewRequest, request: Request, principal: Authenticated):
    return await MemoryService(request, principal).preview(payload)


@router.post("/retrieval-preview")
async def retrieval_preview(payload: RetrievalPreview, request: Request, principal: Authenticated):
    return await MemoryService(request, principal).retrieval_preview(payload)


async def legacy_read(request, principal, memory_id=None, limit=50):
    # Never query V5 columns in V4, nor fall back to timestamp-only consent.
    if not request.app.state.settings.memory_management_enabled:
        if memory_id:
            raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
        return []
    async with request.app.state.session_factory() as db:
        try:
            revision = await read_revision(db)
        except SchemaUnavailable:
            raise AppError(503, "MEMORY_STORAGE_UNAVAILABLE", "记忆存储暂不可用。") from None
    if revision == "0004":
        if memory_id:
            raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
        return []
    service = MemoryService(request, principal)
    async with service.transaction() as db:
        pref = await service.preference(db)
        if not pref or not pref.long_term_memory_enabled:
            if memory_id:
                raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
            return []
        query = select(Memory).where(
            Memory.owner_id == principal.user_id,
            Memory.status == "active",
            Memory.consent_revoked_at.is_(None),
            Memory.deleted_at.is_(None),
            Memory.expires_at > now(),
            Memory.active_consent_id.is_not(None),
        )
        from app.modules.memory.policy import eligible_candidates

        eligible_ids = [item.id for item in await eligible_candidates(db, principal.user_id)]
        query = query.where(Memory.id.in_(eligible_ids))
        if memory_id:
            query = query.where(Memory.id == memory_id)
        rows = (await db.scalars(query.order_by(Memory.created_at.desc()).limit(limit))).all()
        views = [
            {
                "id": str(row.id),
                "content": row.content,
                "source_session_id": str(row.source_session_id) if row.source_session_id else None,
                "consent_granted_at": stamp(row.consent_granted_at),
            }
            for row in rows
        ]
        if memory_id:
            if not views:
                raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
            return views[0]
        return views


@router.get("")
async def legacy_listing(
    request: Request, principal: Authenticated, limit: int = Query(50, ge=1, le=100)
):
    return await legacy_read(request, principal, limit=limit)


@router.get("/{memory_id}")
async def legacy_detail(memory_id: UUID, request: Request, principal: Authenticated):
    return await legacy_read(request, principal, memory_id=memory_id)
