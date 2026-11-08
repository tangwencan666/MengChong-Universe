"""Email verification and password recovery; never sends real mail by default."""

import asyncio
import logging
import secrets
import time
from datetime import timedelta

from fastapi import Request
from sqlalchemy import select, update

from app.core.errors import AppError
from app.modules.auth import service
from app.modules.auth.models import AuthSession, EmailVerification, PasswordReset
from app.modules.auth.store import rate_limit
from app.modules.users.models import User


async def deliver(request: Request, method: str, **values):
    try:
        await getattr(request.app.state.mailer, method)(**values)
    except Exception:
        # Delivery failures must not reveal account existence or undo a committed reset.
        logging.getLogger("weibiye").warning("mail_delivery_failed")


async def request_link(request: Request, email: str, *, verification: bool):
    await service.check_csrf(request)
    settings = request.app.state.settings
    purpose = "verify-resend" if verification else "password-reset-request"
    await rate_limit(request, purpose + "-ip", settings.recovery_ip_limit)
    await rate_limit(request, purpose + "-account", settings.recovery_account_limit, email)
    deadline = time.monotonic() + 0.2
    token = secrets.token_urlsafe(32)
    recipient = None
    async with request.app.state.session_factory() as db:
        user = await db.scalar(
            select(User).where(User.email == email, User.status == "active").with_for_update()
        )
        eligible = user is not None and (
            user.email_verified_at is None
            if verification
            else not settings.require_verified_email or user.email_verified_at is not None
        )
        if eligible:
            model = EmailVerification if verification else PasswordReset
            await db.execute(
                update(model)
                .where(model.user_id == user.id, model.consumed_at.is_(None))
                .values(consumed_at=service.now())
            )
            ttl = 86400 if verification else settings.reset_ttl_seconds
            db.add(
                model(
                    user_id=user.id,
                    token_hash=service.digest(token),
                    expires_at=service.now() + timedelta(seconds=ttl),
                )
            )
            await db.commit()
            recipient = user.email
    if recipient:
        await deliver(
            request,
            "send_verification" if verification else "send_password_reset",
            recipient=recipient,
            token=token,
        )
    # Same minimum response window for ineligible/unknown and eligible addresses.
    await asyncio.sleep(max(0, deadline - time.monotonic()))


async def complete_verification(request: Request, token: str):
    await service.check_csrf(request)
    await rate_limit(request, "verify-email", 10)
    hashed = service.digest(token)
    async with request.app.state.session_factory() as db:
        user_id = await db.scalar(
            select(EmailVerification.user_id).where(EmailVerification.token_hash == hashed)
        )
        if user_id is None:
            raise AppError(400, "INVALID_VERIFICATION", "验证链接无效或已过期。")
        # All recovery operations lock the user first, then tokens/sessions.
        user = await db.scalar(
            select(User).where(User.id == user_id, User.status == "active").with_for_update()
        )
        row = await db.scalar(
            select(EmailVerification)
            .where(
                EmailVerification.token_hash == hashed,
                EmailVerification.consumed_at.is_(None),
                EmailVerification.expires_at > service.now(),
            )
            .with_for_update()
        )
        if user is None or row is None:
            raise AppError(400, "INVALID_VERIFICATION", "验证链接无效或已过期。")
        user.email_verified_at = user.email_verified_at or service.now()
        await db.execute(
            update(EmailVerification)
            .where(EmailVerification.user_id == user_id, EmailVerification.consumed_at.is_(None))
            .values(consumed_at=service.now())
        )
        await db.commit()


async def reset_password(request: Request, token: str, password: str):
    await service.check_csrf(request)
    await rate_limit(request, "password-reset-consume", 20)
    hashed = service.digest(token)
    async with request.app.state.session_factory() as db:
        user_id = await db.scalar(
            select(PasswordReset.user_id).where(
                PasswordReset.token_hash == hashed,
                PasswordReset.consumed_at.is_(None),
                PasswordReset.expires_at > service.now(),
            )
        )
        if user_id is None:
            raise AppError(400, "INVALID_RESET", "重置链接无效或已过期。")
    new_hash = await service.password_hash(request, password)
    async with request.app.state.session_factory() as db:
        user = await db.scalar(
            select(User).where(User.id == user_id, User.status == "active").with_for_update()
        )
        row = await db.scalar(
            select(PasswordReset)
            .where(
                PasswordReset.token_hash == hashed,
                PasswordReset.consumed_at.is_(None),
                PasswordReset.expires_at > service.now(),
            )
            .with_for_update()
        )
        if user is None or row is None:
            raise AppError(400, "INVALID_RESET", "重置链接无效或已过期。")
        user.password_hash = new_hash
        for model in (PasswordReset, EmailVerification):
            await db.execute(
                update(model)
                .where(model.user_id == user_id, model.consumed_at.is_(None))
                .values(consumed_at=service.now())
            )
        await db.execute(
            update(AuthSession)
            .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
            .values(revoked_at=service.now())
        )
        await db.commit()
        recipient = user.email
    # SQL validation is authoritative; all previous sessions are now invalid without cache hints.
    await deliver(request, "send_password_changed", recipient=recipient)
