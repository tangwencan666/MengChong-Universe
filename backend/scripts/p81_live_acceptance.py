"""Run an approved full (two calls) or cancel-only (one call) Electron acceptance.

Default: no key read, process startup, database access, or paid request. This is
not an unlimited preview launcher. No model credential is passed to Node/Electron.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".verification/p81"


class PrivateParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "Invalid P81 options. Keys belong only in the backend environment.\n")


def free_port(port):
    with socket.socket() as connection:
        return connection.connect_ex(("127.0.0.1", port)) != 0


def desktop_environment(source):
    # Filter by name before reading values, just as the actual desktop launcher does.
    return {
        name: source[name]
        for name in source
        if not name.upper().startswith(("WEIBIYE_", "OPENAI_", "DEEPSEEK_"))
        and name.upper() != "ELECTRON_RUN_AS_NODE"
    }


def backend_identity_matches(state, launcher_pid, run):
    runtime_pid = state.get("pid")
    if state.get("runId") != run or type(runtime_pid) is not int or runtime_pid <= 0:
        return False
    # Windows venv python.exe redirects to a runtime child and waits for its exit.
    return runtime_pid == launcher_pid or (
        sys.platform == "win32"
        and type(state.get("parentPid")) is int
        and state["parentPid"] == launcher_pid
    )


def browser_summary(folder, expected_requests=2):
    paths = list(folder.glob("electron-*/results.json"))
    if len(paths) != 1:
        raise RuntimeError("Missing unique browser result")
    data = json.loads(paths[0].read_text(encoding="utf-8"))
    status = data.get("status")
    if status not in {"P81_LIVE_ELECTRON_VERIFIED", "P81_LIVE_COMPLETED_WITH_CANCEL_RACE"}:
        raise RuntimeError("Browser did not verify live acceptance")
    cancellation = data.get("cancellationResult") or {}
    state = cancellation.get("state")
    actual = cancellation.get("actualCancellationVerified")
    race = cancellation.get("completionWonRace")
    if (
        state not in {"completed", "cancelled"}
        or type(actual) is not bool
        or type(race) is not bool
        or actual != (state == "cancelled")
        or race != (state == "completed")
        or (status == "P81_LIVE_ELECTRON_VERIFIED") != actual
        or type(data.get("failed")) is not int
        or data.get("failed") != 0
        or type(data.get("admittedModelRequests")) is not int
        or data.get("admittedModelRequests") != expected_requests
    ):
        raise RuntimeError("Inconsistent authoritative cancellation result")
    if actual and (
        cancellation.get("stopClicked") is not True
        or type(cancellation.get("cancelHttpStatus")) is not int
        or cancellation["cancelHttpStatus"] not in {200, 202}
        or cancellation.get("mechanism") != "generation-journal-sse/1"
        or type(cancellation.get("firstDeltaSequence")) is not int
        or cancellation["firstDeltaSequence"] < 2
        or type(cancellation.get("terminalSequence")) is not int
        or cancellation["terminalSequence"] <= cancellation["firstDeltaSequence"]
        or type(cancellation.get("terminalEventCount")) is not int
        or cancellation["terminalEventCount"] != 1
        or cancellation.get("noPostTerminalEvents") is not True
        or cancellation.get("messageStableAfterTerminal") is not True
        or cancellation.get("stopButtonHidden") is not True
    ):
        raise RuntimeError("Cancellation lacks verified SSE, HTTP or stable terminal evidence")
    return {
        "status": "P81_LIVE_TEST_COMPLETED" if actual else "P81_LIVE_COMPLETED_WITH_CANCEL_RACE",
        "actual_cancellation_verified": actual,
        "completion_won_cancel_race": race,
        "browser_results_file": str(paths[0]),
    }


def main(argv=None):
    parser = PrivateParser(description=__doc__)
    parser.add_argument("--confirm-paid-requests", type=int, choices=[1, 2], default=None)
    parser.add_argument("--cancel-only", action="store_true")
    parser.add_argument("--target", type=Path, default=OUT / "target.json")
    args = parser.parse_args(argv)
    budget = 1 if args.cancel_only else 2
    if args.confirm_paid_requests != budget:
        print(json.dumps({"status": "P81_LIVE_NOT_CONFIRMED", "model_requests": 0}))
        return 2
    # Match the isolated backend: prefer the project key, then the standard name.
    if not (
        os.environ.get("WEIBIYE_DEEPSEEK_API_KEY", "").strip()
        or os.environ.get("DEEPSEEK_API_KEY", "").strip()
    ):
        print(json.dumps({"status": "P81_BACKEND_KEY_NOT_VISIBLE", "model_requests": 0}))
        return 2
    node = shutil.which("node")
    if not node or not all(free_port(port) for port in [38329, 35329]):
        print(json.dumps({"status": "P81_LIVE_PREFLIGHT_BLOCKED", "model_requests": 0}))
        return 2
    missing = [port for port in [25433, 26380] if free_port(port)]
    if missing:
        print(
            json.dumps(
                {
                    "status": "P81_LIVE_PREFLIGHT_BLOCKED",
                    "model_requests": 0,
                    "unavailable_dependency_ports": missing,
                }
            )
        )
        return 2
    folder = OUT / ("live-" + uuid4().hex)
    folder.mkdir(parents=False, exist_ok=False)
    result = {
        "status": "P81_LIVE_BLOCKED",
        "admitted_model_request_attempts": 0,
        "actual_cost_usd": None,
        "services_exited": False,
        "processes": {},
        "cleanup_timed_out": [],
        "failure_stage": None,
        "approved_model_request_budget": budget,
        "acceptance_mode": "cancel-only" if args.cancel_only else "full",
        "started_at": datetime.now(UTC).isoformat(),
    }
    child, browser, runtime_pid = None, None, None
    stage = "manifest"
    try:
        source_path = args.target.resolve()
        if not source_path.is_relative_to(OUT.resolve()):
            raise RuntimeError("Target must belong to this P81 checkout")
        target = json.loads(source_path.read_text(encoding="utf-8"))
        run = uuid4().hex
        target.update(
            p81RunId=run,
            backendOrigin="http://127.0.0.1:38329",
            uiPort=35329,
            redisPrefix="weibiye:p81:live:" + run + ":",
            modelTransport=f"live-budgeted-{budget}",
            maxModelRequests=budget,
            maxOutputTokens=64,
            acceptanceMode=result["acceptance_mode"],
        )
        target_path = folder / "target.json"
        with target_path.open("x", encoding="utf-8") as file:
            json.dump(target, file, ensure_ascii=False, indent=2)
        # Only the backend child inherits the original CMD's process environment.
        with (folder / "backend.log").open("x", encoding="utf-8") as backend_log:
            stage = "backend_spawn"
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    str(ROOT / "backend/scripts/p81_pet_server.py"),
                    "--live",
                    "--confirm-paid-requests",
                    str(budget),
                    "--target",
                    str(target_path),
                ],
                cwd=ROOT / "backend",
                stdout=backend_log,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            stage = "backend_startup"
            deadline = time.monotonic() + 45
            ready = False
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            while time.monotonic() < deadline and child.poll() is None:
                marker = folder / "startup.json"
                if marker.exists():
                    state = json.loads(marker.read_text(encoding="utf-8"))
                    stage = "backend_identity"
                    if not backend_identity_matches(state, child.pid, run):
                        raise RuntimeError("Owned test service identity mismatch")
                    runtime_pid = state["pid"]
                    stage = "backend_readiness"
                    try:
                        with opener.open(target["backendOrigin"] + "/health/ready", timeout=1) as r:
                            ready = r.status == 200
                    except (OSError, urllib.error.URLError):
                        pass
                if ready:
                    break
                time.sleep(0.2)
            if not ready:
                raise RuntimeError("Owned test backend not ready")
            with (folder / "electron.log").open("x", encoding="utf-8") as electron_log:
                stage = "browser_spawn"
                browser = subprocess.Popen(
                    [
                        node,
                        str(ROOT / "desktop/test/p81-live-e2e.cjs"),
                        "--confirm-paid-requests=" + str(budget),
                        "--target=" + str(target_path),
                        *(["--cancel-only"] if args.cancel_only else []),
                    ],
                    cwd=ROOT / "desktop",
                    env=desktop_environment(os.environ),
                    stdout=electron_log,
                    stderr=subprocess.STDOUT,
                )
                stage = "browser_wait"
                result["browser_exit_code"] = browser.wait(timeout=240)
            if result["browser_exit_code"] == 0:
                stage = "browser_results"
                result.update(browser_summary(folder, expected_requests=budget))
            else:
                result["status"] = "P81_LIVE_TEST_FAILED"
    except KeyboardInterrupt:
        result["status"] = "P81_LIVE_INTERRUPTED"
        result["failure_stage"] = stage
    except Exception:
        # Never print exception messages: network/config errors may carry credentials.
        result["status"] = "P81_LIVE_BLOCKED"
        result["failure_stage"] = stage
    finally:
        if child is not None or browser is not None:
            (folder / "stop-requested").write_text(
                "Stop this owned test service.\n", encoding="utf-8"
            )
            for name, process in [("browser", browser), ("backend", child)]:
                if process is None:
                    continue
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    result["cleanup_timed_out"].append(name)
        for name, process in [("browser", browser), ("backend", child)]:
            if process is not None:
                result["processes"][name] = {"pid": process.pid, "exit_code": process.poll()}
        if child is not None and runtime_pid is not None:
            result["processes"]["backend"]["runtime_pid"] = runtime_pid
        result["services_exited"] = all(
            item["exit_code"] is not None for item in result["processes"].values()
        )
        if not result["services_exited"]:
            result["status"] = "P81_LIVE_CLEANUP_BLOCKED"
        events = folder / "transport-events.jsonl"
        if events.exists():
            records = [json.loads(line) for line in events.read_text(encoding="utf-8").splitlines()]
            result["admitted_model_request_attempts"] = sum(
                item["event"] == "request" for item in records
            )
        if result["status"] in {"P81_LIVE_TEST_COMPLETED", "P81_LIVE_COMPLETED_WITH_CANCEL_RACE"}:
            if result["admitted_model_request_attempts"] != budget or not result["services_exited"]:
                result["status"] = "P81_LIVE_BLOCKED"
        result["owned_ports_released"] = all(free_port(port) for port in [38329, 35329])
        if not result["owned_ports_released"]:
            result["status"] = "P81_LIVE_CLEANUP_BLOCKED"
        result["completed_at"] = datetime.now(UTC).isoformat()
        result["evidence_directory"] = str(folder)
        with (folder / "summary.json").open("x", encoding="utf-8") as file:
            json.dump(result, file, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False))
    return (
        0
        if result["status"] in {"P81_LIVE_TEST_COMPLETED", "P81_LIVE_COMPLETED_WITH_CANCEL_RACE"}
        else 2
    )


if __name__ == "__main__":
    raise SystemExit(main())
