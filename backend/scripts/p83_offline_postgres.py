"""Explicit local P8.3 test fixture. Never pulls, migrates shared DBs, or deletes data."""

import argparse
import json
import re
import socket
import subprocess
import time
from pathlib import Path
from uuid import uuid4

from scripts.p83_test_target import load_target


def docker(*arguments, timeout=30):
    return subprocess.run(
        ["docker", *arguments], check=True, capture_output=True, text=True, timeout=timeout
    ).stdout.strip()


def prepare(image="postgres:17-alpine"):
    # Resolve an already cached image; --pull=never also fences docker run.
    image_id = docker("image", "inspect", image, "--format", "{{.Id}}")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Cached PostgreSQL image identity invalid")
    root = Path(__file__).resolve().parents[2]
    run_id = uuid4().hex
    run = root / ".verification" / "p83" / ("postgres-" + run_id)
    run.mkdir(parents=True, exist_ok=False)
    data = run / "data"
    data.mkdir()
    if data.resolve() != data:
        raise ValueError("Test data path must not traverse a link")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    if port in {25433, 26380}:
        raise ValueError("Reserved project endpoint refused")
    name = "weibiye-p83-" + run_id[:12]
    container_id = docker(
        "run",
        "-d",
        "--pull=never",
        "--name",
        name,
        "--label",
        "com.weibiye.p83.run=" + run_id,
        "--memory",
        "256m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        "--publish",
        f"127.0.0.1:{port}:5432",
        "--mount",
        f"type=bind,source={data},target=/var/lib/postgresql/data",
        "--env",
        "POSTGRES_USER=p83_fixture",
        "--env",
        "POSTGRES_DB=p83_fixture",
        "--env",
        "POSTGRES_PASSWORD=p83-local-fixture-only",
        image_id,
        "postgres",
        "-c",
        "shared_buffers=32MB",
        "-c",
        "max_connections=20",
    )
    target = {
        "fixture": "p83-postgres-local-only/1",
        "run": str(run),
        "runId": run_id,
        "containerId": container_id,
        "containerName": name,
        "image": image_id,
        "host": "127.0.0.1",
        "port": port,
        "database": "p83_fixture",
        "data": str(data),
        "publicDeployment": False,
        "sharedDatabase": False,
    }
    file = run / "target.json"
    with file.open("x", encoding="utf-8") as stream:
        json.dump(target, stream, indent=2)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        load_target(file)
        try:
            docker("exec", container_id, "pg_isready", "-U", "p83_fixture", "-d", "p83_fixture")
            return file
        except subprocess.CalledProcessError:
            time.sleep(0.25)
    raise RuntimeError("Owned fixture not ready; inspect its manifest, no other service touched")


def stop(file):
    target, _ = load_target(file)  # Exact ID, run label, mount and loopback binding.
    docker("stop", "--time", "20", target["containerId"])
    stopped = docker("inspect", target["containerId"], "--format", "{{.State.Running}}") == "false"
    if not stopped:
        raise RuntimeError("Owned fixture did not stop")
    result = {
        "identityVerified": True,
        "stopped": True,
        "containerPreserved": True,
        "dataPreserved": Path(target["data"]).is_dir(),
        "containerId": target["containerId"],
    }
    evidence = Path(target["run"]) / ("stop-" + uuid4().hex + ".json")
    with evidence.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2)
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--prepare-offline-postgres", action="store_true")
    action.add_argument("--stop-owned-target", type=Path)
    parser.add_argument("--cached-image", default="postgres:17-alpine")
    arguments = parser.parse_args()
    result = (
        prepare(arguments.cached_image)
        if arguments.prepare_offline_postgres
        else stop(arguments.stop_owned_target)
    )
    print(json.dumps({"evidence": str(result), "real_model_requests": 0}))


if __name__ == "__main__":
    main()
