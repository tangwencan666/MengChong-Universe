import asyncio
import json
from decimal import Decimal
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from app.core.errors import AppError
from scripts import deepseek_live_smoke as smoke

FAKE_KEY = "p8-offline-fixture-not-a-real-key"


class FakeProvider:
    calls = []
    instances = []

    def __init__(self, settings):
        self.settings = settings
        self.usage = {"input_tokens": 10, "output_tokens": 1}
        self.usage_details = {
            "total_tokens": 11,
            "prompt_cache_hit_tokens": 2,
            "prompt_cache_miss_tokens": 8,
            "untrusted_extra": FAKE_KEY,
        }
        self.response_model = "deepseek-v4.1-flash-1017"
        self.finish_reason = "stop"
        self.closed = False
        self.instances.append(self)

    async def stream(self, messages, system_prompt):
        self.calls.append((messages, system_prompt))
        try:
            yield "O"
            yield "K"
        finally:
            self.closed = True


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    FakeProvider.calls = []
    FakeProvider.instances = []
    monkeypatch.setattr(smoke, "DeepSeekProvider", FakeProvider)
    monkeypatch.delenv("WEIBIYE_DEEPSEEK_API_KEY", raising=False)


def test_default_never_constructs_provider_or_reads_key(monkeypatch, capsys):
    monkeypatch.setenv("WEIBIYE_DEEPSEEK_API_KEY", FAKE_KEY)
    assert smoke.main([]) == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "LIVE_TEST_NOT_CONFIRMED"
    assert result["provider_invocations"] == 0
    assert result["paid_request_may_have_occurred"] is False
    assert FakeProvider.instances == []
    assert FAKE_KEY not in json.dumps(result)


def test_key_missing_stops_before_provider(capsys):
    assert smoke.main(["--confirm-paid-request"]) == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "LIVE_TEST_KEY_NOT_VISIBLE"
    assert result["paid_request_may_have_occurred"] is False
    assert FakeProvider.instances == []


@pytest.mark.asyncio
async def test_one_synthetic_bounded_request_ignores_inherited_backend_settings(monkeypatch):
    monkeypatch.setenv("WEIBIYE_MEMORY_INJECTION_ENABLED", "true")
    monkeypatch.setenv("WEIBIYE_LLM_PROVIDER", "openai")
    result = await smoke.run_once(SecretStr(FAKE_KEY))
    assert result["status"] == "LIVE_TEST_COMPLETED"
    assert result["provider_invocations"] == 1
    assert result["paid_request_may_have_occurred"] is True
    assert FakeProvider.calls == [
        ([{"role": "user", "content": "Reply exactly OK."}], "Follow the user instruction.")
    ]
    provider = FakeProvider.instances[0]
    assert provider.settings.deepseek_model == "deepseek-flash"
    assert provider.settings.deepseek_max_tokens == 32
    assert provider.settings.deepseek_timeout_seconds == 15
    assert provider.settings.memory_injection_enabled is False
    assert provider.settings.memory_management_enabled is False
    assert provider.closed
    assert result["actual_cost_usd"] is None
    assert Decimal(result["estimated_cost_usd_at_reference_peak_prices"]) == Decimal("0.000003612")
    assert "untrusted_extra" not in result["usage_details"]
    assert FAKE_KEY not in json.dumps(result)


@pytest.mark.asyncio
async def test_missing_usage_stays_unknown():
    provider = FakeProvider(SimpleNamespace())
    provider.usage = None
    result = smoke.empty_result("LIVE_TEST_COMPLETED")
    smoke.capture_usage(result, provider)
    assert result["usage"] is None
    assert result["actual_cost_usd"] is None
    assert result["estimated_cost_usd_at_reference_peak_prices"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "code", "status"),
    [
        (
            AppError(503, "PROVIDER_AUTH_FAILED", FAKE_KEY),
            "PROVIDER_AUTH_FAILED",
            "LIVE_TEST_FAILED",
        ),
        (AppError(503, FAKE_KEY, FAKE_KEY), "PROVIDER_FAILED", "LIVE_TEST_FAILED"),
        (RuntimeError(FAKE_KEY), "PROVIDER_FAILED", "LIVE_TEST_FAILED"),
        (TimeoutError(FAKE_KEY), "PROVIDER_TIMEOUT", "LIVE_TEST_FAILED"),
        (asyncio.CancelledError(FAKE_KEY), None, "LIVE_TEST_CANCELLED"),
    ],
)
async def test_failures_are_sanitized_and_never_retry(monkeypatch, error, code, status):
    class Failing(FakeProvider):
        async def stream(self, messages, system_prompt):
            self.calls.append((messages, system_prompt))
            try:
                raise error
                yield  # pragma: no cover - makes this a fake async iterator
            finally:
                self.closed = True

    monkeypatch.setattr(smoke, "DeepSeekProvider", Failing)
    result = await smoke.run_once(SecretStr(FAKE_KEY))
    assert result["status"] == status
    assert result.get("error_code") == code
    assert len(FakeProvider.calls) == 1
    assert FakeProvider.instances[0].closed
    assert result["actual_cost_usd"] is None
    assert FAKE_KEY not in json.dumps(result)


def test_report_is_new_sanitized_file_only(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEIBIYE_DEEPSEEK_API_KEY", FAKE_KEY)
    monkeypatch.setattr(smoke, "REPORT_ROOT", tmp_path)
    assert smoke.main(["--confirm-paid-request", "--report"]) == 0
    result = json.loads(capsys.readouterr().out)
    files = list(tmp_path.glob("deepseek-live-*.json"))
    assert len(files) == 1
    saved = json.loads(files[0].read_text(encoding="utf-8"))
    assert saved["status"] == "LIVE_TEST_COMPLETED"
    assert saved["usage"] == {"input_tokens": 10, "output_tokens": 1}
    assert result["report_path"] == str(files[0])
    assert "Reply exactly" not in files[0].read_text(encoding="utf-8")
    assert FAKE_KEY not in files[0].read_text(encoding="utf-8")


def test_failed_report_preflight_prevents_request(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEIBIYE_DEEPSEEK_API_KEY", FAKE_KEY)
    invalid_root = tmp_path / "regular-file"
    invalid_root.write_text("preserve", encoding="utf-8")
    monkeypatch.setattr(smoke, "REPORT_ROOT", invalid_root)
    assert smoke.main(["--confirm-paid-request", "--report"]) == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "LIVE_TEST_PREFLIGHT_FAILED"
    assert FakeProvider.instances == []
    assert invalid_root.read_text(encoding="utf-8") == "preserve"


def test_unknown_cli_options_never_echo_mistaken_key_argument(capsys):
    with pytest.raises(SystemExit) as error:
        smoke.main(["--key", FAKE_KEY])
    assert error.value.code == 2
    output = capsys.readouterr()
    assert FAKE_KEY not in output.out + output.err
    assert FakeProvider.instances == []


def test_report_collision_never_overwrites_or_sends(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEIBIYE_DEEPSEEK_API_KEY", FAKE_KEY)
    monkeypatch.setattr(smoke, "REPORT_ROOT", tmp_path)
    monkeypatch.setattr(smoke, "uuid4", lambda: SimpleNamespace(hex="collision"))
    existing = tmp_path / "deepseek-live-collision.json"
    existing.write_text("preserve", encoding="utf-8")
    assert smoke.main(["--confirm-paid-request", "--report"]) == 2
    assert json.loads(capsys.readouterr().out)["status"] == "LIVE_TEST_PREFLIGHT_FAILED"
    assert existing.read_text(encoding="utf-8") == "preserve"
    assert FakeProvider.instances == []


@pytest.mark.asyncio
async def test_oversized_stream_is_closed_without_retaining_body(monkeypatch):
    class Oversized(FakeProvider):
        async def stream(self, messages, system_prompt):
            self.calls.append((messages, system_prompt))
            try:
                yield FAKE_KEY * 100
            finally:
                self.closed = True

    monkeypatch.setattr(smoke, "DeepSeekProvider", Oversized)
    result = await smoke.run_once(SecretStr(FAKE_KEY))
    assert result["status"] == "LIVE_TEST_FAILED"
    assert result["error_code"] == "PROVIDER_FAILED"
    assert result["provider_invocations"] == 1
    assert FakeProvider.instances[0].closed
    assert FAKE_KEY not in json.dumps(result)
