from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, StrictBool
from sqlalchemy import select

from app.core.errors import AppError
from app.core.security import Authenticated
from app.modules.beta_quota import privacy
from app.modules.beta_quota.http import BoundedBetaRoute, beta_limit
from app.modules.users.models import User

router = APIRouter(prefix="/beta/privacy", tags=["beta privacy"], route_class=BoundedBetaRoute)


class Consent(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    enabled: StrictBool
    policy_version: str


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    kind: Literal["active", "fault_network", "fault_startup", "fault_renderer"]


async def lock_owner(db, owner):
    user = await db.scalar(select(User).where(User.id == owner).with_for_update())
    if user is None or user.status != "active":
        raise AppError(403, "FORBIDDEN", "账号暂不可用。")


@router.get("")
async def status(request: Request, principal: Authenticated):
    async with request.app.state.session_factory() as db:
        return await privacy.status(db, principal.user_id, request.app.state.settings)


@router.post("/consent")
async def consent(payload: Consent, request: Request, principal: Authenticated):
    await beta_limit(request, principal, "privacy")
    async with request.app.state.session_factory() as db, db.begin():
        await lock_owner(db, principal.user_id)
        await privacy.consent(
            db,
            principal.user_id,
            request.app.state.settings,
            payload.enabled,
            payload.policy_version,
        )
        return await privacy.status(db, principal.user_id, request.app.state.settings)


@router.post("/events", status_code=202)
async def event(payload: Event, request: Request, principal: Authenticated):
    await beta_limit(request, principal, "metrics")
    async with request.app.state.session_factory() as db, db.begin():
        await lock_owner(db, principal.user_id)
        recorded = await privacy.record(
            db, principal.user_id, request.app.state.settings, payload.kind
        )
        return {"recorded": recorded}
