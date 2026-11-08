"""Explicit schema capabilities shared by HTTP readiness and private workers.

The revision row is an allowlist, never a numeric minimum.  Required objects are
checked against the versioned application manifest, not against a cached Redis hint.
"""

from weakref import WeakKeyDictionary

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from app.db.base import Base

CHAT_REVISIONS = frozenset({"0004", "0005", "0006"})
MEMORY_REVISIONS = frozenset({"0005", "0006"})
PET_REVISIONS = frozenset({"0006"})
PET_TABLES = frozenset(
    {
        "pets",
        "pet_chat_bindings",
        "pet_generation_contexts",
        "pet_memory_preferences",
        "pet_memories",
        "pet_memory_consents",
        "pet_memory_sources",
        "pet_memory_operations",
    }
)
GENERATION_MEMORY_COLUMNS = frozenset(
    {"memory_epoch", "memory_context_not_before", "memory_snapshot_at"}
)
CHAT_TABLES = frozenset(
    {
        "users",
        "ai_companions",
        "chat_sessions",
        "chat_messages",
        "chat_generations",
        "chat_generation_events",
        "chat_preferences",
    }
)
MEMORY_TABLES = frozenset(
    {
        "memories",
        "memory_preferences",
        "memory_consent_events",
        "memory_sources",
        "memory_generation_refs",
        "memory_operations",
    }
)

# A successful manifest belongs to a particular engine and exact revision. This
# caches schema inspection only, never identity, consent or resource ownership.
_VERIFIED_SCHEMAS: WeakKeyDictionary[Engine, str] = WeakKeyDictionary()


class SchemaUnavailable(Exception):
    """The database cannot safely satisfy the requested schema capability."""


async def read_revision(db) -> str:
    try:
        rows = list((await db.execute(text("SELECT version_num FROM alembic_version"))).scalars())
    except SQLAlchemyError:
        raise SchemaUnavailable from None
    if len(rows) != 1 or rows[0] not in CHAT_REVISIONS:
        raise SchemaUnavailable
    return rows[0]


def _manifest_matches(connection, revision: str) -> bool:
    # Load the explicit registry even when this helper is imported outside create_app.
    from app.db import models  # noqa: F401

    inspector = inspect(connection)
    required = CHAT_TABLES | MEMORY_TABLES if revision in MEMORY_REVISIONS else CHAT_TABLES
    if revision in PET_REVISIONS:
        required |= PET_TABLES
    if not required.issubset(set(inspector.get_table_names())):
        return False
    names = sorted(required)
    columns = inspector.get_multi_columns(filter_names=names)
    primary = inspector.get_multi_pk_constraint(filter_names=names)
    foreign = inspector.get_multi_foreign_keys(filter_names=names)
    unique = inspector.get_multi_unique_constraints(filter_names=names)
    checks = inspector.get_multi_check_constraints(filter_names=names)
    indexes = inspector.get_multi_indexes(filter_names=names)
    preparer = connection.dialect.identifier_preparer
    for name in names:
        table = Base.metadata.tables[name]
        key = (None, name)
        actual_columns = {column["name"]: column for column in columns[key]}
        expected_columns = [
            column
            for column in table.columns
            if not (
                revision == "0004"
                and name == "chat_generations"
                and column.name in GENERATION_MEMORY_COLUMNS
            )
        ]
        for column in expected_columns:
            actual = actual_columns.get(column.name)
            if actual is None or actual["nullable"] != column.nullable:
                return False
            if str(actual["type"].compile(dialect=connection.dialect)) != str(
                column.type.compile(dialect=connection.dialect)
            ):
                return False
        if tuple(primary[key]["constrained_columns"]) != tuple(
            column.name for column in table.primary_key.columns
        ):
            return False
        actual_names = {
            "foreign_key_constraint": {item["name"] for item in foreign[key]},
            "unique_constraint": {item["name"] for item in unique[key]},
            "table_or_column_check_constraint": {item["name"] for item in checks[key]},
        }
        for constraint in table.constraints:
            kind = constraint.__visit_name__
            if kind in actual_names:
                rendered = preparer.format_constraint(constraint).strip('"')
                if rendered not in actual_names[kind]:
                    return False
                if kind == "foreign_key_constraint":
                    actual = next(item for item in foreign[key] if item["name"] == rendered)
                    if (
                        tuple(actual["constrained_columns"])
                        != tuple(column.name for column in constraint.columns)
                        or actual["referred_table"] != constraint.referred_table.name
                        or tuple(actual["referred_columns"])
                        != tuple(element.column.name for element in constraint.elements)
                    ):
                        return False
                elif kind == "unique_constraint":
                    actual = next(item for item in unique[key] if item["name"] == rendered)
                    if tuple(actual["column_names"]) != tuple(
                        column.name for column in constraint.columns
                    ):
                        return False
        actual_indexes = {item["name"]: item for item in indexes[key]}
        for index in table.indexes:
            rendered = preparer.format_index(index).strip('"')
            actual = actual_indexes.get(rendered)
            if actual is None or bool(actual["unique"]) != bool(index.unique):
                return False
            if tuple(actual["column_names"]) != tuple(column.name for column in index.columns):
                return False
    if connection.dialect.name == "postgresql":
        # PostgreSQL can retain present-but-unvalidated constraints or invalid indexes.
        invalid_constraints = connection.scalar(
            text(
                "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n "
                "ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated"
            )
        )
        invalid_indexes = connection.scalar(
            text(
                "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready)"
            )
        )
        if invalid_constraints or invalid_indexes:
            return False
    return True


async def require_capability(db, capability: str, *, verify_schema: bool = False) -> str:
    if capability not in {"chat", "memory", "pets"}:
        raise ValueError("Unknown schema capability")
    bind = db.get_bind()
    engine = bind.engine
    try:
        revision = await read_revision(db)
    except SchemaUnavailable:
        _VERIFIED_SCHEMAS.pop(engine, None)
        raise
    if capability == "memory" and revision not in MEMORY_REVISIONS:
        raise SchemaUnavailable
    if capability == "pets" and revision not in PET_REVISIONS:
        raise SchemaUnavailable
    if verify_schema or _VERIFIED_SCHEMAS.get(engine) != revision:
        try:
            valid = await db.run_sync(
                lambda session: _manifest_matches(session.connection(), revision)
            )
        except (SQLAlchemyError, KeyError):
            _VERIFIED_SCHEMAS.pop(engine, None)
            raise SchemaUnavailable from None
        if not valid:
            _VERIFIED_SCHEMAS.pop(engine, None)
            raise SchemaUnavailable
        _VERIFIED_SCHEMAS[engine] = revision
    return revision


async def require_enabled_capabilities(db, settings, *, verify_schema: bool = False) -> str:
    capability = "memory" if getattr(settings, "memory_management_enabled", False) else "chat"
    return await require_capability(db, capability, verify_schema=verify_schema)
