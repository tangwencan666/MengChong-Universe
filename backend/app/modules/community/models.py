from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Entity


class Post(Entity, Base):
    __tablename__ = "posts"
    __table_args__ = (
        CheckConstraint("length(title) > 0 AND length(body) > 0", name="content_nonempty"),
        CheckConstraint(
            "status IN ('pending','published','hidden','deleted')", name="status_valid"
        ),
        Index("ix_posts_status_created_at", "status", "created_at"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(30), server_default="general")
    status: Mapped[str] = mapped_column(String(20), server_default="pending")
    comments: Mapped[list["Comment"]] = relationship(back_populates="post", lazy="raise")


class Comment(Entity, Base):
    __tablename__ = "comments"
    __table_args__ = (
        CheckConstraint("length(body) > 0", name="body_nonempty"),
        CheckConstraint(
            "status IN ('pending','published','hidden','deleted')", name="status_valid"
        ),
        Index("ix_comments_post_id_created_at", "post_id", "created_at"),
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    post_id: Mapped[UUID] = mapped_column(ForeignKey("posts.id"))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), server_default="pending")
    post: Mapped[Post] = relationship(back_populates="comments", lazy="raise")


class PostLike(Entity, Base):
    __tablename__ = "post_likes"
    __table_args__ = (UniqueConstraint("post_id", "owner_id"),)
    post_id: Mapped[UUID] = mapped_column(ForeignKey("posts.id"))
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)


class Report(Entity, Base):
    __tablename__ = "reports"
    __table_args__ = (
        CheckConstraint(
            "(post_id IS NOT NULL AND comment_id IS NULL) OR "
            "(post_id IS NULL AND comment_id IS NOT NULL)",
            name="one_target",
        ),
        CheckConstraint("status IN ('open','reviewed','dismissed')", name="status_valid"),
        Index("ix_reports_status_created_at", "status", "created_at"),
    )
    reporter_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    post_id: Mapped[UUID | None] = mapped_column(ForeignKey("posts.id"), index=True)
    comment_id: Mapped[UUID | None] = mapped_column(ForeignKey("comments.id"), index=True)
    reason: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), server_default="open")
