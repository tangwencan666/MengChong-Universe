from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Entity


class Wallet(Entity, Base):
    __tablename__ = "wallets"
    __table_args__ = (
        UniqueConstraint("id", "owner_id"),
        CheckConstraint(
            "balance >= 0 AND reserved >= 0 AND reserved <= balance", name="funds_valid"
        ),
        CheckConstraint("version >= 0", name="version_nonnegative"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    balance: Mapped[int] = mapped_column(BigInteger, server_default="0")
    reserved: Mapped[int] = mapped_column(BigInteger, server_default="0")
    version: Mapped[int] = mapped_column(BigInteger, server_default="0")
    transactions: Mapped[list["WalletTransaction"]] = relationship(
        back_populates="wallet", lazy="raise"
    )


class WalletReservation(Entity, Base):
    __tablename__ = "wallet_reservations"
    __table_args__ = (
        UniqueConstraint("wallet_id", "idempotency_key"),
        UniqueConstraint("id", "wallet_id"),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("status IN ('pending','captured','released')", name="status_valid"),
        Index("ix_wallet_reservations_status_expires_at", "status", "expires_at"),
    )
    wallet_id: Mapped[UUID] = mapped_column(ForeignKey("wallets.id"), index=True)
    amount: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(20), server_default="pending")
    idempotency_key: Mapped[str] = mapped_column(String(120))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class UsageRecord(Entity, Base):
    __tablename__ = "usage_records"
    __table_args__ = (
        UniqueConstraint("id", "wallet_id"),
        ForeignKeyConstraint(["wallet_id", "owner_id"], ["wallets.id", "wallets.owner_id"]),
        ForeignKeyConstraint(
            ["session_id", "owner_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        CheckConstraint("input_tokens >= 0 AND output_tokens >= 0", name="tokens_nonnegative"),
        UniqueConstraint("wallet_id", "idempotency_key"),
        Index("ix_usage_records_owner_id_created_at", "owner_id", "created_at"),
    )
    wallet_id: Mapped[UUID] = mapped_column()
    owner_id: Mapped[UUID] = mapped_column()
    session_id: Mapped[UUID | None] = mapped_column()
    provider: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(100))
    input_tokens: Mapped[int] = mapped_column(BigInteger)
    output_tokens: Mapped[int] = mapped_column(BigInteger)
    idempotency_key: Mapped[str] = mapped_column(String(120))


class WalletTransaction(Entity, Base):
    __tablename__ = "wallet_transactions"
    __table_args__ = (
        UniqueConstraint("id", "wallet_id"),
        UniqueConstraint("wallet_id", "idempotency_key"),
        ForeignKeyConstraint(
            ["usage_record_id", "wallet_id"], ["usage_records.id", "usage_records.wallet_id"]
        ),
        ForeignKeyConstraint(
            ["original_transaction_id", "wallet_id"],
            ["wallet_transactions.id", "wallet_transactions.wallet_id"],
        ),
        CheckConstraint(
            "(kind = 'refund' AND original_transaction_id IS NOT NULL) OR "
            "(kind != 'refund' AND original_transaction_id IS NULL)",
            name="refund_reference_valid",
        ),
        ForeignKeyConstraint(
            ["reservation_id", "wallet_id"],
            ["wallet_reservations.id", "wallet_reservations.wallet_id"],
        ),
        CheckConstraint(
            "(kind IN ('grant','refund') AND delta > 0) OR (kind = 'debit' AND delta < 0)",
            name="direction_valid",
        ),
        CheckConstraint("balance_after >= 0", name="balance_nonnegative"),
        Index("ix_wallet_transactions_wallet_id_created_at", "wallet_id", "created_at"),
    )
    wallet_id: Mapped[UUID] = mapped_column(ForeignKey("wallets.id"))
    kind: Mapped[str] = mapped_column(String(20))
    delta: Mapped[int] = mapped_column(BigInteger)
    balance_after: Mapped[int] = mapped_column(BigInteger)
    reservation_id: Mapped[UUID | None] = mapped_column()
    usage_record_id: Mapped[UUID | None] = mapped_column()
    original_transaction_id: Mapped[UUID | None] = mapped_column()
    idempotency_key: Mapped[str] = mapped_column(String(120))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    wallet: Mapped[Wallet] = relationship(back_populates="transactions", lazy="raise")
