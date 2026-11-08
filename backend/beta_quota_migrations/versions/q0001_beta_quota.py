"""Independent beta quota schema. Does not change the chat migration lineage."""

import sqlalchemy as sa
from alembic import op

revision = "q0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "beta_invitations",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column("grant_requests", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("grant_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("claimed_by", sa.Uuid(), unique=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("grant_requests > 0 AND grant_requests <= 10000", name="grant_bound"),
    )
    op.create_table(
        "beta_quota_accounts",
        sa.Column("owner_id", sa.Uuid(), primary_key=True),
        sa.Column("granted", sa.Integer(), nullable=False),
        sa.Column("reserved", sa.Integer(), nullable=False),
        sa.Column("spent", sa.Integer(), nullable=False),
        sa.Column("active", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("granted > 0 AND granted <= 10000", name="grant_bound"),
        sa.CheckConstraint("reserved >= 0 AND spent >= 0 AND active >= 0", name="nonnegative"),
        sa.CheckConstraint(
            "reserved + spent <= granted AND active <= reserved", name="grant_limit"
        ),
    )
    op.create_table(
        "beta_quota_days",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("reserved_requests", sa.Integer(), nullable=False),
        sa.Column("spent_requests", sa.Integer(), nullable=False),
        sa.Column("reserved_cost", sa.BigInteger(), nullable=False),
        sa.Column("spent_cost", sa.BigInteger(), nullable=False),
        sa.Column("blocked", sa.Boolean(), nullable=False),
        sa.CheckConstraint(
            "reserved_requests >= 0 AND spent_requests >= 0", name="request_nonnegative"
        ),
        sa.CheckConstraint("reserved_cost >= 0 AND spent_cost >= 0", name="cost_nonnegative"),
    )
    op.create_table(
        "beta_quota_reservations",
        sa.Column("generation_id", sa.Uuid(), primary_key=True),
        sa.Column(
            "owner_id", sa.Uuid(), sa.ForeignKey("beta_quota_accounts.owner_id"), nullable=False
        ),
        sa.Column("day", sa.Date(), sa.ForeignKey("beta_quota_days.day"), nullable=False),
        sa.Column("provider", sa.String(40), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("pricing_version", sa.String(60), nullable=False),
        sa.Column("ceiling_microusd", sa.BigInteger(), nullable=False),
        sa.Column("input_bytes_limit", sa.Integer(), nullable=False),
        sa.Column("output_tokens_limit", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("outcome", sa.String(16)),
        sa.Column("input_tokens", sa.Integer()),
        sa.Column("output_tokens", sa.Integer()),
        sa.CheckConstraint(
            "state IN ('reserved','dispatched','released','settled')", name="state_valid"
        ),
        sa.CheckConstraint(
            "ceiling_microusd > 0 AND ceiling_microusd <= 1000000000", name="cost_bound"
        ),
        sa.CheckConstraint(
            "input_bytes_limit > 0 AND output_tokens_limit > 0", name="input_output_bound"
        ),
    )
    op.create_index(
        "ix_beta_reservation_owner_day_state",
        "beta_quota_reservations",
        ["owner_id", "day", "state"],
    )
    op.create_table(
        "beta_quota_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "generation_id",
            sa.Uuid(),
            sa.ForeignKey("beta_quota_reservations.generation_id"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("budget_delta_microusd", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("generation_id", "kind"),
        sa.CheckConstraint(
            "kind IN ('reserved','dispatched','released','settled')", name="kind_valid"
        ),
    )


def downgrade():
    for name in [
        "beta_quota_events",
        "beta_quota_reservations",
        "beta_quota_days",
        "beta_quota_accounts",
        "beta_invitations",
    ]:
        op.drop_table(name)
