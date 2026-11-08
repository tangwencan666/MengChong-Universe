from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Entity


class User(Entity, Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("email = lower(email)", name="email_normalized"),
        CheckConstraint("role IN ('user','moderator','admin')", name="role_valid"),
        CheckConstraint("status IN ('active','disabled')", name="status_valid"),
    )
    email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(60))
    role: Mapped[str] = mapped_column(String(20), server_default="user")
    status: Mapped[str] = mapped_column(String(20), server_default="active")
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
