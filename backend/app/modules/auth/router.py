from uuid import UUID

from fastapi import APIRouter, Request, Response
from sqlalchemy import select

from app.core.security import Authenticated
from app.modules.auth import recovery, service
from app.modules.auth.models import AuthSession
from app.modules.auth.schemas import (
    Credentials,
    CurrentUser,
    EmailInput,
    Registration,
    ResetPasswordInput,
    SessionView,
    VerificationInput,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/csrf")
async def get_csrf(request: Request, response: Response):
    return await service.csrf_token(request, response)


@router.post("/login", response_model=CurrentUser)
async def login(payload: Credentials, request: Request, response: Response):
    return await service.login(
        request, response, str(payload.email), payload.password.get_secret_value()
    )


@router.post("/register", status_code=202)
async def register(payload: Registration, request: Request):
    await service.register(request, payload)
    # Same status and body for duplicate and new addresses. Never logs an outbox link.
    return {
        "message": "如果该邮箱可以注册，我们已受理请求。当前使用本地 Mock 邮件，不会发送真实邮件。"
    }


@router.post("/verify-email")
async def verify_email(payload: VerificationInput, request: Request):
    await recovery.complete_verification(request, payload.token.get_secret_value())
    return {"message": "邮箱验证成功。"}


@router.post("/resend-verification", status_code=202)
async def resend_verification(payload: EmailInput, request: Request):
    await recovery.request_link(request, str(payload.email), verification=True)
    return {
        "message": "如果该邮箱需要验证，我们已受理请求。当前使用本地 Mock 邮件，请查看本地收件箱。"
    }


@router.post("/forgot-password", status_code=202)
async def forgot_password(payload: EmailInput, request: Request):
    await recovery.request_link(request, str(payload.email), verification=False)
    return {
        "message": (
            "如果该邮箱符合找回条件，我们已受理请求。当前使用本地 Mock 邮件，请查看本地收件箱。"
        )
    }


@router.post("/reset-password")
async def reset_password(payload: ResetPasswordInput, request: Request):
    await recovery.reset_password(
        request, payload.token.get_secret_value(), payload.password.get_secret_value()
    )
    response = Response(
        content='{"message":"密码已更新，请重新登录。"}', media_type="application/json"
    )
    service.clear_cookies(request, response)
    return response


@router.get("/me", response_model=CurrentUser)
async def me(request: Request, principal: Authenticated):
    return await service.profile(request, principal)


@router.get("/sessions", response_model=list[SessionView])
async def list_sessions(request: Request, principal: Authenticated):
    async with request.app.state.session_factory() as db:
        rows = (
            await db.scalars(
                select(AuthSession)
                .where(
                    AuthSession.user_id == principal.user_id,
                    AuthSession.revoked_at.is_(None),
                    AuthSession.expires_at > service.now(),
                )
                .order_by(AuthSession.created_at.desc(), AuthSession.id)
                .limit(100)
            )
        ).all()
        return [
            SessionView(
                id=row.id,
                created_at=row.created_at,
                expires_at=row.expires_at,
                last_seen_at=row.last_seen_at,
                current=row.id == principal.session_id,
            )
            for row in rows
        ]


@router.post("/logout", status_code=204)
async def logout(request: Request, principal: Authenticated):
    await service.revoke(request, principal, principal.session_id)
    response = Response(status_code=204)
    service.clear_cookies(request, response)
    return response


@router.post("/logout-all", status_code=204)
async def logout_all(request: Request, principal: Authenticated):
    await service.revoke(request, principal)
    response = Response(status_code=204)
    service.clear_cookies(request, response)
    return response


@router.delete("/sessions/{session_id}", status_code=204)
async def revoke_session(session_id: UUID, request: Request, principal: Authenticated):
    await service.revoke(request, principal, session_id)
    response = Response(status_code=204)
    if principal.session_id == session_id:
        service.clear_cookies(request, response)
    return response
