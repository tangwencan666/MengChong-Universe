"""Add single-use password recovery records; preserve all existing rows.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "password_resets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_password_resets")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_password_resets_user_id_users")
        ),
        sa.UniqueConstraint("token_hash", name=op.f("uq_password_resets_token_hash")),
        sa.CheckConstraint("expires_at > created_at", name=op.f("ck_password_resets_expiry_valid")),
    )
    op.create_index("ix_password_resets_user_id", "password_resets", ["user_id"])
    op.create_index("ix_password_resets_expires_at", "password_resets", ["expires_at"])


def downgrade():
    raise RuntimeError("Password recovery migration is forward-only; downgrade is prohibited")
