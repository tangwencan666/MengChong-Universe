from fastapi import APIRouter, Depends, Request

from app.core.security import Authenticated, get_principal
from app.modules.auth.schemas import CurrentUser
from app.modules.auth.service import profile

router = APIRouter(prefix="/users", tags=["users"], dependencies=[Depends(get_principal)])


@router.get("/me", response_model=CurrentUser)
async def current_profile(request: Request, principal: Authenticated):
    return await profile(request, principal)
