"""Persist private chat tasks and replay events without discarding historical rows.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def _entity_columns():
    return (
        sa.Column("id", sa.Uuid(), nullable=False, primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def _partial_index(name, table, columns, predicate):
    op.create_index(
        name,
        table,
        columns,
        unique=True,
        sqlite_where=sa.text(predicate),
        postgresql_where=sa.text(predicate),
    )


def _upgrade():
    op.add_column(
        "ai_companions",
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _partial_index("uq_ai_companions_default_owner", "ai_companions", ["owner_id"], "is_default")

    # Add nullable first, backfill from existing records, then enforce the new invariants.
    for column in (
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("next_message_sequence", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("create_key", sa.String(120), nullable=True),
        sa.Column("create_fingerprint", sa.String(64), nullable=True),
    ):
        op.add_column("chat_sessions", column)
    op.execute(
        sa.text(
            "UPDATE chat_sessions SET last_message_at = "
            "(SELECT MAX(created_at) FROM chat_messages "
            "WHERE chat_messages.session_id = chat_sessions.id "
            "AND chat_messages.owner_id = chat_sessions.owner_id), "
            "next_message_sequence = COALESCE((SELECT MAX(sequence) + 1 FROM chat_messages "
            "WHERE chat_messages.session_id = chat_sessions.id "
            "AND chat_messages.owner_id = chat_sessions.owner_id), 0)"
        )
    )
    op.execute(
        sa.text("UPDATE chat_sessions SET last_activity_at = COALESCE(last_message_at, created_at)")
    )
    with op.batch_alter_table("chat_sessions") as batch:
        batch.alter_column(
            "last_activity_at",
            existing_type=sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        )
        batch.create_unique_constraint(
            "uq_chat_sessions_owner_id_create_key", ["owner_id", "create_key"]
        )
        batch.create_check_constraint("version_positive", "version >= 1")
        batch.create_check_constraint("next_sequence_nonnegative", "next_message_sequence >= 0")
        batch.create_check_constraint(
            "create_identity_complete",
            "(create_key IS NULL AND create_fingerprint IS NULL) OR "
            "(create_key IS NOT NULL AND create_fingerprint IS NOT NULL)",
        )
    op.create_index(
        "ix_chat_sessions_owner_activity_visible",
        "chat_sessions",
        ["owner_id", "last_activity_at", "id"],
        sqlite_where=sa.text("deleted_at IS NULL"),
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    op.add_column("chat_messages", sa.Column("client_message_id", sa.Uuid(), nullable=True))
    op.add_column(
        "chat_messages",
        sa.Column("status", sa.String(20), nullable=False, server_default="completed"),
    )
    op.add_column(
        "chat_messages", sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(sa.text("UPDATE chat_messages SET completed_at = created_at"))
    with op.batch_alter_table("chat_messages") as batch:
        batch.alter_column("provider", existing_type=sa.String(40), nullable=True)
        batch.create_unique_constraint(
            "uq_chat_messages_id_session_id_owner_id", ["id", "session_id", "owner_id"]
        )
        batch.create_unique_constraint(
            "uq_chat_messages_owner_id_session_id_client_message_id",
            ["owner_id", "session_id", "client_message_id"],
        )
        # Historical system rows and user provider metadata remain valid and unchanged.
        batch.create_check_constraint(
            "role_status_valid",
            "(role IN ('user','system') AND status = 'completed') OR "
            "(role = 'assistant' AND status IN "
            "('queued','streaming','completed','failed','cancelled'))",
        )
        batch.create_check_constraint(
            "client_message_role_valid", "client_message_id IS NULL OR role = 'user'"
        )

    op.create_table(
        "chat_generations",
        *_entity_columns(),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("user_message_id", sa.Uuid(), nullable=False),
        sa.Column("assistant_message_id", sa.Uuid(), nullable=False),
        sa.Column("retry_of_generation_id", sa.Uuid(), nullable=True),
        sa.Column("operation", sa.String(10), nullable=False),
        sa.Column("idempotency_key", sa.String(120), nullable=False),
        sa.Column("request_fingerprint", sa.String(64), nullable=False),
        sa.Column("state", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("provider", sa.String(40), nullable=False),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("prompt_version", sa.String(30), nullable=False),
        sa.Column("context_message_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_event_sequence", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_code", sa.String(80), nullable=True),
        sa.Column("error_message", sa.String(240), nullable=True),
        sa.Column("usage", sa.JSON(none_as_null=True), nullable=True),
        sa.UniqueConstraint("id", "session_id", "owner_id"),
        sa.UniqueConstraint("id", "session_id", "owner_id", "user_message_id"),
        sa.UniqueConstraint("assistant_message_id"),
        sa.UniqueConstraint("owner_id", "session_id", "operation", "idempotency_key"),
        sa.ForeignKeyConstraint(
            ["session_id", "owner_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        sa.ForeignKeyConstraint(
            ["user_message_id", "session_id", "owner_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
        ),
        sa.ForeignKeyConstraint(
            ["assistant_message_id", "session_id", "owner_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
        ),
        sa.ForeignKeyConstraint(
            ["retry_of_generation_id", "session_id", "owner_id", "user_message_id"],
            [
                "chat_generations.id",
                "chat_generations.session_id",
                "chat_generations.owner_id",
                "chat_generations.user_message_id",
            ],
        ),
        sa.CheckConstraint(
            "state IN ('queued','running','cancel_requested','completed','failed','cancelled')",
            name="state_valid",
        ),
        sa.CheckConstraint(
            "(operation = 'send' AND retry_of_generation_id IS NULL) OR "
            "(operation = 'retry' AND retry_of_generation_id IS NOT NULL)",
            name="operation_valid",
        ),
        sa.CheckConstraint("user_message_id <> assistant_message_id", name="messages_distinct"),
        sa.CheckConstraint("lease_version >= 0", name="lease_version_nonnegative"),
        sa.CheckConstraint("last_event_sequence >= 0", name="event_sequence_nonnegative"),
        sa.CheckConstraint(
            "(state IN ('completed','failed','cancelled') AND finished_at IS NOT NULL) OR "
            "(state IN ('queued','running','cancel_requested') AND finished_at IS NULL)",
            name="finished_state_valid",
        ),
        sa.CheckConstraint(
            "(state = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL) OR "
            "(state <> 'failed' AND error_code IS NULL AND error_message IS NULL)",
            name="error_state_valid",
        ),
    )
    _partial_index(
        "uq_chat_generations_active_session",
        "chat_generations",
        ["session_id"],
        "state IN ('queued','running','cancel_requested')",
    )
    op.create_index(
        "ix_chat_generations_state_lease", "chat_generations", ["state", "lease_expires_at"]
    )
    op.create_index("ix_chat_generations_owner_state", "chat_generations", ["owner_id", "state"])
    op.create_index(
        "ix_chat_generations_owner_finished", "chat_generations", ["owner_id", "finished_at"]
    )

    op.create_table(
        "chat_generation_events",
        *_entity_columns(),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("generation_id", sa.Uuid(), nullable=False),
        sa.Column("event_sequence", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column(
            "occurred_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("generation_id", "event_sequence"),
        sa.ForeignKeyConstraint(
            ["generation_id", "session_id", "owner_id"],
            ["chat_generations.id", "chat_generations.session_id", "chat_generations.owner_id"],
        ),
        sa.CheckConstraint("event_sequence >= 1", name="event_sequence_positive"),
        sa.CheckConstraint(
            "event_type IN ('start','delta','completed','error','cancelled')",
            name="event_type_valid",
        ),
        sa.CheckConstraint(
            "(event_type = 'start' AND event_sequence = 1) OR "
            "(event_type <> 'start' AND event_sequence > 1)",
            name="start_sequence_valid",
        ),
    )
    _partial_index(
        "uq_chat_generation_events_terminal",
        "chat_generation_events",
        ["generation_id"],
        "event_type IN ('completed','error','cancelled')",
    )
    op.create_index(
        "ix_chat_generation_events_occurred_at", "chat_generation_events", ["occurred_at"]
    )
    op.create_index(
        "ix_chat_generation_events_owner_replay",
        "chat_generation_events",
        ["owner_id", "generation_id", "event_sequence"],
    )

    op.create_table(
        "chat_preferences",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("recent_topic_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("consented_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_session_id", sa.Uuid(), nullable=True),
        sa.Column("source_message_id", sa.Uuid(), nullable=True),
        sa.Column("summary_version", sa.String(200), nullable=True),
        sa.ForeignKeyConstraint(
            ["dismissed_session_id", "user_id"], ["chat_sessions.id", "chat_sessions.owner_id"]
        ),
        sa.ForeignKeyConstraint(
            ["source_message_id", "dismissed_session_id", "user_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
        ),
        sa.CheckConstraint("version >= 1", name="version_positive"),
        sa.CheckConstraint(
            "(dismissed_session_id IS NULL AND source_message_id IS NULL "
            "AND summary_version IS NULL) OR (dismissed_session_id IS NOT NULL "
            "AND source_message_id IS NOT NULL AND summary_version IS NOT NULL)",
            name="dismissal_complete",
        ),
    )


def upgrade():
    if op.get_context().dialect.name != "sqlite":
        _upgrade()
        return
    # SQLite table-copy ALTER needs references temporarily disabled on this connection.
    # Its autocommit block makes PRAGMA effective before a transaction can begin.
    with op.get_context().autocommit_block():
        connection = op.get_bind()
        if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
            raise RuntimeError("Existing chat associations are invalid; migration refused")
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        try:
            _upgrade()
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        if connection.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
            raise RuntimeError("Chat migration found invalid foreign-key associations")


def downgrade():
    raise RuntimeError("Chat persistence migration is forward-only; downgrade is prohibited")
