"""Target renewal uses synthetic identities, fake SQL/Redis and fake Docker output only."""

import json
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from scripts import p81_prepare_target as prepare


@pytest.fixture
def fixture_target(tmp_path, monkeypatch):
    root = tmp_path / "repository"
    out = root / ".verification/p81"
    out.mkdir(parents=True)
    baseline_path = root / ".verification/p6/target.json"
    baseline_path.parent.mkdir()
    accounts = {}
    for label, owner, pets in [("a", 1, [3, 4, 5]), ("b", 2, [6])]:
        accounts[label] = {
            "user_id": f"00000000-0000-0000-0000-{owner:012d}",
            "email": label + "@example.invalid",
            "password": "synthetic-fixture-only",
            "pets": [
                {
                    "pet_id": f"00000000-0000-0000-0000-{pet:012d}",
                    "name": "fixture-pet",
                    "role_type": "cat",
                }
                for pet in pets
            ],
        }
    baseline = {
        "runId": "a" * 32,
        "databaseName": "weibiye_p6_desktop_test_" + "a" * 32,
        "schemaVersion": "0006",
        "cluster": "123456",
        "accounts": accounts,
        "redisRunId": "b" * 40,
    }
    source = baseline | {
        "moonOwnerId": accounts["a"]["user_id"],
        "moonPetId": accounts["a"]["pets"][0]["pet_id"],
    }
    source_path = out / "target.json"
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    source_path.write_text(json.dumps(source), encoding="utf-8")
    monkeypatch.setattr(prepare, "ROOT", root)
    monkeypatch.setattr(prepare, "OUT", out)
    state = SimpleNamespace(source=source, baseline=baseline, path=source_path, database_calls=[])
    monkeypatch.setattr(
        prepare, "check_database", lambda target: state.database_calls.append(target)
    )
    monkeypatch.setattr(
        prepare,
        "check_redis",
        lambda: {
            "runId": "c" * 40,
            "containerId": "fixture-container",
            "startedAt": "fixture-start",
            "volume": "weibiye_weibiye_redisdata",
        },
    )
    return state


def test_renewal_creates_new_target_without_changing_baseline_or_source(fixture_target):
    source_bytes = fixture_target.path.read_bytes()
    baseline_path = prepare.ROOT / ".verification/p6/target.json"
    baseline_bytes = baseline_path.read_bytes()
    result = prepare.prepare(fixture_target.path)
    target_path = prepare.Path(result["target"])
    target = json.loads(target_path.read_text(encoding="utf-8"))
    assert target["redisRunId"] == "c" * 40
    assert target["accounts"] == fixture_target.source["accounts"]
    assert target["cluster"] == fixture_target.source["cluster"]
    assert target["modelTransport"] == "httpx-mock-only"
    assert target["redisPrefix"] == "weibiye:p81:" + target["p81RunId"] + ":"
    assert result["previous_redis_run_id"] == "b" * 40 and result["database_read_only"]
    assert fixture_target.path.read_bytes() == source_bytes
    assert baseline_path.read_bytes() == baseline_bytes
    assert len(fixture_target.database_calls) == 1 and result["model_requests"] == 0


@pytest.mark.parametrize(
    "field,value",
    [
        ("runId", "d" * 32),
        ("databaseName", "weibiye"),
        ("cluster", "foreign-cluster"),
        ("schemaVersion", "0005"),
        ("accounts", {}),
        ("moonPetId", "foreign-pet"),
    ],
)
def test_invalid_source_cannot_trigger_environment_checks(fixture_target, field, value):
    fixture_target.path.write_text(
        json.dumps(fixture_target.source | {field: value}), encoding="utf-8"
    )
    with pytest.raises(RuntimeError):
        prepare.prepare(fixture_target.path)
    assert not fixture_target.database_calls
    assert not list(prepare.OUT.glob("prepared-*"))


def test_refuses_to_overwrite_a_previously_prepared_target(fixture_target, monkeypatch):
    monkeypatch.setattr(prepare, "uuid4", lambda: SimpleNamespace(hex="d" * 32))
    first = prepare.prepare(fixture_target.path)
    path = prepare.Path(first["target"])
    original = path.read_bytes()
    with pytest.raises(FileExistsError):
        prepare.prepare(fixture_target.path)
    assert path.read_bytes() == original


def test_failed_environment_check_cannot_create_target(fixture_target, monkeypatch):
    def unavailable(*_):
        raise RuntimeError("P81_POSTGRES_CLUSTER_MISMATCH")

    monkeypatch.setattr(prepare, "check_database", unavailable)
    with pytest.raises(RuntimeError):
        prepare.prepare(fixture_target.path)
    assert not list(prepare.OUT.glob("prepared-*"))


@pytest.mark.parametrize(
    "change", [None, "read_only", "database", "cluster", "schema", "active", "pet"]
)
def test_database_revalidation_is_read_only_and_rejects_changed_bindings(
    tmp_path, monkeypatch, change
):
    target = {
        "databaseName": "weibiye_p6_desktop_test_" + "a" * 32,
        "cluster": "1234",
        "accounts": {
            "a": {
                "user_id": "fixture-owner",
                "email": "a@example.invalid",
                "pets": [{"pet_id": "fixture-pet", "name": "pet", "role_type": "cat"}],
            }
        },
    }
    observed = {"disposed": False, "options": None}

    class Environment(dict):
        def get(self, key, default=None):
            assert key == "WEIBIYE_DATABASE_URL", "Model environment must never be consulted"
            return super().get(key, default)

    monkeypatch.setattr(prepare.os, "environ", Environment(DEEPSEEK_API_KEY="fictional-not-read"))

    def scalar(statement, params=None):
        sql = str(statement)
        assert sql.startswith(("SELECT", "SHOW")), "Preparation must never issue SQL writes"
        if sql.startswith("SHOW"):
            return "off" if change == "read_only" else "on"
        if "current_database" in sql:
            return "weibiye" if change == "database" else target["databaseName"]
        if "pg_control_system" in sql:
            return "foreign-cluster" if change == "cluster" else target["cluster"]
        if "alembic_version" in sql:
            return "0005" if change == "schema" else "0006"
        if "chat_generations" in sql:
            return 1 if change == "active" else 0
        if "FROM pets" in sql:
            return 0 if change == "pet" else 1
        assert "FROM users" in sql
        return 1

    db = SimpleNamespace(scalar=scalar)

    def dispose():
        observed["disposed"] = True

    def create_engine(url, **options):
        assert url.database == target["databaseName"]
        observed["options"] = options
        return SimpleNamespace(begin=lambda: nullcontext(db), dispose=dispose)

    monkeypatch.setattr(prepare, "create_engine", create_engine)
    monkeypatch.setattr(
        prepare,
        "inspect",
        lambda _: SimpleNamespace(
            get_table_names=lambda: ["table" + str(i) for i in range(34)] + ["alembic_version"]
        ),
    )
    if change:
        with pytest.raises(RuntimeError):
            prepare.check_database(target)
    else:
        prepare.check_database(target)
    assert observed["disposed"]
    assert "default_transaction_read_only=on" in observed["options"]["connect_args"]["options"]


@pytest.mark.parametrize("change", [None, "project", "port", "volume", "endpoint"])
def test_redis_is_attested_against_exact_container_and_published_endpoint(monkeypatch, change):
    run_id = "c" * 40
    container = {
        "id": "fixture-container",
        "name": "/weibiye-redis-1",
        "running": True,
        "startedAt": "fixture-start",
        "labels": {
            "com.docker.compose.project": "foreign" if change == "project" else "weibiye",
            "com.docker.compose.service": "redis",
        },
        "ports": {
            "6379/tcp": [{"HostIp": "127.0.0.1", "HostPort": "1" if change == "port" else "26380"}]
        },
        "mounts": [
            {
                "Type": "volume",
                "Destination": "/data",
                "Name": "foreign" if change == "volume" else "weibiye_weibiye_redisdata",
            }
        ],
    }

    def docker(arguments):
        assert ".Config.Env" not in " ".join(arguments)
        return json.dumps(container) if arguments[0] == "inspect" else "run_id:" + run_id + "\r\n"

    monkeypatch.setattr(prepare, "docker_output", docker)
    cache = SimpleNamespace(
        ping=lambda: True, info=lambda _: {"run_id": "d" * 40 if change == "endpoint" else run_id}
    )
    monkeypatch.setattr(prepare.Redis, "from_url", lambda *_, **__: nullcontext(cache))
    if change:
        with pytest.raises(RuntimeError):
            prepare.check_redis()
    else:
        assert prepare.check_redis()["runId"] == run_id
