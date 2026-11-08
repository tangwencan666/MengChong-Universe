from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request

from app.core.errors import AppError


class Role(StrEnum):
    USER = "user"
    MODERATOR = "moderator"
    ADMIN = "admin"


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    role: Role = Role.USER
    session_id: UUID | None = None


async def get_principal(request: Request) -> Principal:
    from app.modules.auth.service import principal_for

    return await principal_for(request)


Authenticated = Annotated[Principal, Depends(get_principal)]


def require_roles(*roles: Role) -> Callable:
    async def dependency(principal: Principal = Depends(get_principal)) -> Principal:  # noqa: B008
        if principal.role not in roles:
            raise AppError(403, "FORBIDDEN", "没有访问权限。")
        return principal

    return dependency


def ensure_owner(principal: Principal, owner_id: UUID) -> None:
    # Admin role does not implicitly grant access to private conversations or memories.
    if principal.user_id != owner_id:
        raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
