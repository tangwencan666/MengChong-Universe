"""Read-only acceptance of the existing local infrastructure after a checkout copy.

Never runs Alembic commands, Docker commands, or Redis writes. Requires the
previously verified PostgreSQL cluster identifier as an explicit argument.
"""

import argparse
import json
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from redis import Redis
from sqlalchemy import CheckConstraint, UniqueConstraint, create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.db import models  # noqa: F401
from app.db.base import Base
from app.main import create_app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-cluster-id", required=True)
    args = parser.parse_args()
    settings = Settings(demo_enabled=False, chat_runner_enabled=False)
    database = make_url(settings.database_url.get_secret_value())
    cache_url = make_url(settings.redis_url.get_secret_value())
    assert (
        database.drivername,
        database.host,
        database.port,
        database.database,
        database.username,
    ) == ("postgresql+psycopg", "127.0.0.1", 25433, "weibiye", "weibiye")
    assert (cache_url.drivername, cache_url.host, cache_url.port, cache_url.database) == (
        "redis",
        "127.0.0.1",
        26380,
        "0",
    )
    assert settings.llm_provider == "mock" and not settings.real_llm_enabled
    database = database.update_query_dict({"options": "-c default_transaction_read_only=on"})
    settings.database_url = type(settings.database_url)(
        database.render_as_string(hide_password=False)
    )
    engine = create_engine(database, connect_args={"connect_timeout": 3})
    cache = Redis.from_url(settings.redis_url.get_secret_value(), socket_timeout=3)
    try:
        with engine.connect() as connection:
            connection.execute(text("SET TRANSACTION READ ONLY"))
            identity = connection.execute(
                text(
                    "SELECT current_database(), current_user, current_setting('server_version'), "
                    "(SELECT system_identifier::text FROM pg_control_system()), "
                    "current_setting('transaction_read_only')"
                )
            ).one()
            assert identity[0:2] == ("weibiye", "weibiye")
            assert identity[3] == args.expected_cluster_id and identity[4] == "on"
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
            root = Path(__file__).resolve().parents[1]
            head = ScriptDirectory.from_config(Config(str(root / "alembic.ini"))).get_current_head()
            assert revision == head
            schema = inspect(connection)
            assert len(Base.metadata.tables) == 21
            assert set(schema.get_table_names()) == set(Base.metadata.tables) | {"alembic_version"}
            counts = {"foreignKeys": 0, "uniqueConstraints": 0, "indexes": 0, "checkConstraints": 0}
            for name, table in Base.metadata.tables.items():
                assert {column["name"] for column in schema.get_columns(name)} == set(
                    table.columns.keys()
                )
                assert schema.get_pk_constraint(name)["constrained_columns"] == [
                    column.name for column in table.primary_key.columns
                ]
                foreign_keys = schema.get_foreign_keys(name)
                assert {
                    (
                        tuple(fk["constrained_columns"]),
                        fk["referred_table"],
                        tuple(fk["referred_columns"]),
                    )
                    for fk in foreign_keys
                } == {
                    (
                        tuple(fk.column_keys),
                        next(iter(fk.elements)).column.table.name,
                        tuple(e.column.name for e in fk.elements),
                    )
                    for fk in table.foreign_key_constraints
                }, name
                unique = schema.get_unique_constraints(name)
                assert {tuple(item["column_names"]) for item in unique} == {
                    tuple(c.name for c in item.columns)
                    for item in table.constraints
                    if isinstance(item, UniqueConstraint)
                }, name
                indexes = [
                    item
                    for item in schema.get_indexes(name)
                    if not item.get("duplicates_constraint")
                ]
                assert {(tuple(item["column_names"]), item["unique"]) for item in indexes} == {
                    (tuple(c.name for c in item.columns), item.unique) for item in table.indexes
                }, name
                checks = schema.get_check_constraints(name)
                assert {item["name"] for item in checks} == {
                    str(item.name)
                    for item in table.constraints
                    if isinstance(item, CheckConstraint)
                }, name
                counts["foreignKeys"] += len(foreign_keys)
                counts["uniqueConstraints"] += len(unique)
                counts["indexes"] += len(indexes)
                counts["checkConstraints"] += len(checks)
            assert (
                connection.execute(
                    text(
                        "SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid "
                        "JOIN pg_namespace n ON n.oid=t.relnamespace "
                        "WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready)"
                    )
                ).scalar_one()
                == 0
            )
        assert cache.ping() is True
        cache_info = cache.info("server")
        with TestClient(
            create_app(settings), backend_options={"loop_factory": new_event_loop}
        ) as client:
            live = client.get("/health/live")
            ready = client.get("/health/ready")
            assert live.status_code == ready.status_code == 200
            assert ready.json() == {"status": "ready"}
        print(
            json.dumps(
                {
                    "database": identity[0],
                    "databaseUser": identity[1],
                    "postgresVersion": identity[2],
                    "clusterId": identity[3],
                    "transactionReadOnly": identity[4],
                    "postgresPort": 25433,
                    "businessTables": len(Base.metadata.tables),
                    "schemaMatchesModels": True,
                    "alembicRevision": revision,
                    **counts,
                    "redisPing": True,
                    "redisVersion": cache_info["redis_version"],
                    "redisRunId": cache_info["run_id"],
                    "redisPort": 26380,
                    "fastapiLive": live.status_code,
                    "fastapiReady": ready.status_code,
                    "migrationsExecuted": False,
                    "applicationWrites": False,
                    "redisWrites": False,
                }
            )
        )
    finally:
        cache.close()
        engine.dispose()


if __name__ == "__main__":
    main()
