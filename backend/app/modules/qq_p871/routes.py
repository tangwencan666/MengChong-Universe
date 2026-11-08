"""Opt-in FastAPI installation; never imported or mounted by the default app."""

from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.core.errors import AppError
from app.core.security import Authenticated
from app.modules.companion.router import command
from app.modules.memory.router import MemoryRoute
from app.modules.qq_p87.contracts import Rejected, SendNotAccepted, SendUncertain

from .protocol import decode


class BindingStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pet_instance_id: UUID


class BindingConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr = Field(min_length=32, max_length=64)
    confirmation: SecretStr = Field(min_length=32, max_length=64)
    allow_memory: bool = False


class BindingRevoke(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject_hmac: str = Field(pattern=r"^[a-f0-9]{64}$")


def install_qq_routes(
    app, channel, *, enabled=False, enroll_sandbox_accounts=False, receive_callback=True
):
    if not enabled:
        return
    if getattr(app.state, "qq_p871_installed", False):
        raise Rejected("QQ_ROUTES_ALREADY_INSTALLED")
    app.state.qq_p871_installed = True
    router = APIRouter(prefix="/api/v1/qq", tags=["qq-sandbox"], route_class=MemoryRoute)

    async def bounded(request):
        pieces, size = [], 0
        async for part in request.stream():
            size += len(part)
            if size > 32768:
                raise Rejected("QQ_PAYLOAD_INVALID")
            pieces.append(part)
        return b"".join(pieces)

    def safe_error(error):
        return JSONResponse(
            {"error": error.code}, status_code=400, headers={"Cache-Control": "no-store"}
        )

    async def callback(request: Request):
        try:
            body = await bounded(request)
            supplied = {}
            for key, value in request.headers.raw:
                name = key.decode("latin1").lower()
                if name in supplied:
                    raise Rejected("QQ_SIGNATURE_INVALID")
                supplied[name] = value.decode("latin1")
            if request.query_params:
                raise Rejected("QQ_QUERY_NOT_ALLOWED")
            if decode(body).get("op") == 13:
                return JSONResponse(
                    channel.adapter.protocol.validation(body, supplied, channel.now())
                )
            # Authentication happens before commands or user text are considered.
            receipt = channel.adapter.verify(body, supplied, channel.now())
            if receipt.text.startswith("/bind "):
                await channel.enqueue_binding(body, supplied, receipt.text[6:])
            else:
                await channel.enqueue(body, supplied)
            return JSONResponse({"op": 12}, headers={"Cache-Control": "no-store"})
        except Rejected as error:
            if error.code == "QQ_EVENT_UNSUPPORTED":
                return JSONResponse({"op": 12}, headers={"Cache-Control": "no-store"})
            return safe_error(error)
        except (SendNotAccepted, SendUncertain, TimeoutError):
            return JSONResponse(
                {"error": "QQ_CONTROL_REPLY_UNAVAILABLE"},
                status_code=503,
                headers={"Cache-Control": "no-store"},
            )

    if receive_callback:
        router.add_api_route("/callback", callback, methods=["POST"], include_in_schema=False)

    async def control(operation):
        try:
            return await operation
        except Rejected as error:
            raise AppError(400, error.code, "QQ测试绑定暂不可用。") from None

    @router.post("/bindings/challenges", dependencies=[Depends(command)])
    async def start(payload: BindingStart, principal: Authenticated):
        if enroll_sandbox_accounts:
            # Only this isolated, paid-model-disabled fixture initializes five
            # synthetic slots. Existing real credit balances are never touched.
            await control(
                channel.reader.read(
                    str(principal.user_id), str(payload.pet_instance_id), allow_memory=False
                )
            )
            try:
                channel.store.add_account(str(principal.user_id), 5)
            except Rejected as error:
                if error.code != "GRANT_ALREADY_INITIALIZED":
                    raise AppError(400, error.code, "QQ测试额度不可用。") from None
        token = await control(
            channel.start_binding(
                str(principal.user_id),
                str(payload.pet_instance_id),
                channel.adapter.protocol.app_id,
            )
        )
        return {"token": token, "expires_in": 300, "sandbox": True}

    @router.get("/bindings")
    async def listing(principal: Authenticated):
        return {"bindings": channel.store.list_bindings(str(principal.user_id))}

    @router.post("/bindings/confirm", dependencies=[Depends(command)])
    async def confirm(payload: BindingConfirm, principal: Authenticated):
        await control(
            channel.confirm_binding(
                str(principal.user_id),
                payload.token.get_secret_value(),
                payload.confirmation.get_secret_value(),
                memory=payload.allow_memory,
            )
        )
        return {"bound": True, "sandbox": True, "model": "mock-pet-v1"}

    @router.post("/bindings/revoke", dependencies=[Depends(command)])
    async def revoke(payload: BindingRevoke, principal: Authenticated):
        try:
            channel.revoke(
                str(principal.user_id), channel.adapter.protocol.app_id, payload.subject_hmac
            )
        except Rejected as error:
            return safe_error(error)
        return {"revoked": True}

    app.include_router(router)
