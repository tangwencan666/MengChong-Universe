from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.db.base import Base


class BetaBase(DeclarativeBase):
    # Separate migration lineage; existing chat revisions and manifests stay intact.
    metadata = MetaData(naming_convention=dict(Base.metadata.naming_convention))


class BetaInvitation(BetaBase):
    __tablename__ = "beta_invitations"
    __table_args__ = (
        CheckConstraint("grant_requests > 0 AND grant_requests <= 10000", name="grant_bound"),
    )
    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    grant_requests: Mapped[int]
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    grant_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    claimed_by: Mapped[UUID | None] = mapped_column(unique=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BetaAccount(BetaBase):
    __tablename__ = "beta_quota_accounts"
    __table_args__ = (
        CheckConstraint("granted > 0 AND granted <= 10000", name="grant_bound"),
        CheckConstraint("reserved >= 0 AND spent >= 0 AND active >= 0", name="nonnegative"),
        CheckConstraint("reserved + spent <= granted AND active <= reserved", name="grant_limit"),
    )
    owner_id: Mapped[UUID] = mapped_column(primary_key=True)
    granted: Mapped[int]
    reserved: Mapped[int] = mapped_column(default=0)
    spent: Mapped[int] = mapped_column(default=0)
    active: Mapped[int] = mapped_column(default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class BetaDay(BetaBase):
    __tablename__ = "beta_quota_days"
    __table_args__ = (
        CheckConstraint(
            "reserved_requests >= 0 AND spent_requests >= 0", name="request_nonnegative"
        ),
        CheckConstraint("reserved_cost >= 0 AND spent_cost >= 0", name="cost_nonnegative"),
    )
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    reserved_requests: Mapped[int] = mapped_column(default=0)
    spent_requests: Mapped[int] = mapped_column(default=0)
    reserved_cost: Mapped[int] = mapped_column(BigInteger, default=0)
    spent_cost: Mapped[int] = mapped_column(BigInteger, default=0)
    blocked: Mapped[bool] = mapped_column(Boolean, default=False)


class BetaReservation(BetaBase):
    __tablename__ = "beta_quota_reservations"
    __table_args__ = (
        CheckConstraint(
            "state IN ('reserved','dispatched','released','settled')", name="state_valid"
        ),
        CheckConstraint(
            "ceiling_microusd > 0 AND ceiling_microusd <= 1000000000", name="cost_bound"
        ),
        CheckConstraint(
            "input_bytes_limit > 0 AND output_tokens_limit > 0", name="input_output_bound"
        ),
        Index("ix_beta_reservation_owner_day_state", "owner_id", "day", "state"),
    )
    generation_id: Mapped[UUID] = mapped_column(primary_key=True)
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("beta_quota_accounts.owner_id"))
    day: Mapped[date] = mapped_column(ForeignKey("beta_quota_days.day"))
    provider: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(100))
    pricing_version: Mapped[str] = mapped_column(String(60))
    ceiling_microusd: Mapped[int] = mapped_column(BigInteger)
    input_bytes_limit: Mapped[int]
    output_tokens_limit: Mapped[int]
    state: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str | None] = mapped_column(String(16))
    input_tokens: Mapped[int | None]
    output_tokens: Mapped[int | None]


class BetaQuotaEvent(BetaBase):
    __tablename__ = "beta_quota_events"
    __table_args__ = (
        UniqueConstraint("generation_id", "kind"),
        CheckConstraint(
            "kind IN ('reserved','dispatched','released','settled')", name="kind_valid"
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    generation_id: Mapped[UUID] = mapped_column(ForeignKey("beta_quota_reservations.generation_id"))
    kind: Mapped[str] = mapped_column(String(16))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    budget_delta_microusd: Mapped[int] = mapped_column(BigInteger)
