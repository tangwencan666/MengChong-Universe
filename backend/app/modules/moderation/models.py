from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Entity


class ModerationAction(Entity, Base):
    __tablename__ = "moderation_actions"
    __table_args__ = (
        CheckConstraint("action IN ('hide','restore','dismiss','warn')", name="action_valid"),
        Index("ix_moderation_actions_report_id_created_at", "report_id", "created_at"),
    )
    report_id: Mapped[UUID] = mapped_column(ForeignKey("reports.id"))
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str] = mapped_column(Text)
