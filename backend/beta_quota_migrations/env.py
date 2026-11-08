"""No implicit URL/environment: online callers supply an attested connection."""

from alembic import context

from app.modules.beta_quota import privacy_models  # noqa: F401
from app.modules.beta_quota.models import BetaBase

config = context.config
options = {"target_metadata": BetaBase.metadata, "version_table": "beta_quota_schema_version"}
if context.is_offline_mode():
    context.configure(url="postgresql://", literal_binds=True, **options)
    with context.begin_transaction():
        context.run_migrations()
else:
    connection = config.attributes.get("connection")
    if connection is None:
        raise RuntimeError(
            "Explicit verified target connection required; never use shared development storage"
        )
    context.configure(connection=connection, **options)
    with context.begin_transaction():
        context.run_migrations()
