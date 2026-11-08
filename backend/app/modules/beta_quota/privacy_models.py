from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.beta_quota.models import BetaBase


class BetaConsent(BetaBase):
    __tablename__ = "beta_telemetry_consents"
    owner_id: Mapped[UUID] = mapped_column(primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean)
    subject: Mapped[str | None] = mapped_column(String(64), unique=True)
    cohort_day: Mapped[date | None] = mapped_column(Date)
    policy_version: Mapped[str] = mapped_column(String(30))
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class BetaTelemetryEvent(BetaBase):
    __tablename__ = "beta_telemetry_events"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('enrolled','active','interaction_mock','interaction_real',"
            "'install_attempt','install_success','fault_network','fault_startup','fault_renderer')",
            name="kind_valid",
        ),
        Index("ix_beta_telemetry_subject", "subject"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    subject: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(24))
    day: Mapped[date] = mapped_column(Date)
    cohort_day: Mapped[date] = mapped_column(Date)
    dedupe_key: Mapped[str] = mapped_column(String(64), unique=True)
    attempt_hash: Mapped[str | None] = mapped_column(String(64))
