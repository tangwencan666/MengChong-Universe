"""Pet-addressed REST/SSE endpoints backed by the existing P3 chat service."""

from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import Field, field_validator

from app.agent.provider_selection import select_chat_provider
from app.core.security import Authenticated
from app.modules.companion.events import prepare_events
from app.modules.companion.router import ChatRoute, EmptyCommand, command
from app.modules.companion.schemas import (
    ChatRuntimeView,
    Command,
    CreateSession,
    RenameSession,
    RetryGeneration,
    SendMessage,
    normalize_text,
)
from app.modules.companion.service import ChatService, idempotency_key
from app.modules.pets.chat import scoped_result
from app.modules.pets.service import PetService


class PetCreateSession(Command):
    title: str = Field(default="新的聊天", min_length=1, max_length=120)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value):
        return normalize_text(value)


chat_router = APIRouter(prefix="/{pet_id}", tags=["pet-chat"], route_class=ChatRoute)


def result(value, pet_id):
    return scoped_result(value, pet_id)


@chat_router.get("/runtime", response_model=ChatRuntimeView)
async def runtime(pet_id: UUID, request: Request, principal: Authenticated):
    # Check owner and schema first, including foreign/unknown pet IDs. This
    # endpoint must not disclose another user's targeted provider configuration.
    await PetService(request, principal).detail(pet_id)
    selection = select_chat_provider(request.app.state.settings, principal.user_id, pet_id)
    mock = selection.provider == "mock"
    return ChatRuntimeView(
        provider=selection.provider,
        model=selection.model,
        mode="mock" if mock else "real",
        billing="none" if mock else "external_provider",
        memory_injection_enabled=selection.memory_injection_enabled,
    )


@chat_router.post("/sessions", status_code=201, dependencies=[Depends(command)])
async def create_session(
    pet_id: UUID,
    payload: PetCreateSession,
    request: Request,
    response: Response,
    principal: Authenticated,
    key: str = Header(alias="Idempotency-Key"),
):
    created = await ChatService(request, principal, pet_id).create_session(
        CreateSession(title=payload.title), idempotency_key(key)
    )
    response.headers["Location"] = f"/api/v1/pets/{pet_id}/sessions/{created.session.id}"
    return result(created, pet_id)


@chat_router.get("/sessions")
async def list_sessions(
    pet_id: UUID,
    request: Request,
    principal: Authenticated,
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = None,
):
    return result(
        await ChatService(request, principal, pet_id).list_sessions(limit, cursor), pet_id
    )


@chat_router.get("/sessions/{session_id}")
async def detail(pet_id: UUID, session_id: UUID, request: Request, principal: Authenticated):
    return result(await ChatService(request, principal, pet_id).detail(session_id), pet_id)


@chat_router.patch("/sessions/{session_id}", dependencies=[Depends(command)])
async def rename(
    pet_id: UUID,
    session_id: UUID,
    payload: RenameSession,
    request: Request,
    principal: Authenticated,
):
    return result(await ChatService(request, principal, pet_id).rename(session_id, payload), pet_id)


@chat_router.delete("/sessions/{session_id}", status_code=204, dependencies=[Depends(command)])
async def delete(pet_id: UUID, session_id: UUID, request: Request, principal: Authenticated):
    await ChatService(request, principal, pet_id).delete(session_id)
    return Response(status_code=204)


@chat_router.get("/sessions/{session_id}/messages")
async def messages(
    pet_id: UUID,
    session_id: UUID,
    request: Request,
    principal: Authenticated,
    limit: int = Query(50, ge=1, le=100),
    cursor: str | None = None,
):
    return result(
        await ChatService(request, principal, pet_id).messages(session_id, limit, cursor), pet_id
    )


@chat_router.post(
    "/sessions/{session_id}/messages", status_code=202, dependencies=[Depends(command)]
)
async def send(
    pet_id: UUID,
    session_id: UUID,
    payload: SendMessage,
    request: Request,
    principal: Authenticated,
    key: str = Header(alias="Idempotency-Key"),
):
    return result(
        await ChatService(request, principal, pet_id).send(
            session_id, payload, idempotency_key(key)
        ),
        pet_id,
    )


@chat_router.post(
    "/sessions/{session_id}/generations", status_code=202, dependencies=[Depends(command)]
)
async def retry(
    pet_id: UUID,
    session_id: UUID,
    payload: RetryGeneration,
    request: Request,
    principal: Authenticated,
    key: str = Header(alias="Idempotency-Key"),
):
    return result(
        await ChatService(request, principal, pet_id).send(
            session_id, payload, idempotency_key(key), retry=True
        ),
        pet_id,
    )


@chat_router.get("/sessions/{session_id}/generations/{generation_id}")
async def snapshot(
    pet_id: UUID, session_id: UUID, generation_id: UUID, request: Request, principal: Authenticated
):
    return result(
        await ChatService(request, principal, pet_id).snapshot(session_id, generation_id), pet_id
    )


@chat_router.post(
    "/sessions/{session_id}/generations/{generation_id}/cancel", dependencies=[Depends(command)]
)
async def cancel(
    pet_id: UUID,
    session_id: UUID,
    generation_id: UUID,
    payload: EmptyCommand,
    request: Request,
    response: Response,
    principal: Authenticated,
):
    generation, pending = await ChatService(request, principal, pet_id).cancel(
        session_id, generation_id
    )
    response.status_code = 202 if pending else 200
    return result({"generation": generation.model_dump(mode="json")}, pet_id)


@chat_router.get("/sessions/{session_id}/generations/{generation_id}/events")
async def events(
    pet_id: UUID,
    session_id: UUID,
    generation_id: UUID,
    request: Request,
    principal: Authenticated,
    last_event_id: str | None = Header(None, alias="Last-Event-ID"),
):
    iterator = await prepare_events(
        request, principal, session_id, generation_id, last_event_id, pet_id
    )
    return StreamingResponse(
        iterator,
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-store",
        },
    )


@chat_router.get("/sessions/{session_id}/generations/{generation_id}/memory-refs")
async def memory_refs(
    pet_id: UUID, session_id: UUID, generation_id: UUID, request: Request, principal: Authenticated
):
    from app.core.errors import AppError
    from app.db.capabilities import SchemaUnavailable, require_capability
    from app.modules.pets.memory_policy import eligible_candidates
    from app.modules.pets.models import PetGenerationContext

    service = ChatService(request, principal, pet_id)
    async with request.app.state.session_factory() as db:
        try:
            await require_capability(db, "pets")
        except SchemaUnavailable:
            raise AppError(503, "PET_STORAGE_UNAVAILABLE", "宠物存储暂不可用。") from None
        await service.session(db, session_id)
        await service.generation_row(db, session_id, generation_id)
        context = await db.get(PetGenerationContext, generation_id)
        eligible = {
            item.id: item for item in await eligible_candidates(db, principal.user_id, pet_id)
        }
        refs = context.memory_refs if context is not None else []
        return {
            "pet_id": str(pet_id),
            "privacy_epoch": str(context.memory_epoch if context else 0),
            "items": [
                {
                    "memory_id": ref["memory_id"],
                    "memory_version": ref["memory_version"],
                    "availability": "available"
                    if UUID(ref["memory_id"]) in eligible
                    and eligible[UUID(ref["memory_id"])].version == ref["memory_version"]
                    else "unavailable",
                }
                for ref in refs
            ],
        }
