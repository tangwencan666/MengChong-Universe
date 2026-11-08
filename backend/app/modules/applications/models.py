from datetime import date
from uuid import UUID

from sqlalchemy import CheckConstraint, Date, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Entity


class JobApplication(Entity, Base):
    __tablename__ = "job_applications"
    __table_args__ = (
        CheckConstraint(
            "stage IN ('saved','applied','interview','offer','rejected','withdrawn')",
            name="stage_valid",
        ),
        Index("ix_job_applications_owner_id_stage", "owner_id", "stage"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    company: Mapped[str] = mapped_column(String(120))
    position: Mapped[str] = mapped_column(String(120))
    stage: Mapped[str] = mapped_column(String(20), server_default="saved")
    applied_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
