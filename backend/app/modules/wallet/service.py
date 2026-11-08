from typing import Annotated, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.security import Principal


class AmountCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: Annotated[int, Field(strict=True, gt=0, le=9223372036854775807)]
    idempotency_key: str = Field(min_length=16, max_length=120)


class WalletService(Protocol):
    """Interface only. Every future mutation must:

    1. Check owner; BEGIN; lock wallet SELECT FOR UPDATE (PostgreSQL).
    2. Deduplicate (wallet_id, idempotency_key); compare canonical request fingerprint.
    3. Reject a reused key with different input, insufficient funds, or invalid state.
    4. Atomically update reserved/balance/version + append immutable ledger + usage.
    5. COMMIT once; retry serialization/deadlock errors with the same key.

    capture is at most reserved amount, refund refers to an original debit and cannot
    exceed it; expiration releases pending reservations exactly once. No floats,
    token-to-currency rate, paid recharge, or payment adapters exist in this phase.
    Database constraints alone do not implement these transaction guarantees.
    """

    async def reserve(self, principal: Principal, command: AmountCommand) -> UUID: ...
    async def capture(
        self, principal: Principal, reservation_id: UUID, command: AmountCommand
    ) -> UUID: ...
    async def release(
        self, principal: Principal, reservation_id: UUID, idempotency_key: str
    ) -> None: ...
    async def refund(
        self, principal: Principal, original_debit_id: UUID, command: AmountCommand
    ) -> UUID: ...
