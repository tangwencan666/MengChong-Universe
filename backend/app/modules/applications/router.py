from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict

from app.core.ownership import owned_list, owned_one
from app.core.security import Authenticated, get_principal
from app.modules.applications.models import JobApplication

router = APIRouter(
    prefix="/applications", tags=["applications"], dependencies=[Depends(get_principal)]
)


class ApplicationView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    company: str
    position: str
    stage: str
    notes: str | None


@router.get("", response_model=list[ApplicationView])
async def list_applications(
    request: Request,
    principal: Authenticated,
    limit: int = Query(50, ge=1, le=100),
):
    return await owned_list(request, JobApplication, principal, limit)


@router.get("/{application_id}", response_model=ApplicationView)
async def detail(application_id: UUID, request: Request, principal: Authenticated):
    return await owned_one(request, JobApplication, application_id, principal)
