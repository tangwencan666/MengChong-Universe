"""Offline safety guards for the explicitly isolated integration harness.

All manifests live in pytest's temporary directory. Any configuration loading or
database/Redis connection attempt fails this test suite before it reaches a
service, including when the prepare guard is accidentally reordered.
"""

import importlib
import json
from pathlib import Path

import pytest
from sqlalchemy.engine import URL

RUN_ID = "a" * 32
DATABASE = f"weibiye_p3_test_{RUN_ID}"
AUTH_DATABASE = "weibiye_p3_test_" + "b" * 32


@pytest.fixture
def harness(monkeypatch, tmp_path):
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    module = importlib.import_module("p3_integration_database")
    assert Path(module.__file__).resolve() == scripts / "p3_integration_database.py"
    monkeypatch.setattr(module, "MANIFEST", tmp_path / "test-target.json")

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Offline harness guard test attempted an external operation")

    monkeypatch.setattr(module, "Settings", forbidden)
    monkeypatch.setattr(module, "create_engine", forbidden)
    monkeypatch.setattr(module, "snapshot", forbidden)
    monkeypatch.setattr(module, "Redis", forbidden)
    monkeypatch.setattr(module.psycopg, "connect", forbidden)
    return module


def manifest(harness, **changes):
    data = {
        "run_id": RUN_ID,
        "database": DATABASE,
        "auth_database": AUTH_DATABASE,
        "redis_db": 15,
    }
    data.update(changes)
    harness.MANIFEST.write_text(json.dumps(data), encoding="utf-8")
    return data


def connection(**changes):
    parameters = {
        "drivername": "postgresql+psycopg",
        "username": "weibiye",
        "password": "offline-test-placeholder",
        "host": "127.0.0.1",
        "port": 25433,
        "database": DATABASE,
    }
    parameters.update(changes)
    return URL.create(**parameters).render_as_string(hide_password=False)


def test_valid_manifest_names_are_explicit_and_distinct(harness):
    expected = manifest(harness)
    assert harness.read_manifest() == expected
    assert expected["database"] != expected["auth_database"]


@pytest.mark.parametrize(
    "changes",
    [
        {"database": "weibiye"},
        {"database": "postgres"},
        {"database": "weibiye_p3_test_" + "c" * 32},
        {"database": DATABASE + "\n"},
        {"database": DATABASE + "?options=unsafe"},
        {"database": "weibiye_p3_test_" + "A" * 32},
        {"run_id": "a" * 31},
        {"run_id": "a" * 33},
        {"run_id": "z" * 32},
        {"run_id": "A" * 32},
        {"run_id": ""},
        {"redis_db": 0},
        {"redis_db": 14},
        {"redis_db": "15"},
        {"redis_db": False},
        {"auth_database": DATABASE},
        {"auth_database": "weibiye"},
        {"auth_database": "postgres"},
        {"auth_database": "weibiye_p3_test_short"},
        {"auth_database": AUTH_DATABASE + "\n"},
        {"auth_database": AUTH_DATABASE + "?options=unsafe"},
        {"auth_database": "weibiye_p3_test_" + "B" * 32},
    ],
    ids=[
        "development-database",
        "system-database",
        "run-target-mismatch",
        "database-newline",
        "database-query",
        "database-uppercase",
        "run-too-short",
        "run-too-long",
        "run-nonhex",
        "run-uppercase",
        "run-empty",
        "redis-development",
        "redis-unreserved",
        "redis-string",
        "redis-boolean",
        "auth-shares-chat-database",
        "auth-development-database",
        "auth-system-database",
        "auth-short-name",
        "auth-newline",
        "auth-query",
        "auth-uppercase",
    ],
)
def test_manifest_rejects_unverified_target_before_any_service_access(harness, changes):
    manifest(harness, **changes)
    with pytest.raises(RuntimeError):
        harness.read_manifest()


def test_prepare_existing_manifest_rejects_before_settings_or_database_access(harness):
    # Even invalid/partial prior evidence must never be overwritten or reused.
    harness.MANIFEST.write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Target manifest exists"):
        harness.prepare()
    assert harness.MANIFEST.read_text(encoding="utf-8") == "{}"


def test_local_url_accepts_only_explicitly_selected_loopback_target(harness):
    parsed = harness.local_url(connection())
    assert (parsed.host, parsed.port, parsed.username, parsed.database) == (
        "127.0.0.1",
        25433,
        "weibiye",
        DATABASE,
    )
    assert harness.local_url(connection(database="weibiye"), shared=True).database == "weibiye"


@pytest.mark.parametrize(
    "changes, shared",
    [
        ({"database": "weibiye"}, False),
        ({"database": "postgres"}, False),
        ({"database": None}, False),
        ({"database": "weibiye_p3_test_short"}, False),
        ({"host": "localhost"}, False),
        ({"host": "0.0.0.0"}, False),
        ({"host": "192.0.2.1"}, False),
        ({"port": 5432}, False),
        ({"port": None}, False),
        ({"username": "postgres"}, False),
        ({"drivername": "postgresql"}, False),
        ({"query": {"options": "-c search_path=other_project"}}, False),
        ({"query": {"host": "other-project"}}, False),
        ({}, True),
    ],
    ids=[
        "no-development-writes",
        "no-system-writes",
        "missing-database",
        "short-database",
        "hostname-not-pinned-ip",
        "wildcard-host",
        "nonloopback-host",
        "wrong-port",
        "implicit-port",
        "wrong-role",
        "implicit-driver",
        "options-override",
        "host-override",
        "shared-cannot-be-test-database",
    ],
)
def test_local_url_rejects_unverified_connection_options(harness, changes, shared):
    with pytest.raises(RuntimeError):
        harness.local_url(connection(**changes), shared=shared)
