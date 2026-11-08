"""Opt-in, non-destructive acceptance against the dedicated local infrastructure.

Requires WEIBIYE_LOCAL_INFRA_TESTS=1 and explicit local database/Redis URLs.
Never runs migrations or resets schemas. PostgreSQL checks are read-only; Redis
uses uniquely named, expiring verification keys. No application records are created.
"""

import json
import os
import socket
import subprocess
from pathlib import Path
from typing import Annotated
from uuid import uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import Depends
from fastapi.testclient import TestClient
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import CheckConstraint, UniqueConstraint, create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession
from uvicorn.config import Config as UvicornConfig

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.core.rate_limit import LUA_WINDOW
from app.db import models  # noqa: F401
from app.db.base import Base
from app.db.session import get_session
from app.main import create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("WEIBIYE_LOCAL_INFRA_TESTS") != "1",
    reason="Dedicated local PostgreSQL/Redis acceptance requires explicit opt-in",
)


def docker_read(*arguments: str) -> str:
    result = subprocess.run(
        ["docker", "--context", "desktop-linux", *arguments],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    return result.stdout.strip()


@pytest.fixture(scope="module")
def infrastructure():
    database_url = os.environ["WEIBIYE_DATABASE_URL"]
    redis_url = os.environ["WEIBIYE_REDIS_URL"]
    parsed = make_url(database_url)
    assert parsed.drivername == "postgresql+psycopg"
    assert (parsed.host, parsed.port, parsed.database, parsed.username) == (
        "127.0.0.1",
        25433,
        "weibiye",
        "weibiye",
    )
    parsed_redis = make_url(redis_url)
    assert (
        parsed_redis.drivername,
        parsed_redis.host,
        parsed_redis.port,
        parsed_redis.database,
    ) == ("redis", "127.0.0.1", 26380, "0")
    assert not parsed_redis.username and not parsed_redis.password

    # Avoid reading any container environment variables or unrelated project data.
    for service in ("postgres", "redis"):
        metadata = json.loads(
            docker_read(
                "inspect",
                "--format",
                '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                '"status":{{json .State.Status}},"health":{{json .State.Health.Status}},'
                '"oom":{{json .State.OOMKilled}},"restarts":{{json .RestartCount}}}',
                f"weibiye-{service}-1",
            )
        )
        assert metadata == {
            "project": "weibiye",
            "service": service,
            "status": "running",
            "health": "healthy",
            "oom": False,
            "restarts": 0,
        }
    expected_cluster_id = docker_read(
        "exec",
        "weibiye-postgres-1",
        "psql",
        "-X",
        "-U",
        "weibiye",
        "-d",
        "weibiye",
        "-At",
        "-c",
        "SELECT system_identifier::text FROM pg_control_system()",
    )
    engine = create_engine(database_url, connect_args={"connect_timeout": 3})
    cache = Redis.from_url(redis_url, decode_responses=True, socket_timeout=3)
    try:
        with engine.connect() as connection:
            actual_id = connection.execute(
                text("SELECT system_identifier::text FROM pg_control_system()")
            ).scalar_one()
            assert actual_id == expected_cluster_id
        redis_info = docker_read("exec", "weibiye-redis-1", "redis-cli", "INFO", "server")
        expected_run_id = next(
            line.split(":", 1)[1].strip()
            for line in redis_info.splitlines()
            if line.startswith("run_id:")
        )
        assert cache.info("server")["run_id"] == expected_run_id
        yield engine, cache, database_url, redis_url
    finally:
        cache.close()
        engine.dispose()


def settings_for(database_url: str, redis_url: str) -> Settings:
    return Settings(
        environment="test",
        database_url=SecretStr(database_url),
        redis_url=SecretStr(redis_url),
        llm_provider="mock",
        real_llm_enabled=False,
        demo_enabled=False,
        rate_limit_backend="redis",
        chat_runner_enabled=False,
    )


def test_postgres_version_identity_and_revision(infrastructure):
    engine, _, _, _ = infrastructure
    root = Path(__file__).resolve().parents[2]
    expected_revision = ScriptDirectory.from_config(Config(str(root / "alembic.ini")))
    with engine.connect() as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        assert connection.execute(text("SELECT current_database()")).scalar_one() == "weibiye"
        assert connection.execute(text("SELECT current_user")).scalar_one() == "weibiye"
        assert connection.execute(text("SHOW server_version")).scalar_one().startswith("17.")
        revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert revision == expected_revision.get_current_head()


def test_tables_columns_primary_keys_and_foreign_keys(infrastructure):
    engine, _, _, _ = infrastructure
    with engine.connect() as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        schema = inspect(connection)
        assert len(Base.metadata.tables) == 21
        assert set(schema.get_table_names()) == set(Base.metadata.tables) | {"alembic_version"}
        for name, table in Base.metadata.tables.items():
            assert {column["name"] for column in schema.get_columns(name)} == set(
                table.columns.keys()
            )
            assert schema.get_pk_constraint(name)["constrained_columns"] == [
                column.name for column in table.primary_key.columns
            ]
            actual = {
                (
                    tuple(fk["constrained_columns"]),
                    fk["referred_table"],
                    tuple(fk["referred_columns"]),
                )
                for fk in schema.get_foreign_keys(name)
            }
            expected = {
                (
                    tuple(fk.column_keys),
                    next(iter(fk.elements)).column.table.name,
                    tuple(element.column.name for element in fk.elements),
                )
                for fk in table.foreign_key_constraints
            }
            assert actual == expected, name


def test_unique_constraints_and_indexes(infrastructure):
    engine, _, _, _ = infrastructure
    with engine.connect() as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        schema = inspect(connection)
        for name, table in Base.metadata.tables.items():
            assert {
                tuple(item["column_names"]) for item in schema.get_unique_constraints(name)
            } == {
                tuple(column.name for column in item.columns)
                for item in table.constraints
                if isinstance(item, UniqueConstraint)
            }, name
            assert {
                (tuple(item["column_names"]), item["unique"])
                for item in schema.get_indexes(name)
                if not item.get("duplicates_constraint")
            } == {
                (tuple(column.name for column in item.columns), item.unique)
                for item in table.indexes
            }, name


def test_check_constraints_and_index_validity(infrastructure):
    engine, _, _, _ = infrastructure
    with engine.connect() as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        schema = inspect(connection)
        for name, table in Base.metadata.tables.items():
            assert {item["name"] for item in schema.get_check_constraints(name)} == {
                str(item.name) for item in table.constraints if isinstance(item, CheckConstraint)
            }, name
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM pg_constraint c "
                    "JOIN pg_namespace n ON n.oid=c.connamespace "
                    "WHERE n.nspname='public' AND NOT c.convalidated"
                )
            ).scalar_one()
            == 0
        )
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


def test_redis_ping_and_expiring_roundtrip(infrastructure):
    _, cache, _, _ = infrastructure
    key = f"weibiye:verification:roundtrip:{uuid4()}"
    value = str(uuid4())
    assert cache.ping() is True
    assert cache.set(key, value, nx=True, ex=30) is True
    assert cache.get(key) == value
    assert 0 < cache.ttl(key) <= 30


def test_redis_atomic_limiter(infrastructure):
    _, cache, _, _ = infrastructure
    key = f"weibiye:verification:limiter:{uuid4()}"
    assert cache.eval(LUA_WINDOW, 1, key, 30) == 1
    assert cache.eval(LUA_WINDOW, 1, key, 30) == 2
    assert 0 < cache.ttl(key) <= 30


def test_fastapi_readiness_session_lifecycle_and_runtime_loop(infrastructure):
    engine, _, database_url, redis_url = infrastructure
    parsed = make_url(database_url)
    session_url = parsed.update_query_dict({"application_name": "weibiye-infra-acceptance"})
    app = create_app(settings_for(session_url.render_as_string(hide_password=False), redis_url))

    @app.get("/__acceptance/session")
    async def identity(session: Annotated[AsyncSession, Depends(get_session)]):
        row = (await session.execute(text("SELECT current_database(), current_user"))).one()
        return {"database": row[0], "user": row[1]}

    # Exercise Uvicorn's configured loop factory without binding a port or starting a server.
    config = UvicornConfig(app, loop="app.core.event_loop:new_event_loop")
    factory = config.get_loop_factory()
    assert factory is new_event_loop
    with TestClient(app, backend_options={"loop_factory": factory}) as client:
        assert client.get("/health/live").status_code == 200
        for _ in range(3):
            response = client.get("/health/ready")
            assert response.status_code == 200
            assert response.json() == {"status": "ready"}
            assert response.headers["x-request-id"]
        assert client.get("/__acceptance/session").json() == {
            "database": "weibiye",
            "user": "weibiye",
        }
        with engine.connect() as connection:
            idle = connection.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname='weibiye' "
                    "AND application_name='weibiye-infra-acceptance' "
                    "AND state='idle in transaction'"
                )
            ).scalar_one()
            assert idle == 0


@pytest.mark.parametrize("unavailable", ["database", "redis"])
def test_readiness_reports_dependency_failure_without_stopping_containers(
    infrastructure,
    unavailable,
):
    _, _, database_url, redis_url = infrastructure
    # Reserve a loopback port without listening, so it cannot address another project.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as refused:
        refused.bind(("127.0.0.1", 0))
        port = refused.getsockname()[1]
        if unavailable == "database":
            database_url = (
                make_url(database_url).set(port=port).render_as_string(hide_password=False)
            )
        else:
            redis_url = f"redis://127.0.0.1:{port}/0"
        app = create_app(settings_for(database_url, redis_url))
        with TestClient(app, backend_options={"loop_factory": new_event_loop}) as client:
            response = client.get("/health/ready")
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "DEPENDENCIES_UNAVAILABLE"
            assert response.json()["request_id"] == response.headers["x-request-id"]
            assert "local-development-only" not in response.text
            assert client.get("/health/live").status_code == 200
