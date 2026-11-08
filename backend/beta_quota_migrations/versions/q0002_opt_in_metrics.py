"""Minimal opt-in pseudonymous events; no chat, credentials, IP or device fingerprint."""

import sqlalchemy as sa
from alembic import op

revision = "q0002"
down_revision = "q0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "beta_telemetry_consents",
        sa.Column("owner_id", sa.Uuid(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("subject", sa.String(64), unique=True),
        sa.Column("cohort_day", sa.Date()),
        sa.Column("policy_version", sa.String(30), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "beta_telemetry_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("subject", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("cohort_day", sa.Date(), nullable=False),
        sa.Column("dedupe_key", sa.String(64), nullable=False, unique=True),
        sa.Column("attempt_hash", sa.String(64)),
        sa.CheckConstraint(
            "kind IN ('enrolled','active','interaction_mock','interaction_real',"
            "'install_attempt','install_success','fault_network','fault_startup','fault_renderer')",
            name="kind_valid",
        ),
    )
    op.create_index("ix_beta_telemetry_subject", "beta_telemetry_events", ["subject"])


def downgrade():
    op.drop_table("beta_telemetry_events")
    op.drop_table("beta_telemetry_consents")
