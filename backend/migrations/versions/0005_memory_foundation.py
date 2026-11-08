"""Add explicit memory authorization without activating legacy facts.

Revision ID: 0005
Revises: 0004
This is a fixed schema snapshot, not an import of runtime models. Forward-only.
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def _upgrade():
    with op.batch_alter_table("memories") as batch:
        batch.add_column(sa.Column("title", sa.String(80), nullable=False, server_default=""))
        batch.add_column(sa.Column("summary", sa.String(240), nullable=False, server_default=""))
        batch.add_column(sa.Column("category", sa.String(40), nullable=True))
        batch.add_column(
            sa.Column("status", sa.String(20), nullable=False, server_default="legacy_unconfirmed")
        )
        batch.add_column(sa.Column("version", sa.Integer(), nullable=False, server_default="1"))
        batch.add_column(sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("active_consent_id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("corrected_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_check_constraint(
            op.f("ck_memories_active_complete"),
            "status <> 'active' OR (length(content) BETWEEN 1 AND 1000 AND length(title) "
            "BETWEEN 1 AND 80 AND category IS NOT NULL AND expires_at IS NOT NULL AND "
            "active_consent_id IS NOT NULL AND deleted_at IS NULL AND consent_revoked_at IS "
            "NULL)",
        )
        batch.create_check_constraint(
            op.f("ck_memories_category_valid"),
            "category IS NULL OR category IN "
            "('career_goal','communication_preference','experience','open_topic','explicit_note')",
        )
        batch.create_check_constraint(
            op.f("ck_memories_deleted_content_erased"),
            "status <> 'deleted' OR (content = '' AND title = '' AND summary = '' AND "
            "active_consent_id IS NULL AND deleted_at IS NOT NULL)",
        )
        batch.create_check_constraint(
            op.f("ck_memories_grant_state_valid"), "status = 'active' OR active_consent_id IS NULL"
        )
        batch.create_check_constraint(
            op.f("ck_memories_status_valid"),
            "status IN ('active','revoked','expired','deleted','legacy_unconfirmed')",
        )
        batch.create_check_constraint(op.f("ck_memories_summary_bounded"), "length(summary) <= 240")
        batch.create_check_constraint(
            op.f("ck_memories_version_valid"), "version BETWEEN 1 AND 2147483647"
        )
        batch.create_unique_constraint(op.f("uq_memories_id_owner_id"), ["id", "owner_id"])
        batch.create_index(
            "ix_memories_owner_status_expiry", ["owner_id", "status", "expires_at", "id"]
        )
        batch.create_index("ix_memories_owner_updated", ["owner_id", "updated_at", "id"])

    op.add_column("chat_generations", sa.Column("memory_epoch", sa.BigInteger(), nullable=True))
    op.add_column(
        "chat_generations",
        sa.Column("memory_context_not_before", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "chat_generations",
        sa.Column("memory_snapshot_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "memory_preferences",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "long_term_memory_enabled", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("privacy_epoch", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("context_epoch_floor", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("context_not_before", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_revision", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "privacy_epoch >= 0 AND context_epoch_floor >= 0 AND context_epoch_floor <= "
            "privacy_epoch AND last_revision >= 0",
            name=op.f("ck_memory_preferences_epoch_revision_valid"),
        ),
        sa.CheckConstraint(
            "version BETWEEN 1 AND 2147483647", name=op.f("ck_memory_preferences_version_valid")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_memory_preferences_user_id_users")
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_memory_preferences")),
    )

    op.create_table(
        "memory_consent_events",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("memory_id", sa.Uuid(), nullable=True),
        sa.Column("memory_version", sa.Integer(), nullable=True),
        sa.Column("affected_all", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("policy_version", sa.String(60), nullable=True),
        sa.Column("notice_version", sa.String(60), nullable=True),
        sa.Column("origin_client", sa.String(30), nullable=False, server_default="web"),
        sa.Column("actor_session_id", sa.Uuid(), nullable=True),
        sa.Column(
            "occurred_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("privacy_epoch", sa.BigInteger(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "action IN "
            "('enabled','disabled','confirmed','corrected','revoked','deleted','expired','source_invalidated')",
            name=op.f("ck_memory_consent_events_action_valid"),
        ),
        sa.CheckConstraint(
            "action NOT IN ('confirmed','corrected') OR (memory_id IS NOT NULL AND "
            "policy_version IS NOT NULL AND notice_version IS NOT NULL)",
            name=op.f("ck_memory_consent_events_confirmation_complete"),
        ),
        sa.CheckConstraint(
            "(memory_id IS NULL AND memory_version IS NULL) OR (memory_id IS NOT NULL AND "
            "memory_version IS NOT NULL AND memory_version BETWEEN 1 AND 2147483647)",
            name=op.f("ck_memory_consent_events_memory_identity_complete"),
        ),
        sa.CheckConstraint(
            "revision >= 1 AND privacy_epoch >= 0",
            name=op.f("ck_memory_consent_events_revision_epoch_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["memory_id", "owner_id"],
            ["memories.id", "memories.owner_id"],
            name=op.f("fk_memory_consent_events_memory_id_owner_id_memories"),
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_memory_consent_events_owner_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_memory_consent_events")),
        sa.UniqueConstraint(
            "id",
            "memory_id",
            "owner_id",
            "memory_version",
            name=op.f("uq_memory_consent_events_id_memory_id_owner_id_memory_version"),
        ),
        sa.UniqueConstraint(
            "owner_id", "revision", name=op.f("uq_memory_consent_events_owner_id_revision")
        ),
    )
    op.create_index(
        "ix_memory_consent_events_owner_revision",
        "memory_consent_events",
        ["owner_id", "revision"],
        unique=False,
    )

    op.create_table(
        "memory_sources",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("memory_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("source_message_version", sa.Integer(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "(kind = 'manual' AND session_id IS NULL AND message_id IS NULL AND "
            "source_message_version IS NULL) OR (kind = 'chat_message' AND session_id IS NOT "
            "NULL AND message_id IS NOT NULL AND source_message_version IS NOT NULL AND "
            "source_message_version >= 1)",
            name=op.f("ck_memory_sources_source_shape_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["memory_id", "owner_id"],
            ["memories.id", "memories.owner_id"],
            name=op.f("fk_memory_sources_memory_id_owner_id_memories"),
        ),
        sa.ForeignKeyConstraint(
            ["message_id", "session_id", "owner_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
            name=op.f("fk_memory_sources_message_id_session_id_owner_id_chat_messages"),
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_memory_sources_owner_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_memory_sources")),
        sa.UniqueConstraint(
            "memory_id", "message_id", name=op.f("uq_memory_sources_memory_id_message_id")
        ),
    )
    op.create_index(
        "ix_memory_sources_owner_memory", "memory_sources", ["owner_id", "memory_id"], unique=False
    )
    op.create_index(
        "ix_memory_sources_owner_session",
        "memory_sources",
        ["owner_id", "session_id", "memory_id"],
        unique=False,
    )
    op.create_index(
        "uq_memory_sources_manual",
        "memory_sources",
        ["memory_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'manual'"),
        sqlite_where=sa.text("kind = 'manual'"),
    )

    op.create_table(
        "memory_generation_refs",
        sa.Column("generation_id", sa.Uuid(), nullable=False),
        sa.Column("memory_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("memory_version", sa.Integer(), nullable=False),
        sa.Column("grant_event_id", sa.Uuid(), nullable=False),
        sa.Column("privacy_epoch", sa.BigInteger(), nullable=False),
        sa.Column("used_tokens", sa.Integer(), nullable=False),
        sa.Column("counter_version", sa.String(60), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "memory_version BETWEEN 1 AND 2147483647 AND privacy_epoch >= 0 AND used_tokens >= "
            "0 AND rank BETWEEN 1 AND 5",
            name=op.f("ck_memory_generation_refs_reference_bounds_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["generation_id", "session_id", "owner_id"],
            ["chat_generations.id", "chat_generations.session_id", "chat_generations.owner_id"],
            name=op.f(
                "fk_memory_generation_refs_generation_id_session_id_owner_id_chat_generations"
            ),
        ),
        sa.ForeignKeyConstraint(
            ["grant_event_id", "memory_id", "owner_id", "memory_version"],
            [
                "memory_consent_events.id",
                "memory_consent_events.memory_id",
                "memory_consent_events.owner_id",
                "memory_consent_events.memory_version",
            ],
            name=op.f(
                "fk_memory_generation_refs_grant_event_id_memory_id_owner_id_memory_version_memory_consent_events"
            ),
        ),
        sa.ForeignKeyConstraint(
            ["memory_id", "owner_id"],
            ["memories.id", "memories.owner_id"],
            name=op.f("fk_memory_generation_refs_memory_id_owner_id_memories"),
        ),
        sa.PrimaryKeyConstraint(
            "generation_id", "memory_id", name=op.f("pk_memory_generation_refs")
        ),
    )
    op.create_index(
        "ix_memory_generation_refs_owner_memory",
        "memory_generation_refs",
        ["owner_id", "memory_id", "generation_id"],
        unique=False,
    )

    op.create_table(
        "memory_operations",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("operation_scope", sa.String(80), nullable=False),
        sa.Column("idempotency_key", sa.String(120), nullable=False),
        sa.Column("request_fingerprint", sa.String(64), nullable=False),
        sa.Column("fingerprint_key_version", sa.String(30), nullable=False),
        sa.Column("target_memory_id", sa.Uuid(), nullable=True),
        sa.Column("result_code", sa.String(60), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "length(request_fingerprint) = 64", name=op.f("ck_memory_operations_fingerprint_valid")
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_memory_operations_owner_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["target_memory_id", "owner_id"],
            ["memories.id", "memories.owner_id"],
            name=op.f("fk_memory_operations_target_memory_id_owner_id_memories"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_memory_operations")),
        sa.UniqueConstraint(
            "owner_id",
            "operation_scope",
            "idempotency_key",
            name=op.f("uq_memory_operations_owner_id_operation_scope_idempotency_key"),
        ),
    )
    op.create_index(
        "ix_memory_operations_owner_target",
        "memory_operations",
        ["owner_id", "target_memory_id"],
        unique=False,
    )

    with op.batch_alter_table("memories") as batch:
        batch.create_foreign_key(
            op.f("fk_memories_active_consent_id_id_owner_id_version_memory_consent_events"),
            "memory_consent_events",
            ["active_consent_id", "id", "owner_id", "version"],
            ["id", "memory_id", "owner_id", "memory_version"],
        )


def upgrade():
    if op.get_context().dialect.name != "sqlite":
        _upgrade()
        return
    # SQLite implements ALTER by a local table copy; preserve all original rows and
    # validate references before/after. PostgreSQL uses only forward ALTER/CREATE.
    with op.get_context().autocommit_block():
        connection = op.get_bind()
        if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
            raise RuntimeError("Existing associations are invalid; memory migration refused")
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        try:
            _upgrade()
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
            raise RuntimeError("Memory migration found invalid foreign-key associations")


def downgrade():
    raise NotImplementedError("Memory foundation is forward-only; downgrade is prohibited")
