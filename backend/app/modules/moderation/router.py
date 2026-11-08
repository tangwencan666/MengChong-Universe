from fastapi import APIRouter, Depends

from app.core.errors import NotImplementedFeature
from app.core.security import Role, require_roles

router = APIRouter(
    prefix="/moderation",
    tags=["moderation"],
    dependencies=[Depends(require_roles(Role.MODERATOR, Role.ADMIN))],
)


@router.get("/reports")
async def list_reports():
    raise NotImplementedFeature("举报审核与操作审计")
