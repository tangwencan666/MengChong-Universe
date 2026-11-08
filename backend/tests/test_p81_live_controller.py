"""Fake-only live controller tests: no real child, socket, credential or model API."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import p81_live_acceptance as live

FAKE_KEY = "p81-controller-fictional-never-a-real-key"


def browser_result(*, completed=False, **changes):
    return {
        "status": "P81_LIVE_COMPLETED_WITH_CANCEL_RACE"
        if completed
        else "P81_LIVE_ELECTRON_VERIFIED",
        "failed": 0,
        "admittedModelRequests": 2,
        "cancellationResult": {
            "state": "completed" if completed else "cancelled",
            "actualCancellationVerified": not completed,
            "completionWonRace": completed,
            "stopClicked": not completed,
            "cancelHttpStatus": None if completed else 202,
            "mechanism": "generation-journal-sse/1",
            "firstDeltaSequence": 2,
            "terminalSequence": 3,
            "terminalEventCount": 1,
            "noPostTerminalEvents": True,
            "messageStableAfterTerminal": True,
            "stopButtonHidden": True,
        },
        "untrusted_extra": FAKE_KEY,
    } | changes


def write_browser(folder, data, name="electron-fixture"):
    path = folder / name / "results.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.mark.parametrize("completed", [False, True])
def test_browser_summary_preserves_actual_cancel_vs_completion_race(tmp_path, completed):
    path = write_browser(tmp_path, browser_result(completed=completed))
    result = live.browser_summary(tmp_path)
    assert result == {
        "status": "P81_LIVE_COMPLETED_WITH_CANCEL_RACE" if completed else "P81_LIVE_TEST_COMPLETED",
        "actual_cancellation_verified": not completed,
        "completion_won_cancel_race": completed,
        "browser_results_file": str(path),
    }
    assert FAKE_KEY not in json.dumps(result)


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "RUNNING"},
        {"status": "FAILED"},
        {"status": "P81_LIVE_COMPLETED_WITH_CANCEL_RACE"},
        {"cancellationResult": None},
        {"cancellationResult": {"state": "failed"}},
        {
            "cancellationResult": {
                "state": "cancelled",
                "actualCancellationVerified": 1,
                "completionWonRace": False,
            }
        },
        {
            "cancellationResult": {
                "state": "cancelled",
                "actualCancellationVerified": True,
                "completionWonRace": True,
            }
        },
        {
            "cancellationResult": {
                "state": "completed",
                "actualCancellationVerified": False,
                "completionWonRace": True,
            }
        },
        {"failed": 1},
        {"failed": False},
        {"admittedModelRequests": 1},
        {"admittedModelRequests": 2.0},
        {"admittedModelRequests": "2"},
    ],
)
def test_unknown_or_inconsistent_browser_results_are_rejected(tmp_path, changes):
    write_browser(tmp_path, browser_result(**changes))
    with pytest.raises(RuntimeError):
        live.browser_summary(tmp_path)


def test_result_must_be_unique_and_present(tmp_path):
    with pytest.raises(RuntimeError, match="unique"):
        live.browser_summary(tmp_path)
    write_browser(tmp_path, browser_result(), "electron-first")
    write_browser(tmp_path, browser_result(), "electron-second")
    with pytest.raises(RuntimeError, match="unique"):
        live.browser_summary(tmp_path)


@pytest.mark.parametrize(
    "field,value",
    [
        ("stopClicked", False),
        ("cancelHttpStatus", 500),
        ("mechanism", "polling"),
        ("firstDeltaSequence", True),
        ("terminalSequence", 2),
        ("terminalEventCount", 2),
        ("noPostTerminalEvents", False),
        ("messageStableAfterTerminal", False),
        ("stopButtonHidden", False),
    ],
)
def test_cancelled_state_alone_cannot_claim_verified_cancellation(tmp_path, field, value):
    data = browser_result()
    data["cancellationResult"][field] = value
    write_browser(tmp_path, data)
    with pytest.raises(RuntimeError):
        live.browser_summary(tmp_path)


@pytest.fixture
def harness(tmp_path, monkeypatch, request):
    """Every process, port, environment and HTTP observation is an explicit fake."""
    repository, evidence = tmp_path / "repository", tmp_path / "evidence"
    evidence.mkdir()
    (evidence / "target.json").write_text(
        json.dumps({"fixtureOnly": "No real database is selected by this test"}), encoding="utf-8"
    )
    state = SimpleNamespace(
        completed=False,
        timeout=False,
        browser_code=0,
        malformed=False,
        wrong_pid=False,
        wrong_run=False,
        redirected_backend=False,
        no_startup=False,
        stuck_backend=False,
        exit_after_timeout=False,
        processes=[],
        timeline=[],
        open_calls=[],
        folder=None,
    )
    key_env = getattr(request, "param", {"WEIBIYE_DEEPSEEK_API_KEY": FAKE_KEY})
    env = {
        "Path": "fixture-system-path",
        "OPENAI_API_KEY": "fixture-openai",
        "DeepSeek_API_KEY": "fixture-deepseek",
        "WEIBIYE_DATABASE_URL": "must-not-reach-browser",
        "ELECTRON_RUN_AS_NODE": "1",
        **key_env,
    }
    monkeypatch.setattr(live, "ROOT", repository)
    monkeypatch.setattr(live, "OUT", evidence)
    monkeypatch.setattr(live.os, "environ", env)
    monkeypatch.setattr(
        live.shutil, "which", lambda name: "fixture-node" if name == "node" else None
    )
    monkeypatch.setattr(live, "free_port", lambda port: port not in {25433, 26380})
    ticks = iter(range(1000))
    monkeypatch.setattr(live.time, "monotonic", lambda: next(ticks) if state.no_startup else 1.0)

    def forbidden(*args, **kwargs):
        pytest.fail("No real process/network/wait is permitted in this controller test")

    monkeypatch.setattr(live.time, "sleep", forbidden)
    monkeypatch.setattr(live.subprocess, "run", forbidden)

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    class FakeOpener:
        def open(self, url, *, timeout):
            assert url == "http://127.0.0.1:38329/health/ready" and timeout == 1
            state.open_calls.append(url)
            return FakeResponse()

    def build_opener(handler):
        assert handler.proxies == {}
        return FakeOpener()

    monkeypatch.setattr(live.urllib.request, "build_opener", build_opener)

    class FakeProcess:
        def __init__(self, command, **options):
            self.kind = "node" if command[0] == "fixture-node" else "backend"
            self.command, self.options = command, options
            self.pid, self.returncode = (81202 if self.kind == "node" else 81201), None
            state.processes.append(self)
            state.timeline.append(("spawn", self.kind))
            assert FAKE_KEY not in json.dumps(command)
            if self.kind == "backend":
                assert "env" not in options  # Only the backend inherits the original environment.
                target_path = Path(command[command.index("--target") + 1])
                target = json.loads(target_path.read_text(encoding="utf-8"))
                state.budget = target["maxModelRequests"]
                assert command[command.index("--confirm-paid-requests") + 1] == str(state.budget)
                state.folder = target_path.parent
                if not state.no_startup:
                    (state.folder / "startup.json").write_text(
                        json.dumps(
                            {
                                "pid": self.pid
                                + (100 if state.redirected_backend else int(state.wrong_pid)),
                                "parentPid": self.pid if state.redirected_backend else 1,
                                "runId": "foreign-run" if state.wrong_run else target["p81RunId"],
                            }
                        ),
                        encoding="utf-8",
                    )
            else:
                # Pytest adds its own current-test label between fixture setup
                # and the call. That harmless metadata may accompany OS values.
                expected_env = {
                    name: value
                    for name, value in env.items()
                    if name in {"Path", "PYTEST_CURRENT_TEST"}
                }
                assert options["env"] == expected_env
                assert all(FAKE_KEY not in value for value in options["env"].values())
                assert command[2] == "--confirm-paid-requests=" + str(state.budget)
                assert command[3] == "--target=" + str(state.folder / "target.json")
                data = browser_result(completed=state.completed)
                data["admittedModelRequests"] = state.budget
                if state.malformed:
                    data["cancellationResult"]["actualCancellationVerified"] = "yes"
                write_browser(state.folder, data)
                (state.folder / "transport-events.jsonl").write_text(
                    "\n".join(
                        json.dumps({"event": "request", "ordinal": n})
                        for n in range(1, state.budget + 1)
                    )
                    + "\n",
                    encoding="utf-8",
                )

        def poll(self):
            return self.returncode

        def wait(self, timeout):
            state.timeline.append(("wait", self.kind, timeout))
            stopped = (state.folder / "stop-requested").exists()
            if self.kind == "node" and timeout == 240:
                assert not stopped
                if state.timeout:
                    raise live.subprocess.TimeoutExpired(self.command, timeout)
                self.returncode = state.browser_code
                return self.returncode
            assert timeout == 30 and stopped, "Both children require the owned stop signal first"
            if self.kind == "backend" and state.stuck_backend:
                if state.exit_after_timeout:
                    self.returncode = 0
                raise live.subprocess.TimeoutExpired(self.command, timeout)
            if self.returncode is None:
                self.returncode = 0
            return self.returncode

        kill = terminate = forbidden

    monkeypatch.setattr(live.subprocess, "Popen", FakeProcess)
    yield state
    assert all(env[name] == value for name, value in key_env.items())


def output(capsys, state):
    result = json.loads(capsys.readouterr().out)
    assert state.folder is not None
    saved = json.loads((state.folder / "summary.json").read_text(encoding="utf-8"))
    assert saved == result
    assert FAKE_KEY not in json.dumps(result)
    assert result["actual_cost_usd"] is None
    return result


@pytest.mark.parametrize("completed", [False, True])
def test_controller_propagates_browser_authority_and_stops_both_children(
    harness, capsys, completed
):
    harness.completed = completed
    assert live.main(["--confirm-paid-requests", "2"]) == 0
    result = output(capsys, harness)
    assert result["status"] == (
        "P81_LIVE_COMPLETED_WITH_CANCEL_RACE" if completed else "P81_LIVE_TEST_COMPLETED"
    )
    assert result["actual_cancellation_verified"] is not completed
    assert result["completion_won_cancel_race"] is completed
    assert result["admitted_model_request_attempts"] == 2
    assert result["services_exited"] and result["owned_ports_released"]
    assert harness.open_calls == ["http://127.0.0.1:38329/health/ready"]
    assert [p.kind for p in harness.processes] == ["backend", "node"]
    assert harness.timeline[-2:] == [("wait", "node", 30), ("wait", "backend", 30)]
    assert (harness.folder / "stop-requested").exists()


@pytest.mark.parametrize(
    "harness",
    [
        {"DEEPSEEK_API_KEY": FAKE_KEY},
        {"WEIBIYE_DEEPSEEK_API_KEY": " \t", "DEEPSEEK_API_KEY": FAKE_KEY},
    ],
    indirect=True,
)
def test_generic_key_reaches_only_the_fake_backend(harness, capsys):
    assert live.main(["--confirm-paid-requests", "2"]) == 0
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_TEST_COMPLETED"
    assert [process.kind for process in harness.processes] == ["backend", "node"]
    for path in harness.folder.rglob("*"):
        if path.is_file() and path.name != "results.json":
            assert FAKE_KEY not in path.read_text(encoding="utf-8")


def test_timeout_signals_cooperative_exit_and_cannot_become_success(harness, capsys):
    harness.timeout = True
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_BLOCKED"
    assert result["services_exited"] and result["owned_ports_released"]
    assert "actual_cancellation_verified" not in result
    assert harness.timeline[-3:] == [
        ("wait", "node", 240),
        ("wait", "node", 30),
        ("wait", "backend", 30),
    ]
    assert all(p.poll() == 0 for p in harness.processes)


def test_zero_exit_does_not_trust_invalid_browser_result(harness, capsys):
    harness.malformed = True
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_BLOCKED" and result["services_exited"]


def test_failed_browser_exit_cannot_be_hidden_by_a_valid_result_file(harness, capsys):
    harness.browser_code = 1
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_TEST_FAILED" and result["browser_exit_code"] == 1
    assert result["services_exited"]


def test_backend_identity_mismatch_prevents_any_browser_start(harness, capsys):
    harness.wrong_pid = True
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_BLOCKED" and result["services_exited"]
    assert [p.kind for p in harness.processes] == ["backend"] and not harness.open_calls
    assert result["admitted_model_request_attempts"] == 0


def test_unconfirmed_child_shutdown_remains_blocked_without_killing(harness, capsys):
    harness.stuck_backend = True
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_CLEANUP_BLOCKED" and not result["services_exited"]
    assert (harness.folder / "stop-requested").exists()


@pytest.mark.parametrize("missing_port", [25433, 26380])
def test_missing_dependency_blocks_before_any_child_start(
    harness, monkeypatch, capsys, missing_port
):
    monkeypatch.setattr(live, "free_port", lambda port: port in {38329, 35329, missing_port})
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "P81_LIVE_PREFLIGHT_BLOCKED"
    assert result["unavailable_dependency_ports"] == [missing_port]
    assert result["model_requests"] == 0 and not harness.processes


def test_windows_redirector_accepts_only_runtime_child_of_owned_launcher(
    harness, monkeypatch, capsys
):
    harness.redirected_backend = True
    monkeypatch.setattr(live.sys, "platform", "win32")
    assert live.main(["--confirm-paid-requests", "2"]) == 0
    result = output(capsys, harness)
    assert result["processes"]["backend"]["pid"] == 81201
    assert result["processes"]["backend"]["runtime_pid"] == 81301
    assert result["processes"]["backend"]["exit_code"] == 0


def test_redirector_parent_match_cannot_override_a_foreign_run(harness, monkeypatch, capsys):
    harness.redirected_backend = harness.wrong_run = True
    monkeypatch.setattr(live.sys, "platform", "win32")
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_BLOCKED"
    assert result["failure_stage"] == "backend_identity"
    assert [process.kind for process in harness.processes] == ["backend"]


def test_startup_stall_records_actual_process_timeout_with_free_ports(harness, monkeypatch, capsys):
    harness.no_startup = harness.stuck_backend = True
    monkeypatch.setattr(live.time, "sleep", lambda *_: None)
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_CLEANUP_BLOCKED"
    assert result["failure_stage"] == "backend_startup"
    assert result["cleanup_timed_out"] == ["backend"]
    assert result["processes"]["backend"] == {"pid": 81201, "exit_code": None}
    assert not result["services_exited"] and result["owned_ports_released"]
    assert result["admitted_model_request_attempts"] == 0
    assert [process.kind for process in harness.processes] == ["backend"]


def test_exit_observed_after_wait_timeout_is_not_reported_as_cleanup_blocked(harness, capsys):
    harness.stuck_backend = harness.exit_after_timeout = True
    assert live.main(["--confirm-paid-requests", "2"]) == 0
    result = output(capsys, harness)
    assert result["status"] == "P81_LIVE_TEST_COMPLETED"
    assert result["services_exited"] and result["cleanup_timed_out"] == ["backend"]


def test_failure_before_any_child_reports_nothing_left_to_clean(harness, capsys):
    (live.OUT / "target.json").unlink()
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "P81_LIVE_BLOCKED"
    assert result["services_exited"] and result["processes"] == {}
    assert result["failure_stage"] == "manifest" and not harness.processes


def test_explicit_prepared_target_is_copied_without_replacing_original(harness, capsys):
    original = (live.OUT / "target.json").read_bytes()
    prepared = live.OUT / "prepared-fixture" / "target.json"
    prepared.parent.mkdir()
    prepared.write_text(json.dumps({"fixtureOnly": "freshly-verified-target"}), encoding="utf-8")
    assert live.main(["--target", str(prepared), "--confirm-paid-requests", "2"]) == 0
    result = output(capsys, harness)
    cloned = json.loads((harness.folder / "target.json").read_text(encoding="utf-8"))
    assert cloned["fixtureOnly"] == "freshly-verified-target"
    assert (live.OUT / "target.json").read_bytes() == original
    assert result["services_exited"]


@pytest.mark.parametrize("completed", [False, True])
def test_cancel_only_propagates_one_request_cap_and_preserves_race_result(
    harness, capsys, completed
):
    harness.completed = completed
    assert live.main(["--cancel-only", "--confirm-paid-requests", "1"]) == 0
    result = output(capsys, harness)
    target = json.loads((harness.folder / "target.json").read_text(encoding="utf-8"))
    assert target["modelTransport"] == "live-budgeted-1"
    assert target["maxModelRequests"] == result["admitted_model_request_attempts"] == 1
    assert target["acceptanceMode"] == result["acceptance_mode"] == "cancel-only"
    assert target["maxOutputTokens"] == 64
    assert result["actual_cancellation_verified"] is not completed
    assert result["completion_won_cancel_race"] is completed
    assert "--cancel-only" in harness.processes[1].command
