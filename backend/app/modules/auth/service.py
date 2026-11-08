import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from anyio import to_thread
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from argon2.low_level import Type
from fastapi import Request, Response
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.core.errors import AppError
from app.core.security import Principal, Role
from app.modules.auth.models import AuthSession, EmailVerification
from app.modules.auth.schemas import CurrentUser, Registration
from app.modules.auth.store import rate_limit
from app.modules.users.models import User

PASSWORD_HASHER = PasswordHasher(type=Type.ID, time_cost=3, memory_cost=65536, parallelism=2)


def now() -> datetime:
    return datetime.now(UTC)


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def user_view(user: User) -> CurrentUser:
    return CurrentUser(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        status=user.status,
        email_verified=user.email_verified_at is not None,
    )


async def profile(request: Request, principal: Principal) -> CurrentUser:
    async with request.app.state.session_factory() as db:
        user = await db.scalar(
            select(User).where(User.id == principal.user_id, User.status == "active")
        )
        if user is None:
            raise AppError(401, "AUTHENTICATION_REQUIRED", "请重新登录。")
        return user_view(user)


def cookie(request: Request, response: Response, name: str, value: str, ttl: int):
    response.set_cookie(
        name,
        value,
        max_age=ttl,
        expires=now() + timedelta(seconds=ttl),
        path="/",
        secure=request.app.state.settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )


def clear_cookies(request: Request, response: Response):
    settings = request.app.state.settings
    for name in (settings.session_cookie, settings.csrf_cookie):
        response.delete_cookie(
            name, path="/", secure=settings.cookie_secure, httponly=True, samesite="lax"
        )


async def session_user(request: Request) -> tuple[AuthSession, User] | None:
    token = request.cookies.get(request.app.state.settings.session_cookie, "")
    if not 40 <= len(token) <= 128:
        return None
    hashed = digest(token)
    if await request.app.state.auth_store.access("get", f"revoked:{hashed}"):
        return None
    async with request.app.state.session_factory() as db:
        row = (
            await db.execute(
                select(AuthSession, User)
                .join(User, User.id == AuthSession.user_id)
                .where(
                    AuthSession.token_hash == hashed,
                    AuthSession.revoked_at.is_(None),
                    AuthSession.expires_at > now(),
                    User.status == "active",
                )
            )
        ).first()
        if row is None:
            return None
        session, user = row
        if request.app.state.settings.require_verified_email and user.email_verified_at is None:
            return None
        return session, user


def check_origin(request: Request):
    settings = request.app.state.settings
    if request.headers.get("origin") not in settings.cors_origins:
        raise AppError(403, "CSRF_REJECTED", "请求来源或安全校验无效，请刷新页面后重试。")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise AppError(403, "CSRF_REJECTED", "请求来源或安全校验无效，请刷新页面后重试。")
    if settings.environment == "production" and request.url.scheme != "https":
        raise AppError(400, "HTTPS_REQUIRED", "认证请求必须使用 HTTPS。")


async def check_csrf(request: Request, identity=None):
    check_origin(request)
    token = request.cookies.get(request.app.state.settings.csrf_cookie, "")
    header = request.headers.get("x-csrf-token", "")
    if (
        not 40 <= len(token) <= 128
        or not token.isascii()
        or not header.isascii()
        or not secrets.compare_digest(token, header)
    ):
        raise AppError(403, "CSRF_REJECTED", "安全校验已失效，请刷新页面后重试。")
    identity = identity or await session_user(request)
    if identity:
        valid = secrets.compare_digest(identity[0].csrf_hash, digest(token))
    else:
        valid = bool(await request.app.state.auth_store.access("get", f"csrf:{digest(token)}"))
    if not valid:
        raise AppError(403, "CSRF_REJECTED", "安全校验已失效，请刷新页面后重试。")


async def csrf_token(request: Request, response: Response) -> dict:
    if request.app.state.settings.environment == "production" and request.url.scheme != "https":
        raise AppError(400, "HTTPS_REQUIRED", "认证请求必须使用 HTTPS。")
    origin = request.headers.get("origin")
    if origin is not None and origin not in request.app.state.settings.cors_origins:
        raise AppError(403, "CSRF_REJECTED", "请求来源无效。")
    await rate_limit(request, "csrf", 120, seconds=60)
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise AppError(403, "CSRF_REJECTED", "请求来源无效。")
    identity = await session_user(request)
    token = request.cookies.get(request.app.state.settings.csrf_cookie, "")
    if identity:
        if (
            not 40 <= len(token) <= 128
            or not token.isascii()
            or not secrets.compare_digest(identity[0].csrf_hash, digest(token))
        ):
            token = secrets.token_urlsafe(32)
            async with request.app.state.session_factory() as db:
                await db.execute(
                    update(AuthSession)
                    .where(AuthSession.id == identity[0].id, AuthSession.revoked_at.is_(None))
                    .values(csrf_hash=digest(token))
                )
                await db.commit()
        ttl = max(1, int((aware(identity[0].expires_at) - now()).total_seconds()))
    else:
        if not 40 <= len(token) <= 128 or not await request.app.state.auth_store.access(
            "get", f"csrf:{digest(token)}"
        ):
            token = secrets.token_urlsafe(32)
            await request.app.state.auth_store.access("put", f"csrf:{digest(token)}", 600)
        ttl = 600
    cookie(request, response, request.app.state.settings.csrf_cookie, token, ttl)
    return {"csrf_token": token}


async def principal_for(request: Request) -> Principal:
    identity = await session_user(request)
    if not identity:
        raise AppError(401, "AUTHENTICATION_REQUIRED", "请先登录，或重新登录已过期的会话。")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        await check_csrf(request, identity)
    session, user = identity
    if (now() - aware(session.last_seen_at)).total_seconds() >= 300:
        async with request.app.state.session_factory() as db:
            await db.execute(
                update(AuthSession)
                .where(AuthSession.id == session.id, AuthSession.revoked_at.is_(None))
                .values(last_seen_at=now())
            )
            await db.commit()
    return Principal(user.id, Role(user.role), session.id)


async def password_hash(request: Request, password: str) -> str:
    return await to_thread.run_sync(
        PASSWORD_HASHER.hash, password, limiter=request.app.state.password_limiter
    )


async def password_matches(request: Request, stored: str, supplied: str) -> bool:
    def verify():
        try:
            return PASSWORD_HASHER.verify(stored, supplied)
        except (VerificationError, InvalidHashError):
            return False

    return await to_thread.run_sync(verify, limiter=request.app.state.password_limiter)


async def register(request: Request, payload: Registration):
    await check_csrf(request)
    await rate_limit(request, "register-ip", request.app.state.settings.register_ip_limit)
    hashed = await password_hash(request, payload.password.get_secret_value())
    token = secrets.token_urlsafe(32)
    async with request.app.state.session_factory() as db:
        if await db.scalar(select(User.id).where(User.email == str(payload.email))):
            return
        user = User(
            email=str(payload.email), password_hash=hashed, display_name=payload.display_name
        )
        db.add(user)
        try:
            await db.flush()
            db.add(
                EmailVerification(
                    user_id=user.id, token_hash=digest(token), expires_at=now() + timedelta(days=1)
                )
            )
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", "")
            if constraint == "uq_users_email" or "UNIQUE constraint failed: users.email" in str(
                exc.orig
            ):
                return
            raise
    from app.modules.auth.recovery import deliver

    await deliver(request, "send_verification", recipient=user.email, token=token)


async def login(request: Request, response: Response, email: str, password: str) -> CurrentUser:
    await check_csrf(request)
    settings = request.app.state.settings
    await rate_limit(request, "login-ip", settings.login_ip_limit)
    await rate_limit(request, "login-account", settings.login_account_limit, email)
    async with request.app.state.session_factory() as db:
        user = await db.scalar(select(User).where(User.email == email).with_for_update())
        matched = await password_matches(
            request, user.password_hash if user else request.app.state.dummy_hash, password
        )
        if (
            not matched
            or user is None
            or user.status != "active"
            or (settings.require_verified_email and user.email_verified_at is None)
        ):
            raise AppError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确，或账户暂时不可用。")
        if PASSWORD_HASHER.check_needs_rehash(user.password_hash):
            user.password_hash = await password_hash(request, password)
        old_token = request.cookies.get(settings.session_cookie, "")
        if old_token:
            await db.execute(
                update(AuthSession)
                .where(
                    AuthSession.token_hash == digest(old_token), AuthSession.revoked_at.is_(None)
                )
                .values(revoked_at=now())
            )
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        db.add(
            AuthSession(
                user_id=user.id,
                token_hash=digest(token),
                csrf_hash=digest(csrf),
                expires_at=now() + timedelta(seconds=settings.session_ttl_seconds),
                last_seen_at=now(),
            )
        )
        await db.commit()
    cookie(request, response, settings.session_cookie, token, settings.session_ttl_seconds)
    cookie(request, response, settings.csrf_cookie, csrf, settings.session_ttl_seconds)
    return user_view(user)


async def revoke(request: Request, principal: Principal, session_id: UUID | None = None):
    async with request.app.state.session_factory() as db:
        statement = select(AuthSession).where(AuthSession.user_id == principal.user_id)
        if session_id is not None:
            statement = statement.where(AuthSession.id == session_id)
        rows = list((await db.scalars(statement.with_for_update())).all())
        if session_id is not None and not rows:
            raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
        for row in rows:
            row.revoked_at = row.revoked_at or now()
        await db.commit()
    # PostgreSQL is authoritative even if a Redis hint write fails after commit.
    for row in rows:
        try:
            ttl = max(1, int((aware(row.expires_at) - now()).total_seconds()))
            await request.app.state.auth_store.access("put", f"revoked:{row.token_hash}", ttl)
        except AppError:
            pass
