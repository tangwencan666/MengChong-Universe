"""No Docker or database access: attest manifest input and selected inspect fields."""

import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from scripts import p83_test_target as target


def manifest():
    run_id = uuid4().hex
    run = Path(target.__file__).resolve().parents[2] / ".verification/p83" / ("postgres-" + run_id)
    run.mkdir(parents=True)
    data = run / "data"
    data.mkdir()
    value = {
        "fixture": "p83-postgres-local-only/1",
        "run": str(run),
        "runId": run_id,
        "containerId": "a" * 64,
        "containerName": "weibiye-p83-" + run_id[:12],
        "host": "127.0.0.1",
        "port": 59199,
        "database": "p83_fixture",
        "data": str(data),
        "publicDeployment": False,
        "sharedDatabase": False,
    }
    return run / "target.json", value


@pytest.mark.parametrize(
    "changes",
    [
        {"containerId": "--format=not-an-identity"},
        {"publicDeployment": True},
        {"sharedDatabase": True},
        {"data": "D:/another-project/data"},
    ],
)
def test_untrusted_manifest_stops_before_docker(monkeypatch, changes):
    file, value = manifest()
    file.write_text(json.dumps(value | changes), encoding="utf-8")
    monkeypatch.setattr(
        target.subprocess, "run", lambda *args, **kwargs: pytest.fail("Docker called")
    )
    with pytest.raises(ValueError, match="path invalid"):
        target.load_target(file)


def test_attestation_queries_only_identity_mount_and_port_fields(monkeypatch):
    file, value = manifest()
    file.write_text(json.dumps(value), encoding="utf-8")

    def inspect(arguments, **kwargs):
        assert arguments[:3] == ["docker", "inspect", value["containerId"]]
        assert ".Config.Env" not in arguments[-1]
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "id": value["containerId"],
                    "running": True,
                    "label": value["runId"],
                    "mounts": [
                        {
                            "Type": "bind",
                            "Destination": "/var/lib/postgresql/data",
                            "Source": value["data"],
                        }
                    ],
                    "ports": {
                        "5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(value["port"])}]
                    },
                }
            )
        )

    monkeypatch.setattr(target.subprocess, "run", inspect)
    loaded, url = target.load_target(file)
    assert loaded == value and "127.0.0.1:59199/p83_fixture" in url
