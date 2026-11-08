from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.core.errors import NotImplementedFeature
from app.core.ownership import owned_list, owned_one
from app.core.security import Authenticated, get_principal
from app.modules.wallet.models import Wallet, WalletTransaction
from app.modules.wallet.service import AmountCommand

router = APIRouter(prefix="/wallet", tags=["wallet"], dependencies=[Depends(get_principal)])


class WalletView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    balance: int
    reserved: int


class TransactionView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    kind: str
    delta: int
    balance_after: int


@router.get("", response_model=WalletView)
async def get_wallet(request: Request, principal: Authenticated):
    from app.core.errors import AppError

    rows = await owned_list(request, Wallet, principal, 1)
    if not rows:
        raise AppError(404, "RESOURCE_NOT_FOUND", "钱包尚未开通。")
    return rows[0]


@router.get("/{wallet_id}", response_model=WalletView)
async def detail(wallet_id: UUID, request: Request, principal: Authenticated):
    return await owned_one(request, Wallet, wallet_id, principal)


@router.get("/{wallet_id}/transactions", response_model=list[TransactionView])
async def transactions(
    wallet_id: UUID,
    request: Request,
    principal: Authenticated,
    limit: int = Query(50, ge=1, le=100),
):
    await owned_one(request, Wallet, wallet_id, principal)
    async with request.app.state.session_factory() as db:
        return list(
            (
                await db.scalars(
                    select(WalletTransaction)
                    .join(Wallet, Wallet.id == WalletTransaction.wallet_id)
                    .where(Wallet.owner_id == principal.user_id, Wallet.id == wallet_id)
                    .order_by(WalletTransaction.created_at.desc(), WalletTransaction.id)
                    .limit(limit)
                )
            ).all()
        )


@router.post("/reservations")
async def reserve(command: AmountCommand):
    raise NotImplementedFeature("钱包额度预留")
