from uuid import UUID

from fastapi import Request
from sqlalchemy import select

from app.core.errors import AppError
from app.core.security import Principal


async def owned_list(request: Request, model, principal: Principal, limit: int = 50, *criteria):
    async with request.app.state.session_factory() as db:
        return list(
            (
                await db.scalars(
                    select(model)
                    .where(model.owner_id == principal.user_id, *criteria)
                    .order_by(model.created_at.desc(), model.id)
                    .limit(limit)
                )
            ).all()
        )


async def owned_one(request: Request, model, resource_id: UUID, principal: Principal, *criteria):
    async with request.app.state.session_factory() as db:
        row = await db.scalar(
            select(model).where(
                model.id == resource_id, model.owner_id == principal.user_id, *criteria
            )
        )
        if row is None:
            raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
        return row
