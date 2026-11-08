"""Bind disposable P8.3 PostgreSQL tests to their exact local container and mount."""

import json
import re
import subprocess
from pathlib import Path


def load_target(path):
    root = Path(__file__).resolve().parents[2]
    source = Path(path).resolve()
    target = json.loads(source.read_text(encoding="utf-8-sig"))
    run_id = target.get("runId", "")
    if not re.fullmatch(r"[a-f0-9]{32}", run_id):
        raise ValueError("P83 fixture identity invalid")
    run = root / ".verification" / "p83" / ("postgres-" + run_id)
    if (
        source != run / "target.json"
        or Path(target["run"]).resolve() != run
        or target["fixture"] != "p83-postgres-local-only/1"
        or not re.fullmatch(r"[a-f0-9]{64}", target.get("containerId", ""))
        or target.get("publicDeployment") is not False
        or target.get("sharedDatabase") is not False
        or Path(target["data"]).resolve() != run / "data"
    ):
        raise ValueError("P83 fixture path invalid")
    port = target["port"]
    if (
        target["host"] != "127.0.0.1"
        or target["database"] != "p83_fixture"
        or type(port) is not int
        or not 1024 <= port <= 65535
        or port in {25433, 26380}
    ):
        raise ValueError("P83 fixture endpoint invalid")
    template = (
        '{"id":{{json .Id}},"running":{{json .State.Running}},'
        '"label":{{json (index .Config.Labels "com.weibiye.p83.run")}},'
        '"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}'
    )
    result = subprocess.run(
        ["docker", "inspect", target["containerId"], "--format", template],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    identity = json.loads(result.stdout)
    mapping = identity["ports"].get("5432/tcp")
    if (
        identity["id"] != target["containerId"]
        or not identity["running"]
        or identity["label"] != run_id
        or mapping != [{"HostIp": "127.0.0.1", "HostPort": str(port)}]
    ):
        raise ValueError("P83 container identity or published endpoint changed")
    expected = (run / "data").as_posix()
    linux = "/run/desktop/mnt/host/" + expected[0].lower() + expected[2:]
    mounts = identity["mounts"]
    if (
        len(mounts) != 1
        or mounts[0]["Type"] != "bind"
        or mounts[0]["Destination"] != "/var/lib/postgresql/data"
        or mounts[0]["Source"].replace("\\", "/").lower() not in {expected.lower(), linux.lower()}
    ):
        raise ValueError("P83 data mount changed")
    return (
        target,
        f"postgresql+psycopg://p83_fixture:p83-local-fixture-only@127.0.0.1:{port}/p83_fixture",
    )
