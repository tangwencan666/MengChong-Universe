"""Offline gates for the separately approved, bounded desktop acceptance tooling."""

import asyncio
import json
from contextlib import asynccontextmanager, nullcontext
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest

from app.agent.provider_selection import select_chat_provider
from app.core.config import Settings
from scripts import p81_live_acceptance as live

FAKE_KEY = "p81-key-propagation-fictional-never-real"


@pytest.fixture
def server(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "scripts"))
    import p81_pet_server

    return p81_pet_server


def request(*, content="Synthetic OK", **changes):
    body = {
        "model": "deepseek-flash",
        "stream": True,
        "max_tokens": 64,
        "thinking": {"type": "disabled"},
        "stream_options": {"include_usage": True},
        "messages": [{"role": "user", "content": content}],
    } | changes
    return httpx.Request("POST", "https://api.deepseek.com/chat/completions", json=body)


def test_default_controller_does_not_start_a_process_or_read_key(monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        pytest.fail("Default command must not inspect credentials or start a service")

    monkeypatch.setattr(live.subprocess, "Popen", forbidden)
    monkeypatch.setattr(live.os, "environ", {})
    monkeypatch.setattr(live.shutil, "which", forbidden)
    assert live.main([]) == 2
    assert json.loads(capsys.readouterr().out) == {
        "status": "P81_LIVE_NOT_CONFIRMED",
        "model_requests": 0,
    }


@pytest.mark.parametrize("empty", ["", " \t\n"])
def test_missing_key_stops_before_port_or_process_access(monkeypatch, capsys, empty):
    monkeypatch.setattr(
        live.os, "environ", {"WEIBIYE_DEEPSEEK_API_KEY": empty, "DEEPSEEK_API_KEY": empty}
    )
    monkeypatch.setattr(live.shutil, "which", lambda *_: pytest.fail("Missing key must stop first"))
    assert live.main(["--confirm-paid-requests", "2"]) == 2
    assert json.loads(capsys.readouterr().out)["status"] == "P81_BACKEND_KEY_NOT_VISIBLE"


@pytest.fixture
def server_config(server, monkeypatch):
    """Inspect the real Settings path; all database/Redis/app operations are fake."""
    state = SimpleNamespace(settings=None, live=True, engine_options=None, engine_disposed=False)
    target = {
        "databaseName": "p81_fixture_never_opened",
        "cluster": server.CLUSTER,
        "moonOwnerId": "00000000-0000-0000-0000-000000000001",
        "moonPetId": "00000000-0000-0000-0000-000000000002",
        "redisRunId": "fixture-only",
        "runId": "a" * 32,
        "maxModelRequests": 2,
        "modelTransport": "live-budgeted-2",
    }
    monkeypatch.setattr(
        server.PrivateParser,
        "parse_args",
        lambda *_: SimpleNamespace(live=state.live, confirm_paid_requests=2, target=Path("fake")),
    )
    monkeypatch.setattr(
        server,
        "read_target",
        lambda *_: (target, server.OUT / "key-propagation-fixture", 38329, 35329),
    )
    db = SimpleNamespace(
        exec_driver_sql=lambda sql: sql == "SET TRANSACTION READ ONLY",
        scalar=lambda sql, params=None: target["moonOwnerId"] if params else 0,
    )

    def dispose():
        state.engine_disposed = True

    engine = SimpleNamespace(begin=lambda: nullcontext(db), dispose=dispose)

    def create_engine(url, **options):
        state.engine_options = options
        return engine

    monkeypatch.setattr(server, "create_engine", create_engine)
    monkeypatch.setattr(
        server,
        "read_snapshot",
        lambda *_: {"cluster": server.CLUSTER, "version": "0006", "tables": list(range(34))},
    )
    cache = SimpleNamespace(ping=lambda: True, info=lambda *_: {"run_id": target["redisRunId"]})
    monkeypatch.setattr(server.Redis, "from_url", lambda *_, **__: nullcontext(cache))

    class StopBeforeStartup(Exception):
        pass

    def capture(settings):
        state.settings = settings
        raise StopBeforeStartup

    monkeypatch.setattr(server, "create_app", capture)
    monkeypatch.setattr(
        server.providers, "DefaultAsyncHttpxClient", server.providers.DefaultAsyncHttpxClient
    )
    state.stop = StopBeforeStartup
    return state


@pytest.mark.parametrize(
    "key_env,expected",
    [
        ({"WEIBIYE_DEEPSEEK_API_KEY": FAKE_KEY}, FAKE_KEY),
        ({"DEEPSEEK_API_KEY": FAKE_KEY}, FAKE_KEY),
        ({"WEIBIYE_DEEPSEEK_API_KEY": "", "DEEPSEEK_API_KEY": FAKE_KEY}, FAKE_KEY),
        ({"WEIBIYE_DEEPSEEK_API_KEY": " \t", "DEEPSEEK_API_KEY": FAKE_KEY}, FAKE_KEY),
        (
            {"WEIBIYE_DEEPSEEK_API_KEY": FAKE_KEY, "DEEPSEEK_API_KEY": "other-fictional-key"},
            FAKE_KEY,
        ),
        ({"WEIBIYE_DEEPSEEK_API_KEY": " \t" + FAKE_KEY + "\n"}, FAKE_KEY),
        ({"DEEPSEEK_API_KEY": " \t" + FAKE_KEY + "\n"}, FAKE_KEY),
    ],
)
def test_server_uses_key_alias_and_priority_without_changing_mock_pets(
    server, server_config, monkeypatch, key_env, expected, capsys
):
    monkeypatch.setattr(
        server.os,
        "environ",
        {
            "WEIBIYE_LLM_PROVIDER": "mock",
            "WEIBIYE_REAL_LLM_ENABLED": "false",
            "WEIBIYE_DEEPSEEK_MODEL": "deepseek-v4-pro",
            "WEIBIYE_DEEPSEEK_MAX_TOKENS": "2048",
            **key_env,
        },
    )
    with pytest.raises(server_config.stop):
        server.main([])
    settings = server_config.settings
    assert settings.deepseek_api_key.get_secret_value() == expected
    assert settings.real_llm_enabled and settings.llm_provider == "mock"
    assert settings.deepseek_model == "deepseek-flash" and settings.deepseek_max_tokens == 64
    owner, pet = settings.dev_deepseek_pet_owner_id, settings.dev_deepseek_pet_id
    assert select_chat_provider(settings, owner, pet).provider == "deepseek"
    for other in [UUID(int=3), UUID(int=4)]:
        assert select_chat_provider(settings, owner, other).provider == "mock"
    assert select_chat_provider(settings, UUID(int=5), pet).provider == "mock"
    assert select_chat_provider(settings).provider == "mock"
    assert expected not in repr(settings) + settings.model_dump_json()
    captured = capsys.readouterr()
    assert expected not in captured.out + captured.err


def test_offline_server_keeps_dummy_key_with_real_key_names_present(
    server, server_config, monkeypatch
):
    class Environment(dict):
        def get(self, name, default=None):
            if name in {"WEIBIYE_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"}:
                pytest.fail("Offline mode must not read a model key")
            return super().get(name, default)

    monkeypatch.setattr(
        server.os,
        "environ",
        Environment(WEIBIYE_DEEPSEEK_API_KEY=FAKE_KEY, DEEPSEEK_API_KEY=FAKE_KEY),
    )
    server_config.live = False
    with pytest.raises(server_config.stop):
        server.main([])
    assert server_config.settings.deepseek_api_key.get_secret_value() == server.DUMMY_KEY
    assert server_config.settings.deepseek_max_tokens == 512


def test_global_key_aliases_preserve_explicit_priority_and_default_paid_gates(monkeypatch):
    monkeypatch.setattr(
        live.os,
        "environ",
        {"WEIBIYE_DEEPSEEK_API_KEY": FAKE_KEY, "DEEPSEEK_API_KEY": "other-fictional-key"},
    )
    assert Settings().deepseek_api_key.get_secret_value() == FAKE_KEY
    assert Settings(deepseek_api_key="explicit-fictional").deepseek_api_key.get_secret_value() == (
        "explicit-fictional"
    )
    monkeypatch.setattr(live.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})
    baseline = Settings()
    # Daily desktop startup now accepts the official environment name as well.
    # Possessing a key must still never select a paid provider by itself.
    assert baseline.deepseek_api_key.get_secret_value() == FAKE_KEY
    assert baseline.llm_provider == "mock" and not baseline.real_llm_enabled
    assert select_chat_provider(baseline).provider == "mock"
    assert Settings(deepseek_api_key=None).deepseek_api_key is None


def test_startup_database_io_has_time_limits_and_disposes_engine(
    server, server_config, monkeypatch
):
    monkeypatch.setattr(server.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})
    with pytest.raises(server_config.stop):
        server.main([])
    assert server_config.engine_options["connect_args"] == {
        "connect_timeout": 5,
        "options": "-c statement_timeout=5000 -c lock_timeout=2000",
    }
    assert server_config.engine_disposed


def test_cancel_only_server_constructs_exactly_one_admitted_call_budget(
    server, server_config, monkeypatch
):
    monkeypatch.setattr(server.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})
    target, _, _, _ = server.read_target(None, True)
    target.update(
        maxModelRequests=1, modelTransport="live-budgeted-1", acceptanceMode="cancel-only"
    )
    monkeypatch.setattr(
        server.PrivateParser,
        "parse_args",
        lambda *_: SimpleNamespace(live=True, confirm_paid_requests=1, target=Path("fake")),
    )
    budgets = []
    original = server.LiveBudget

    def capture(folder, max_calls):
        value = original(folder, max_calls=max_calls)
        budgets.append(value)
        return value

    monkeypatch.setattr(server, "LiveBudget", capture)
    with pytest.raises(server_config.stop):
        server.main([])
    assert len(budgets) == 1 and budgets[0].max_calls == 1 and budgets[0].calls == 0
    assert server_config.engine_disposed


def test_one_call_approval_cannot_start_a_two_call_target(server, server_config, monkeypatch):
    monkeypatch.setattr(server.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})
    monkeypatch.setattr(
        server.PrivateParser,
        "parse_args",
        lambda *_: SimpleNamespace(live=True, confirm_paid_requests=1, target=Path("fake")),
    )
    monkeypatch.setattr(
        server, "create_engine", lambda *_a, **_kw: pytest.fail("Approval must match before SQL")
    )
    with pytest.raises(RuntimeError, match="approval mismatch"):
        server.main([])


def test_failed_startup_snapshot_still_disposes_engine(server, server_config, monkeypatch):
    monkeypatch.setattr(server.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})

    def timeout(*_):
        raise TimeoutError("fictional database timeout")

    monkeypatch.setattr(server, "read_snapshot", timeout)
    with pytest.raises(TimeoutError):
        server.main([])
    assert server_config.engine_disposed


def test_redis_restart_cannot_silently_rebind_a_running_acceptance(
    server, server_config, monkeypatch
):
    monkeypatch.setattr(server.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})
    cache = SimpleNamespace(ping=lambda: True, info=lambda _: {"run_id": "changed-run-id"})
    monkeypatch.setattr(server.Redis, "from_url", lambda *_, **__: nullcontext(cache))
    with pytest.raises(RuntimeError, match="P81_REDIS_IDENTITY_MISMATCH"):
        server.main([])
    assert server_config.settings is None and server_config.engine_disposed


@pytest.mark.parametrize("code", ["P81_REDIS_IDENTITY_MISMATCH", FAKE_KEY])
def test_failure_diagnostics_only_print_allowlisted_codes(server, capsys, code):
    server.report_failure(RuntimeError(code))
    output = capsys.readouterr().out
    assert FAKE_KEY not in output
    assert ("P81 isolation failure: " in output) == (code == "P81_REDIS_IDENTITY_MISMATCH")


def test_startup_checkpoint_honors_stop_before_io(server, tmp_path, capsys):
    (tmp_path / "stop-requested").touch()
    with pytest.raises(RuntimeError, match="stopping"):
        server.startup_checkpoint(tmp_path, "database_snapshot")
    assert not capsys.readouterr().out


def test_app_startup_timeout_cleans_lifespan_without_starting_model(
    server, server_config, monkeypatch
):
    monkeypatch.setattr(server.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})
    monkeypatch.setattr(server, "APP_STARTUP_TIMEOUT_SECONDS", 0.01)
    state = {"closed": False}

    @asynccontextmanager
    async def original_lifespan(app):
        try:
            await asyncio.Event().wait()
            yield
        finally:
            state["closed"] = True

    app = SimpleNamespace(router=SimpleNamespace(lifespan_context=original_lifespan))
    monkeypatch.setattr(server, "create_app", lambda *_: app)
    monkeypatch.setattr(server.uvicorn, "Config", lambda app, **_: app)

    class FakeServer:
        should_exit = False

        def __init__(self, app):
            self.app = app

        def run(self):
            async def start():
                async with self.app.router.lifespan_context(self.app):
                    pytest.fail("A stalled startup must not yield a ready service")

            asyncio.run(start())

    monkeypatch.setattr(server.uvicorn, "Server", FakeServer)
    with pytest.raises(TimeoutError):
        server.main([])
    assert state["closed"] and server_config.engine_disposed


def test_ready_lifespan_outlives_startup_timeout_and_honors_owned_stop(
    server, server_config, monkeypatch, tmp_path
):
    monkeypatch.setattr(server.os, "environ", {"DEEPSEEK_API_KEY": FAKE_KEY})
    monkeypatch.setattr(server, "APP_STARTUP_TIMEOUT_SECONDS", 0.01)
    target, _, port, ui = server.read_target(None, True)
    target.update(p81RunId="b" * 32, redisPrefix="p81-offline-test:")
    monkeypatch.setattr(server, "read_target", lambda *_: (target, tmp_path, port, ui))
    settings_class = server.Settings

    def settings(**options):
        # Keep all evidence in pytest's disposable directory, outside the checkout.
        if options:
            options["mock_mail_dir"] = None
        return settings_class(**options)

    monkeypatch.setattr(server, "Settings", settings)
    state = {"closed": False, "stopped": False}

    @asynccontextmanager
    async def original_lifespan(app):
        try:
            yield
        finally:
            state["closed"] = True

    app = SimpleNamespace(
        state=SimpleNamespace(redis=object(), auth_store=SimpleNamespace(cache=None)),
        router=SimpleNamespace(lifespan_context=original_lifespan),
    )
    monkeypatch.setattr(server, "create_app", lambda *_: app)
    monkeypatch.setattr(server.uvicorn, "Config", lambda app, **_: app)

    class FakeServer:
        def __init__(self, app):
            self.app = app
            self.stop_event = asyncio.Event()
            self._should_exit = False

        @property
        def should_exit(self):
            return self._should_exit

        @should_exit.setter
        def should_exit(self, value):
            self._should_exit = value
            if value:
                self.stop_event.set()

        def run(self):
            async def serve():
                async with self.app.router.lifespan_context(self.app):
                    marker = json.loads((tmp_path / "startup.json").read_text(encoding="utf-8"))
                    assert marker["pid"] == server.os.getpid()
                    assert marker["parentPid"] == server.os.getppid()
                    assert marker["runId"] == target["p81RunId"]
                    await asyncio.sleep(0.03)
                    (tmp_path / "stop-requested").touch()
                    await asyncio.wait_for(self.stop_event.wait(), timeout=1)
                    state["stopped"] = True

            asyncio.run(serve())

    monkeypatch.setattr(server.uvicorn, "Server", FakeServer)
    server.main([])
    assert state == {"closed": True, "stopped": True}
    assert server_config.engine_disposed
    assert not (tmp_path / "transport-events.jsonl").exists()


def test_desktop_environment_filters_before_reading_sensitive_values():
    class Environment(dict):
        def __getitem__(self, name):
            assert name == "Path", "A protected value must not even be read"
            return super().__getitem__(name)

    env = Environment(
        Path="system-path",
        WEIBIYE_DEEPSEEK_API_KEY="fictional",
        deepseek_api_key="fictional",
        OPENAI_API_KEY="fictional",
        ELECTRON_RUN_AS_NODE="1",
    )
    assert live.desktop_environment(env) == {"Path": "system-path"}
    assert len(env) == 5


def test_model_budget_counts_failed_or_cancelled_requests_and_refuses_third(server, tmp_path):
    gate = server.LiveBudget(tmp_path)
    gate.admit(request())
    gate.admit(request())
    with pytest.raises(RuntimeError, match="budget exhausted"):
        gate.admit(request())
    rows = [
        json.loads(line) for line in (tmp_path / "transport-events.jsonl").read_text().splitlines()
    ]
    assert gate.calls == len(rows) == 2
    assert [row["ordinal"] for row in rows] == [1, 2]
    assert all(set(row) == {"event", "ordinal", "model", "max_output_tokens"} for row in rows)
    assert "Synthetic OK" not in json.dumps(rows)


def test_cancel_only_budget_refuses_a_second_upstream_attempt(server, tmp_path):
    gate = server.LiveBudget(tmp_path, max_calls=1)
    gate.admit(request())
    with pytest.raises(RuntimeError, match="budget exhausted"):
        gate.admit(request())
    assert gate.calls == 1
    assert len((tmp_path / "transport-events.jsonl").read_text().splitlines()) == 1


@pytest.mark.parametrize("invalid_cap", [0, 3, True])
def test_live_budget_cannot_expand_or_coerce_an_unapproved_cap(server, tmp_path, invalid_cap):
    with pytest.raises(RuntimeError):
        server.LiveBudget(tmp_path, max_calls=invalid_cap)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "change",
    [
        None,
        {"maxModelRequests": 2},
        {"acceptanceMode": "full"},
        {"modelTransport": "live-budgeted-2"},
        {"maxOutputTokens": 65},
        {"maxModelRequests": True},
        {"maxOutputTokens": 64.0},
    ],
)
def test_cancel_only_manifest_must_match_its_transport_budget_and_token_cap(
    server, monkeypatch, tmp_path, change
):
    root = tmp_path / "repo"
    out = root / ".verification/p81"
    out.mkdir(parents=True)
    baseline_path = root / ".verification/p6/target.json"
    baseline_path.parent.mkdir()
    owner, pet_id, run = str(UUID(int=1)), str(UUID(int=2)), "a" * 32
    accounts = {"a": {"user_id": owner, "pets": [{"pet_id": pet_id}]}}
    baseline_path.write_text(json.dumps({"runId": run, "accounts": accounts}), encoding="utf-8")
    target = {
        "databaseName": "weibiye_p6_desktop_test_" + run,
        "accounts": accounts,
        "moonOwnerId": owner,
        "moonPetId": pet_id,
        "p81RunId": run,
        "redisPrefix": "weibiye:p81:live:" + run + ":",
        "acceptanceMode": "cancel-only",
        "backendOrigin": "http://127.0.0.1:38329",
        "uiPort": 35329,
        "modelTransport": "live-budgeted-1",
        "maxModelRequests": 1,
        "maxOutputTokens": 64,
    }
    if change:
        target.update(change)
    path = out / "target.json"
    path.write_text(json.dumps(target), encoding="utf-8")
    monkeypatch.setattr(server, "ROOT", root)
    monkeypatch.setattr(server, "OUT", out)
    if change:
        with pytest.raises(RuntimeError):
            server.read_target(path, True)
    else:
        assert server.read_target(path, True)[0]["maxModelRequests"] == 1


@pytest.mark.parametrize(
    "options",
    [
        ["--confirm-paid-requests", "1"],
        ["--cancel-only"],
        ["--cancel-only", "--confirm-paid-requests", "2"],
    ],
)
def test_cancel_only_requires_exactly_its_own_explicit_budget(monkeypatch, capsys, options):
    class Environment(dict):
        def get(self, name, default=None):
            if name in {"WEIBIYE_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"}:
                pytest.fail("Mismatched approval must not read credentials")
            return super().get(name, default)

    monkeypatch.setattr(live.os, "environ", Environment())
    assert live.main(options) == 2
    assert json.loads(capsys.readouterr().out)["status"] == "P81_LIVE_NOT_CONFIRMED"


@pytest.mark.parametrize(
    "change",
    [
        {"max_tokens": 65},
        {"model": "deepseek-v4-pro"},
        {"stream": False},
        {"thinking": {"type": "enabled"}},
        {"messages": [{"role": "tool", "content": "x"}]},
        {"messages": [{"role": "user", "content": "authorized_memory_data"}]},
        {"messages": [{"role": "user", "content": "x" * 4097}]},
        {"messages": [{"role": "user", "content": "x"}] * 23},
    ],
)
def test_invalid_payload_cannot_consume_or_reach_paid_slot(server, tmp_path, change):
    gate = server.LiveBudget(tmp_path)
    with pytest.raises(RuntimeError):
        gate.admit(request(**change))
    assert gate.calls == 0
    assert not (tmp_path / "transport-events.jsonl").exists()


def test_foreign_origin_is_rejected_before_paid_slot(server, tmp_path):
    gate = server.LiveBudget(tmp_path)
    foreign = httpx.Request("POST", "https://example.invalid/chat/completions", content=b"{}")
    with pytest.raises(RuntimeError):
        gate.admit(foreign)
    assert gate.calls == 0


def test_live_server_requires_approval_before_environment_or_database(server, monkeypatch):
    monkeypatch.setattr(server.os, "environ", {})
    monkeypatch.setattr(server, "read_target", lambda *_: pytest.fail("Unapproved live mode"))
    with pytest.raises(RuntimeError, match="separate approval"):
        server.main(["--live"])


def test_unknown_cli_arguments_cannot_echo_a_mistyped_key(server, capsys):
    fake = "p81-fictional-key-never-sent"
    for run in [live.main, server.main]:
        with pytest.raises(SystemExit):
            run(["--api-key", fake])
        captured = capsys.readouterr()
        assert fake not in captured.out + captured.err
