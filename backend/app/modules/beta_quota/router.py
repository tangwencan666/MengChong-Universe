from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.core.security import Authenticated
from app.modules.beta_quota import service
from app.modules.beta_quota.http import BoundedBetaRoute, beta_limit
from app.modules.users.models import User

router = APIRouter(prefix="/beta/quota", tags=["beta quota"], route_class=BoundedBetaRoute)


class Claim(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    invitation: str = Field(min_length=32, max_length=128, repr=False)


@router.get("")
async def current(request: Request, principal: Authenticated):
    async with request.app.state.session_factory() as db:
        return await service.snapshot(db, principal.user_id, request.app.state.settings)


@router.post("/claim")
async def claim(payload: Claim, request: Request, principal: Authenticated):
    await beta_limit(request, principal, "claim")
    async with request.app.state.session_factory() as db, db.begin():
        user = await db.scalar(select(User).where(User.id == principal.user_id).with_for_update())
        if user is None:
            raise service.QuotaRejected(status=403)
        await service.claim(db, user, payload.invitation, request.app.state.settings)
        return await service.snapshot(db, principal.user_id, request.app.state.settings)
