"""Pure harness guards: every external DB/Redis/Docker operation is forbidden."""

import importlib
import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import URL

RUN_ID = "a" * 32
AUTH_RUN_ID = "b" * 32


@pytest.fixture
def harness(monkeypatch, tmp_path):
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    module = importlib.import_module("p4_integration_database")
    assert Path(module.__file__).resolve() == scripts / "p4_integration_database.py"
    monkeypatch.setattr(module, "MANIFEST", tmp_path / "integration-target.json")
    monkeypatch.setattr(module, "P4C_MANIFEST", tmp_path / "browser-target.json")

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Offline P4 guard test attempted a real external operation")

    for name in ("source_url", "create_engine", "snapshot", "Redis", "containers", "identity"):
        monkeypatch.setattr(module, name, forbidden)
    monkeypatch.setattr(module.command, "upgrade", forbidden)
    return module


def manifest(harness, **changes):
    data = {
        "run_id": RUN_ID,
        "auth_run_id": AUTH_RUN_ID,
        "databases": harness.target_names(RUN_ID, AUTH_RUN_ID),
        "cluster": harness.CLUSTER,
        "phase": "prepared-0004",
        "redis_prefix": f"p4integration:test:{RUN_ID}:",
        "redis_lease_key": f"p4integration:test:{RUN_ID}:owner",
        "redis15_lease_key": f"weibiye:chat:test:{RUN_ID}:integration-owner",
        "redis15_reserved": False,
        "redis_run_id": "c" * 40,
        "shared_before": {
            "database": "weibiye",
            "cluster": harness.CLUSTER,
            "revision": "0004",
            "business_tables": 21,
        },
        "containers_before": [],
        "time": "2026-11-01T00:00:00+00:00",
    }
    data.update(changes)
    harness.MANIFEST.write_text(json.dumps(data), encoding="utf-8")
    return data


def connection(**changes):
    parameters = {
        "drivername": "postgresql+psycopg",
        "username": "weibiye",
        "password": "offline-synthetic-placeholder",
        "host": "127.0.0.1",
        "port": 25433,
        "database": "weibiye_p4a_test_" + RUN_ID,
    }
    parameters.update(changes)
    return URL.create(**parameters)


def test_five_targets_are_distinct_and_compatibility_manifest_is_exact(harness):
    data = manifest(harness)
    assert harness.read_manifest() == data
    assert len(set(data["databases"].values())) == 5
    browser = harness.p4c_manifest(data)
    assert browser["database"] == data["databases"]["p4c"]
    assert browser["redis_prefix"] == f"p4c:test:{RUN_ID}:"
    assert browser["shared_before"] == data["shared_before"]
    assert "password" not in json.dumps(browser)


@pytest.mark.parametrize(
    "changes",
    [
        {"run_id": ""},
        {"run_id": "a" * 31},
        {"run_id": "A" * 32},
        {"run_id": None},
        {"auth_run_id": RUN_ID},
        {"auth_run_id": "g" * 32},
        {"databases": {"p4a": "weibiye"}},
        {"cluster": "another-cluster"},
        {"phase": "head"},
        {"redis_prefix": "weibiye:"},
        {"redis_lease_key": "another-owner"},
        {"redis15_lease_key": "another-owner"},
        {"redis15_reserved": "true"},
        {"redis15_reserved": 1},
        {"redis_run_id": "bad"},
        {"shared_before": {"database": "weibiye", "revision": "0005", "business_tables": 26}},
    ],
)
def test_invalid_manifest_rejected_without_external_access(harness, changes):
    manifest(harness, **changes)
    with pytest.raises(RuntimeError):
        harness.read_manifest()


@pytest.mark.parametrize(
    "changes",
    [
        {"host": "localhost"},
        {"host": "0.0.0.0"},
        {"host": "192.0.2.3"},
        {"port": 5432},
        {"username": "postgres"},
        {"drivername": "postgresql"},
        {"query": {"options": "-c search_path=another-project"}},
        {"database": "weibiye"},
        {"database": "postgres"},
        {"database": "weibiye_p4a_test_" + "d" * 32},
        {"database": "weibiye_p4a_test_" + RUN_ID + "\n"},
    ],
)
def test_url_rejects_unselected_or_override_targets(harness, changes):
    names = harness.target_names(RUN_ID, AUTH_RUN_ID)
    with pytest.raises(RuntimeError):
        harness.local_target_url(connection(**changes), names)


def test_target_url_is_explicit_and_does_not_print_credentials(harness, monkeypatch):
    data = manifest(harness)
    monkeypatch.setattr(harness, "source_url", lambda: connection(database="weibiye"))
    assert harness.target_url(data, "p4a").database == data["databases"]["p4a"]
    assert harness.target_url(data, "p3chat").database == data["databases"]["p3chat"]
    assert harness.target_url(data, "auth").database != data["databases"]["p3chat"]
    with pytest.raises(RuntimeError, match="Unknown integration"):
        harness.target_url(data, "shared")


@pytest.mark.parametrize("existing", ["integration", "browser"])
def test_prepare_refuses_any_existing_manifest_before_external_operations(harness, existing):
    path = harness.MANIFEST if existing == "integration" else harness.P4C_MANIFEST
    path.write_text("partial evidence must remain", encoding="utf-8")
    with pytest.raises(RuntimeError, match="manifest exists"):
        harness.prepare()
    assert path.read_text(encoding="utf-8") == "partial evidence must remain"


@pytest.mark.parametrize("phase", ["preparing", "promoting-0005", "promoted-0005"])
def test_promotion_cannot_repeat_or_resume_partial_ddl(harness, phase):
    manifest(harness, phase=phase)
    with pytest.raises(RuntimeError, match="one-shot"):
        harness.promote()


@pytest.mark.parametrize(
    "role, previous, revision",
    [
        ("p4a", "0005", "0004"),
        ("p4a", "0004", "head"),
        ("p4a", "0004", "0006"),
        ("p3chat", "0004", "0005"),
        ("auth", None, "0005"),
    ],
)
def test_migration_rejects_nonexplicit_forward_transition(harness, role, previous, revision):
    data = manifest(harness)
    with pytest.raises(RuntimeError, match="explicitly selected forward"):
        harness.migrate(data, role, previous, revision)


def test_existing_database_conflict_prevents_every_create(harness, monkeypatch):
    data = manifest(harness)
    calls = []

    class Connection:
        def execute(self, statement, parameters):
            calls.append((str(statement), parameters))
            return SimpleNamespace(all=lambda: [(data["databases"]["auth"],)])

        def exec_driver_sql(self, _statement):
            raise AssertionError("No CREATE may run after any preflight target conflict")

    @contextmanager
    def connect():
        yield Connection()

    engine = SimpleNamespace(connect=connect, dispose=lambda: calls.append("disposed"))
    monkeypatch.setattr(harness, "source_url", lambda: connection(database="weibiye"))
    monkeypatch.setattr(harness, "create_engine", lambda *_args, **_kwargs: engine)
    monkeypatch.setattr(harness, "identity", lambda *_args: None)
    with pytest.raises(RuntimeError, match="already exists"):
        harness.create_targets(data)
    assert calls[0][1]["names"] == list(data["databases"].values())
    assert calls[-1] == "disposed"


def test_all_absence_checks_precede_the_first_create_and_identifiers_are_quoted(
    harness, monkeypatch
):
    data = manifest(harness)
    statements = []

    class Connection:
        dialect = postgresql.dialect()

        def execute(self, statement, parameters):
            statements.append((str(statement), parameters))
            return SimpleNamespace(all=lambda: [])

        def exec_driver_sql(self, statement):
            statements.append(statement)

    @contextmanager
    def connect():
        yield Connection()

    engine = SimpleNamespace(connect=connect, dispose=lambda: None)
    monkeypatch.setattr(harness, "source_url", lambda: connection(database="weibiye"))
    monkeypatch.setattr(harness, "create_engine", lambda *_args, **_kwargs: engine)
    monkeypatch.setattr(harness, "identity", lambda *_args: None)
    harness.create_targets(data)
    assert statements[0][1]["names"] == list(data["databases"].values())
    ddl = [statement for statement in statements if isinstance(statement, str)]
    assert len(ddl) == 5
    for statement, name in zip(ddl, data["databases"].values(), strict=True):
        assert statement == f'CREATE DATABASE "{name}" OWNER weibiye TEMPLATE template0'
    assert all("DROP" not in statement and "TRUNCATE" not in statement for statement in ddl)


def test_manifest_phase_update_rejects_concurrent_state_change(harness):
    data = manifest(harness)
    stored = {**data, "phase": "promoting-0005"}
    harness.MANIFEST.write_text(json.dumps(stored), encoding="utf-8")
    with pytest.raises(RuntimeError, match="concurrently"):
        harness.write_phase(data, "promoted-0005")
    assert json.loads(harness.MANIFEST.read_text(encoding="utf-8")) == stored
