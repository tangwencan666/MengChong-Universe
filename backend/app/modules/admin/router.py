from fastapi import APIRouter, Depends

from app.core.errors import NotImplementedFeature
from app.core.security import Role, require_roles

router = APIRouter(
    prefix="/admin", tags=["admin"], dependencies=[Depends(require_roles(Role.ADMIN))]
)


@router.get("")
async def admin_overview():
    raise NotImplementedFeature("管理后台")
