"""Shared access checks; callers lock User before requesting a write lock on Pet."""

from sqlalchemy import select

from app.core.errors import AppError
from app.modules.pets.models import Pet


async def owned_pet(db, owner_id, pet_id, *, write=False, allow_archived=False):
    query = select(Pet).where(Pet.id == pet_id, Pet.owner_id == owner_id)
    if write:
        query = query.with_for_update()
    row = await db.scalar(query)
    if row is None:
        raise AppError(404, "RESOURCE_NOT_FOUND", "资源不存在。")
    if write and row.status == "archived" and not allow_archived:
        raise AppError(409, "PET_ARCHIVED", "这只宠物已归档，当前仅可查看。")
    return row
