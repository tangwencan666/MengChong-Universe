from alembic import context
from sqlalchemy import create_engine, pool

from app.core.config import get_settings
from app.db import models  # noqa: F401
from app.db.base import Base

target_metadata = Base.metadata
url = get_settings().database_url.get_secret_value()


def offline():
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def online():
    existing_connection = context.config.attributes.get("connection")
    if existing_connection is not None:
        configure_connection(existing_connection)
        return
    engine = create_engine(url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        if connection.dialect.name == "sqlite":
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            connection.commit()
        configure_connection(connection)
    engine.dispose()


def configure_connection(connection):
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    offline()
else:
    online()
