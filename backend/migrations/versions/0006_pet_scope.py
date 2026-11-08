"""Add explicit pet identities without changing or attributing legacy data.

Revision ID: 0006
Revises: 0005
Fixed, additive schema snapshot. No runtime model import; forward-only.
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "pets",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("companion_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("role_type", sa.String(length=40), nullable=False),
        sa.Column("persona_config", sa.JSON(), nullable=False),
        sa.Column("appearance_config", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("create_key", sa.String(length=120), nullable=False),
        sa.Column("create_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "length(create_fingerprint) = 64", name=op.f("ck_pets_fingerprint_valid")
        ),
        sa.CheckConstraint("length(name) BETWEEN 1 AND 60", name=op.f("ck_pets_name_bounded")),
        sa.CheckConstraint("length(role_type) BETWEEN 1 AND 40", name=op.f("ck_pets_role_bounded")),
        sa.CheckConstraint(
            "status IN ('active','hidden','archived')", name=op.f("ck_pets_status_valid")
        ),
        sa.CheckConstraint("version BETWEEN 1 AND 2147483647", name=op.f("ck_pets_version_valid")),
        sa.ForeignKeyConstraint(
            ["companion_id", "owner_id"],
            ["ai_companions.id", "ai_companions.owner_id"],
            name=op.f("fk_pets_companion_id_owner_id_ai_companions"),
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name=op.f("fk_pets_owner_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pets")),
        sa.UniqueConstraint("companion_id", name=op.f("uq_pets_companion_id")),
        sa.UniqueConstraint("id", "owner_id", name=op.f("uq_pets_id_owner_id")),
        sa.UniqueConstraint("owner_id", "create_key", name=op.f("uq_pets_owner_id_create_key")),
    )
    op.create_index(
        "ix_pets_owner_status_created",
        "pets",
        ["owner_id", "status", "created_at", "id"],
        unique=False,
    )

    op.create_table(
        "pet_chat_bindings",
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("pet_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pet_id", "owner_id"],
            ["pets.id", "pets.owner_id"],
            name=op.f("fk_pet_chat_bindings_pet_id_owner_id_pets"),
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "owner_id"],
            ["chat_sessions.id", "chat_sessions.owner_id"],
            name=op.f("fk_pet_chat_bindings_session_id_owner_id_chat_sessions"),
        ),
        sa.PrimaryKeyConstraint("session_id", name=op.f("pk_pet_chat_bindings")),
        sa.UniqueConstraint(
            "session_id",
            "owner_id",
            "pet_id",
            name=op.f("uq_pet_chat_bindings_session_id_owner_id_pet_id"),
        ),
    )
    op.create_index(
        "ix_pet_chat_bindings_owner_pet",
        "pet_chat_bindings",
        ["owner_id", "pet_id", "session_id"],
        unique=False,
    )

    op.create_table(
        "pet_generation_contexts",
        sa.Column("generation_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("pet_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("persona_version", sa.Integer(), nullable=False),
        sa.Column("persona_snapshot", sa.JSON(), nullable=False),
        sa.Column("memory_epoch", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("context_not_before", sa.DateTime(timezone=True), nullable=True),
        sa.Column("memory_refs", sa.JSON(), nullable=False, server_default="[]"),
        sa.CheckConstraint(
            "persona_version >= 1 AND memory_epoch >= 0",
            name=op.f("ck_pet_generation_contexts_versions_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["generation_id", "session_id", "owner_id"],
            ["chat_generations.id", "chat_generations.session_id", "chat_generations.owner_id"],
            name=op.f(
                "fk_pet_generation_contexts_generation_id_session_id_owner_id_chat_generations"
            ),
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "owner_id", "pet_id"],
            [
                "pet_chat_bindings.session_id",
                "pet_chat_bindings.owner_id",
                "pet_chat_bindings.pet_id",
            ],
            name=op.f("fk_pet_generation_contexts_session_id_owner_id_pet_id_pet_chat_bindings"),
        ),
        sa.PrimaryKeyConstraint("generation_id", name=op.f("pk_pet_generation_contexts")),
    )
    op.create_index(
        "ix_pet_generation_contexts_owner_pet",
        "pet_generation_contexts",
        ["owner_id", "pet_id", "generation_id"],
        unique=False,
    )

    op.create_table(
        "pet_memory_preferences",
        sa.Column("pet_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
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
            (
                "privacy_epoch >= 0 AND context_epoch_floor >= 0 AND context_epoch_floo"
                "r <= privacy_epoch AND last_revision >= 0"
            ),
            name=op.f("ck_pet_memory_preferences_epoch_revision_valid"),
        ),
        sa.CheckConstraint(
            "version BETWEEN 1 AND 2147483647", name=op.f("ck_pet_memory_preferences_version_valid")
        ),
        sa.ForeignKeyConstraint(
            ["pet_id", "owner_id"],
            ["pets.id", "pets.owner_id"],
            name=op.f("fk_pet_memory_preferences_pet_id_owner_id_pets"),
        ),
        sa.PrimaryKeyConstraint("pet_id", name=op.f("pk_pet_memory_preferences")),
    )

    op.create_table(
        "pet_memories",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("pet_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=80), nullable=False, server_default=""),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("summary", sa.String(length=240), nullable=False, server_default=""),
        sa.Column("category", sa.String(length=40), nullable=True),
        sa.Column(
            "status", sa.String(length=20), nullable=False, server_default="legacy_unconfirmed"
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consent_granted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consent_revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active_consent_id", sa.Uuid(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("corrected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            (
                "status <> 'active' OR (length(content) BETWEEN 1 AND 1000 AND length(t"
                "itle) BETWEEN 1 AND 80 AND category IS NOT NULL AND expires_at IS NOT "
                "NULL AND active_consent_id IS NOT NULL AND deleted_at IS NULL AND cons"
                "ent_revoked_at IS NULL)"
            ),
            name=op.f("ck_pet_memories_active_complete"),
        ),
        sa.CheckConstraint(
            (
                "category IS NULL OR category IN ('career_goal','communication_preferen"
                "ce','experience','open_topic','explicit_note')"
            ),
            name=op.f("ck_pet_memories_category_valid"),
        ),
        sa.CheckConstraint(
            (
                "consent_granted_at IS NOT NULL AND (consent_revoked_at IS NULL OR cons"
                "ent_revoked_at >= consent_granted_at)"
            ),
            name=op.f("ck_pet_memories_consent_valid"),
        ),
        sa.CheckConstraint(
            (
                "status <> 'deleted' OR (content = '' AND title = '' AND summary = '' A"
                "ND active_consent_id IS NULL AND deleted_at IS NOT NULL)"
            ),
            name=op.f("ck_pet_memories_deleted_content_erased"),
        ),
        sa.CheckConstraint(
            "status = 'active' OR active_consent_id IS NULL",
            name=op.f("ck_pet_memories_grant_state_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('active','revoked','expired','deleted','legacy_unconfirmed')",
            name=op.f("ck_pet_memories_status_valid"),
        ),
        sa.CheckConstraint("length(summary) <= 240", name=op.f("ck_pet_memories_summary_bounded")),
        sa.CheckConstraint(
            "version BETWEEN 1 AND 2147483647", name=op.f("ck_pet_memories_version_valid")
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_pet_memories_owner_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["pet_id", "owner_id"],
            ["pets.id", "pets.owner_id"],
            name=op.f("fk_pet_memories_pet_id_owner_id_pets"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pet_memories")),
        sa.UniqueConstraint(
            "id", "owner_id", "pet_id", name=op.f("uq_pet_memories_id_owner_id_pet_id")
        ),
        sa.UniqueConstraint(
            "id",
            "owner_id",
            "pet_id",
            "version",
            name=op.f("uq_pet_memories_id_owner_id_pet_id_version"),
        ),
    )
    op.create_index(
        "ix_pet_memories_owner_pet_status",
        "pet_memories",
        ["owner_id", "pet_id", "status", "expires_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_pet_memories_owner_pet_updated",
        "pet_memories",
        ["owner_id", "pet_id", "updated_at", "id"],
        unique=False,
    )

    op.create_table(
        "pet_memory_consents",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("pet_id", sa.Uuid(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("action", sa.String(length=30), nullable=False),
        sa.Column("memory_id", sa.Uuid(), nullable=True),
        sa.Column("memory_version", sa.Integer(), nullable=True),
        sa.Column("affected_all", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("policy_version", sa.String(length=60), nullable=True),
        sa.Column("notice_version", sa.String(length=60), nullable=True),
        sa.Column("actor_session_id", sa.Uuid(), nullable=True),
        sa.Column("origin_client", sa.String(length=30), nullable=False, server_default="web"),
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
            (
                "action IN ('enabled','disabled','confirmed','corrected','revoked','del"
                "eted','expired','source_invalidated')"
            ),
            name=op.f("ck_pet_memory_consents_action_valid"),
        ),
        sa.CheckConstraint(
            (
                "action NOT IN ('confirmed','corrected') OR (memory_id IS NOT NULL AND "
                "policy_version IS NOT NULL AND notice_version IS NOT NULL)"
            ),
            name=op.f("ck_pet_memory_consents_confirmation_complete"),
        ),
        sa.CheckConstraint(
            (
                "(memory_id IS NULL AND memory_version IS NULL) OR (memory_id IS NOT NU"
                "LL AND memory_version IS NOT NULL AND memory_version BETWEEN 1 AND 214"
                "7483647)"
            ),
            name=op.f("ck_pet_memory_consents_memory_identity_complete"),
        ),
        sa.CheckConstraint(
            "revision >= 1 AND privacy_epoch >= 0",
            name=op.f("ck_pet_memory_consents_revision_epoch_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["memory_id", "owner_id", "pet_id"],
            ["pet_memories.id", "pet_memories.owner_id", "pet_memories.pet_id"],
            name=op.f("fk_pet_memory_consents_memory_id_owner_id_pet_id_pet_memories"),
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_pet_memory_consents_owner_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["pet_id", "owner_id"],
            ["pets.id", "pets.owner_id"],
            name=op.f("fk_pet_memory_consents_pet_id_owner_id_pets"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pet_memory_consents")),
        sa.UniqueConstraint(
            "id",
            "memory_id",
            "owner_id",
            "pet_id",
            "memory_version",
            name=op.f("uq_pet_memory_consents_id_memory_id_owner_id_pet_id_memory_version"),
        ),
        sa.UniqueConstraint(
            "owner_id",
            "pet_id",
            "revision",
            name=op.f("uq_pet_memory_consents_owner_id_pet_id_revision"),
        ),
    )
    op.create_index(
        "ix_pet_memory_consents_owner_pet_revision",
        "pet_memory_consents",
        ["owner_id", "pet_id", "revision"],
        unique=False,
    )

    op.create_table(
        "pet_memory_sources",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("pet_id", sa.Uuid(), nullable=False),
        sa.Column("memory_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
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
            (
                "(kind = 'manual' AND session_id IS NULL AND message_id IS NULL AND sou"
                "rce_message_version IS NULL) OR (kind = 'chat_message' AND session_id "
                "IS NOT NULL AND message_id IS NOT NULL AND source_message_version IS N"
                "OT NULL AND source_message_version >= 1)"
            ),
            name=op.f("ck_pet_memory_sources_source_shape_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["memory_id", "owner_id", "pet_id"],
            ["pet_memories.id", "pet_memories.owner_id", "pet_memories.pet_id"],
            name=op.f("fk_pet_memory_sources_memory_id_owner_id_pet_id_pet_memories"),
        ),
        sa.ForeignKeyConstraint(
            ["message_id", "session_id", "owner_id"],
            ["chat_messages.id", "chat_messages.session_id", "chat_messages.owner_id"],
            name=op.f("fk_pet_memory_sources_message_id_session_id_owner_id_chat_messages"),
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_pet_memory_sources_owner_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "owner_id", "pet_id"],
            [
                "pet_chat_bindings.session_id",
                "pet_chat_bindings.owner_id",
                "pet_chat_bindings.pet_id",
            ],
            name=op.f("fk_pet_memory_sources_session_id_owner_id_pet_id_pet_chat_bindings"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pet_memory_sources")),
        sa.UniqueConstraint(
            "memory_id", "message_id", name=op.f("uq_pet_memory_sources_memory_id_message_id")
        ),
    )
    op.create_index(
        "ix_pet_memory_sources_owner_pet_memory",
        "pet_memory_sources",
        ["owner_id", "pet_id", "memory_id"],
        unique=False,
    )
    op.create_index(
        "ix_pet_memory_sources_owner_pet_session",
        "pet_memory_sources",
        ["owner_id", "pet_id", "session_id"],
        unique=False,
    )
    op.create_index(
        "uq_pet_memory_sources_manual",
        "pet_memory_sources",
        ["memory_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'manual'"),
        sqlite_where=sa.text("kind = 'manual'"),
    )

    op.create_table(
        "pet_memory_operations",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("pet_id", sa.Uuid(), nullable=False),
        sa.Column("operation_scope", sa.String(length=80), nullable=False),
        sa.Column("idempotency_key", sa.String(length=120), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("fingerprint_key_version", sa.String(length=30), nullable=False),
        sa.Column("target_memory_id", sa.Uuid(), nullable=True),
        sa.Column("result_code", sa.String(length=60), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "length(request_fingerprint) = 64",
            name=op.f("ck_pet_memory_operations_fingerprint_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_pet_memory_operations_owner_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["pet_id", "owner_id"],
            ["pets.id", "pets.owner_id"],
            name=op.f("fk_pet_memory_operations_pet_id_owner_id_pets"),
        ),
        sa.ForeignKeyConstraint(
            ["target_memory_id", "owner_id", "pet_id"],
            ["pet_memories.id", "pet_memories.owner_id", "pet_memories.pet_id"],
            name=op.f("fk_pet_memory_operations_target_memory_id_owner_id_pet_id_pet_memories"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pet_memory_operations")),
        sa.UniqueConstraint(
            "owner_id",
            "pet_id",
            "operation_scope",
            "idempotency_key",
            name=op.f("uq_pet_memory_operations_owner_id_pet_id_operation_scope_idempotency_key"),
        ),
    )
    op.create_index(
        "ix_pet_memory_operations_owner_pet_target",
        "pet_memory_operations",
        ["owner_id", "pet_id", "target_memory_id"],
        unique=False,
    )

    # Only the freshly created, empty pet table needs the cyclic active-grant FK.
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("pet_memories") as batch:
            batch.create_foreign_key(
                op.f(
                    "fk_pet_memories_active_consent_id_id_owner_id_pet_id_version_pet_memory_consents"
                ),
                "pet_memory_consents",
                ["active_consent_id", "id", "owner_id", "pet_id", "version"],
                ["id", "memory_id", "owner_id", "pet_id", "memory_version"],
            )
    else:
        op.create_foreign_key(
            op.f(
                "fk_pet_memories_active_consent_id_id_owner_id_pet_id_version_pet_memory_consents"
            ),
            "pet_memories",
            "pet_memory_consents",
            ["active_consent_id", "id", "owner_id", "pet_id", "version"],
            ["id", "memory_id", "owner_id", "pet_id", "memory_version"],
        )


def downgrade():
    raise RuntimeError("0006 is forward-only; pet and legacy data must be preserved.")
