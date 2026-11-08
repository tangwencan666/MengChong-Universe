"""Add durable authentication sessions and one-time email verification metadata.

Revision ID: 0002
Revises: 0001
Forward-only. Existing business tables and rows are preserved.
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def entity_columns():
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade():
    op.add_column(
        "users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "auth_sessions",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("csrf_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        *entity_columns(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_auth_sessions")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_auth_sessions_user_id_users")
        ),
        sa.UniqueConstraint("token_hash", name=op.f("uq_auth_sessions_token_hash")),
        sa.CheckConstraint("expires_at > created_at", name=op.f("ck_auth_sessions_expiry_valid")),
    )
    op.create_index(
        "ix_auth_sessions_user_id_expires_at", "auth_sessions", ["user_id", "expires_at"]
    )
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])
    op.create_table(
        "email_verifications",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        *entity_columns(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_verifications")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_email_verifications_user_id_users")
        ),
        sa.UniqueConstraint("token_hash", name=op.f("uq_email_verifications_token_hash")),
        sa.CheckConstraint(
            "expires_at > created_at", name=op.f("ck_email_verifications_expiry_valid")
        ),
    )
    op.create_index("ix_email_verifications_user_id", "email_verifications", ["user_id"])
    op.create_index("ix_email_verifications_expires_at", "email_verifications", ["expires_at"])


def downgrade():
    raise RuntimeError("Forward-only authentication migration; downgrade is prohibited")
