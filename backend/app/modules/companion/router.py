from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from app.agent.sse import mock_demo_events
from app.core.errors import AppError
from app.core.ownership import owned_list, owned_one
from app.core.rate_limit import demo_rate_limit
from app.core.security import Authenticated
from app.modules.companion.access import command_limit
from app.modules.companion.events import prepare_events
from app.modules.companion.models import AICompanion
from app.modules.companion.schemas import (
    ChatRuntimeView,
    CompanionView,
    CreateSession,
    DismissTopic,
    GenerationAccepted,
    GenerationResult,
    GenerationSnapshot,
    MessagePage,
    PreferencesView,
    RecentTopicView,
    RenameSession,
    RetryGeneration,
    SendMessage,
    SessionCreated,
    SessionPage,
    SessionView,
    UpdatePreferences,
)
from app.modules.companion.service import ChatService, idempotency_key


class ChatRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def bounded(request):
            if request.method in {"POST", "PATCH", "DELETE"} and not request.url.path.endswith(
                "/demo/stream"
            ):
                parts, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 32768:
                        raise AppError(422, "VALIDATION_ERROR", "请求内容超过大小限制。")
                    parts.append(chunk)
                request._body = b"".join(parts)
            return await original(request)

        return bounded


router = APIRouter(prefix="/companion", tags=["companion"], route_class=ChatRoute)


class DemoInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    message: str = Field(min_length=1, max_length=2000)


class EmptyCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")


async def command(request: Request, principal: Authenticated):
    await command_limit(request, principal)


@router.post(
    "/demo/stream",
    dependencies=[Depends(demo_rate_limit)],
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def stream_demo(payload: DemoInput, request: Request):
    """Public fixed Mock: never writes sessions, memories, or usage."""
    if not request.app.state.settings.demo_enabled:
        raise AppError(404, "DEMO_DISABLED", "演示入口未开放。")
    return StreamingResponse(
        mock_demo_events(payload.message, request.state.request_id),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache, no-store"},
    )


@router.get("/runtime", response_model=ChatRuntimeView)
async def chat_runtime(request: Request, principal: Authenticated):
    """Authenticated, read-only server mode disclosure; no credentials or internal endpoints."""
    settings = request.app.state.settings
    mock = settings.llm_provider == "mock"
    return ChatRuntimeView(
        provider=settings.llm_provider,
        model=settings.selected_model,
        mode="mock" if mock else "real",
        billing="none" if mock else "external_provider",
        memory_injection_enabled=settings.memory_injection_enabled,
    )


@router.post(
    "/sessions", response_model=SessionCreated, status_code=201, dependencies=[Depends(command)]
)
async def create_session(
    payload: CreateSession,
    request: Request,
    response: Response,
    principal: Authenticated,
    key: str = Header(alias="Idempotency-Key"),
):
    result = await ChatService(request, principal).create_session(payload, idempotency_key(key))
    response.headers["Location"] = f"/api/v1/companion/sessions/{result.session.id}"
    return result


@router.get("/sessions", response_model=SessionPage)
async def list_sessions(
    request: Request,
    principal: Authenticated,
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None),
):
    return await ChatService(request, principal).list_sessions(limit, cursor)


@router.get("/sessions/{session_id}", response_model=SessionView)
async def session_detail(session_id: UUID, request: Request, principal: Authenticated):
    return await ChatService(request, principal).detail(session_id)


@router.patch("/sessions/{session_id}", response_model=SessionView, dependencies=[Depends(command)])
async def rename_session(
    session_id: UUID, payload: RenameSession, request: Request, principal: Authenticated
):
    return await ChatService(request, principal).rename(session_id, payload)


@router.delete("/sessions/{session_id}", status_code=204, dependencies=[Depends(command)])
async def delete_session(session_id: UUID, request: Request, principal: Authenticated):
    await ChatService(request, principal).delete(session_id)
    return Response(status_code=204)


@router.get("/sessions/{session_id}/messages", response_model=MessagePage)
async def messages(
    session_id: UUID,
    request: Request,
    principal: Authenticated,
    limit: int = Query(50, ge=1, le=100),
    cursor: str | None = Query(None),
):
    return await ChatService(request, principal).messages(session_id, limit, cursor)


@router.post(
    "/sessions/{session_id}/messages",
    response_model=GenerationAccepted,
    status_code=202,
    dependencies=[Depends(command)],
)
async def send_message(
    session_id: UUID,
    payload: SendMessage,
    request: Request,
    principal: Authenticated,
    key: str = Header(alias="Idempotency-Key"),
):
    return await ChatService(request, principal).send(session_id, payload, idempotency_key(key))


@router.post(
    "/sessions/{session_id}/generations",
    response_model=GenerationAccepted,
    status_code=202,
    dependencies=[Depends(command)],
)
async def retry_generation(
    session_id: UUID,
    payload: RetryGeneration,
    request: Request,
    principal: Authenticated,
    key: str = Header(alias="Idempotency-Key"),
):
    return await ChatService(request, principal).send(
        session_id, payload, idempotency_key(key), retry=True
    )


@router.get("/sessions/{session_id}/generations/{generation_id}", response_model=GenerationSnapshot)
async def generation_detail(
    session_id: UUID, generation_id: UUID, request: Request, principal: Authenticated
):
    return await ChatService(request, principal).snapshot(session_id, generation_id)


@router.post(
    "/sessions/{session_id}/generations/{generation_id}/cancel",
    dependencies=[Depends(command)],
    response_model=GenerationResult,
    responses={202: {"model": GenerationResult, "description": "Cancellation requested"}},
)
async def cancel_generation(
    session_id: UUID,
    generation_id: UUID,
    payload: EmptyCommand,
    request: Request,
    response: Response,
    principal: Authenticated,
):
    gen, pending = await ChatService(request, principal).cancel(session_id, generation_id)
    response.status_code = 202 if pending else 200
    return {"generation": gen}


@router.get(
    "/sessions/{session_id}/generations/{generation_id}/events",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def generation_events(
    session_id: UUID,
    generation_id: UUID,
    request: Request,
    principal: Authenticated,
    last_event_id: str | None = Header(None, alias="Last-Event-ID"),
):
    iterator = await prepare_events(request, principal, session_id, generation_id, last_event_id)
    return StreamingResponse(
        iterator,
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache, no-store"},
    )


@router.get("/sessions/{session_id}/generations/{generation_id}/memory-refs")
async def memory_refs(
    session_id: UUID, generation_id: UUID, request: Request, principal: Authenticated
):
    return await ChatService(request, principal).memory_refs(session_id, generation_id)


@router.get("/preferences", response_model=PreferencesView)
async def preferences(request: Request, principal: Authenticated):
    return await ChatService(request, principal).preferences()


@router.patch("/preferences", response_model=PreferencesView, dependencies=[Depends(command)])
async def update_preferences(
    payload: UpdatePreferences, request: Request, principal: Authenticated
):
    return await ChatService(request, principal).update_preferences(payload)


@router.get("/recent-topic", response_model=RecentTopicView)
async def recent_topic(request: Request, principal: Authenticated):
    return await ChatService(request, principal).recent_topic()


@router.post(
    "/sessions/{session_id}/topic-dismissals", status_code=204, dependencies=[Depends(command)]
)
async def dismiss_topic(
    session_id: UUID, payload: DismissTopic, request: Request, principal: Authenticated
):
    await ChatService(request, principal).dismiss_topic(session_id, payload)
    return Response(status_code=204)


@router.get("/companions", response_model=list[CompanionView])
async def companions(
    request: Request, principal: Authenticated, limit: int = Query(50, ge=1, le=100)
):
    return await owned_list(request, AICompanion, principal, limit)


@router.get("/companions/{companion_id}", response_model=CompanionView)
async def companion_detail(companion_id: UUID, request: Request, principal: Authenticated):
    return await owned_one(request, AICompanion, companion_id, principal)
