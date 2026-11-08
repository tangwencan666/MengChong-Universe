"""DeepSeek contract tests: local HTTPX transport only, never real credentials/API."""

import asyncio
import json
import logging
import traceback
from contextlib import aclosing
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr, ValidationError

import app.agent.providers as providers
from app.core.config import Settings
from app.core.errors import AppError

FICTIONAL_KEY = "p8-fictional-credential-never-use"


def configured(**changes):
    options = {
        "environment": "development",
        "llm_provider": "deepseek",
        "real_llm_enabled": True,
        "deepseek_api_key": SecretStr(FICTIONAL_KEY),
    }
    return Settings(**(options | changes))


def frame(text=None, *, finish=None, usage=None, choices=True, model="deepseek-flash"):
    value = {
        "id": "synthetic-p8",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": model,
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": finish}]
        if choices
        else [],
    }
    if usage is not None:
        value["usage"] = usage
    return ("data: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode()


class BytesStream(httpx.AsyncByteStream):
    def __init__(self, chunks, *, hold=False):
        self.chunks = chunks
        self.closed = False
        self.hold = hold
        self.waiting = asyncio.Event()

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        if self.hold:
            self.waiting.set()
            await asyncio.Event().wait()

    async def aclose(self):
        self.closed = True


@pytest.fixture
def transport(monkeypatch):
    """Patch only the HTTP transport; exercise actual SDK request/SSE parsing."""
    original = providers.DefaultAsyncHttpxClient

    def install(handler):
        records = {"requests": [], "clients": [], "options": []}

        async def capture(request):
            records["requests"].append(request)
            result = handler(request)
            return await result if hasattr(result, "__await__") else result

        def make_client(**options):
            records["options"].append(options)
            client = original(**options, transport=httpx.MockTransport(capture))
            records["clients"].append(client)
            return client

        monkeypatch.setattr(providers, "DefaultAsyncHttpxClient", make_client)
        return records

    return install


def response(stream):
    return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=stream)


async def collect(adapter):
    return "".join(
        [piece async for piece in adapter.stream([{"role": "user", "content": "你好"}], "safe")]
    )


def test_default_remains_mock_and_no_key_is_required(monkeypatch):
    monkeypatch.delenv("WEIBIYE_DEEPSEEK_API_KEY", raising=False)
    settings = Settings()
    assert settings.llm_provider == "mock" and not settings.real_llm_enabled
    assert settings.selected_model is None and settings.deepseek_model == "deepseek-flash"
    assert isinstance(providers.build_provider(settings), providers.MockLLM)
    assert isinstance(
        providers.build_private_provider(settings, "mock", None), providers.PrivateMockLLM
    )


@pytest.mark.parametrize(
    "updates",
    [
        {"real_llm_enabled": False},
        {"deepseek_api_key": None},
        {"deepseek_api_key": SecretStr("   ")},
        {"deepseek_model": "deepseek-chat"},
        {"deepseek_model": "arbitrary-expensive-model"},
        {"deepseek_max_tokens": 0},
        {"deepseek_max_tokens": 2049},
        {"deepseek_timeout_seconds": 0},
        {"memory_injection_enabled": True},
    ],
)
def test_deepseek_configuration_requires_explicit_safe_boundaries(updates):
    with pytest.raises(ValidationError):
        configured(**updates)


@pytest.mark.parametrize(
    "url",
    [
        "http://api.deepseek.com",
        "https://outside.invalid",
        "https://api.deepseek.com.evil.invalid",
        "https://api.deepseek.com:444",
        "https://api.deepseek.com/v2",
        "https://api.deepseek.com?key=forbidden",
        "https://api.deepseek.com/#fragment",
        "https://user:password@api.deepseek.com",
        "https://api.deepseek.com:invalid",
    ],
)
def test_deepseek_endpoint_refuses_redirectable_or_credential_urls(url):
    with pytest.raises(ValidationError):
        configured(deepseek_base_url=url)


def test_key_excluded_from_serialization_and_validation_error_text(monkeypatch):
    monkeypatch.setenv("WEIBIYE_DEEPSEEK_API_KEY", FICTIONAL_KEY)
    settings = Settings()
    assert settings.deepseek_api_key.get_secret_value() == FICTIONAL_KEY
    assert "deepseek_api_key" not in settings.model_dump()
    assert FICTIONAL_KEY not in repr(settings) + settings.model_dump_json()
    with pytest.raises(ValidationError) as error:
        Settings(deepseek_api_key=FICTIONAL_KEY, llm_provider="unknown")
    assert FICTIONAL_KEY not in str(error.value)


def test_factory_uses_frozen_model_only_when_live_selection_still_authorized():
    settings = configured()
    assert settings.selected_model == "deepseek-flash"
    assert isinstance(providers.build_provider(settings), providers.DeepSeekProvider)
    assert isinstance(
        providers.build_private_provider(settings, "deepseek", "deepseek-flash"),
        providers.DeepSeekProvider,
    )
    for provider, model in [("deepseek", None), ("deepseek", "deepseek-v4-pro"), ("unknown", "x")]:
        with pytest.raises(AppError):
            providers.build_private_provider(settings, provider, model)
    with pytest.raises(AppError):
        providers.build_private_provider(
            configured(environment="test"), "deepseek", "deepseek-flash"
        )
    with pytest.raises(AppError):
        providers.build_private_provider(Settings(), "deepseek", "deepseek-flash")


def test_unvalidated_settings_copy_cannot_bypass_official_endpoint_or_memory_gate():
    for changes in [
        {"deepseek_base_url": "https://outside.invalid"},
        {"deepseek_model": "unapproved"},
        {"memory_injection_enabled": True},
    ]:
        with pytest.raises(ValidationError):
            providers.DeepSeekProvider(configured().model_copy(update=changes))


async def test_official_stream_request_unicode_and_usage_on_terminal_chunk(transport, monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://outside.invalid")
    monkeypatch.setenv("HTTPS_PROXY", "http://outside.invalid")
    usage = {
        "prompt_tokens": 12,
        "completion_tokens": 4,
        "total_tokens": 16,
        "prompt_cache_hit_tokens": 8,
        "prompt_cache_miss_tokens": 4,
    }
    body = frame("你") + frame("好") + frame(finish="stop", usage=usage) + b"data: [DONE]\n\n"
    stream = BytesStream([body[index : index + 1] for index in range(len(body))])
    records = transport(lambda _: response(stream))
    adapter = providers.DeepSeekProvider(configured())
    assert await collect(adapter) == "你好"
    assert adapter.finish_reason == "stop" and adapter.response_model == "deepseek-flash"
    assert adapter.usage == {"input_tokens": 12, "output_tokens": 4}
    assert adapter.usage_details == {
        "total_tokens": 16,
        "prompt_cache_hit_tokens": 8,
        "prompt_cache_miss_tokens": 4,
    }
    assert len(records["requests"]) == 1
    request = records["requests"][0]
    assert str(request.url) == "https://api.deepseek.com/chat/completions"
    payload = json.loads(request.content)
    assert payload["model"] == "deepseek-flash" and payload["stream"] is True
    assert payload["max_tokens"] == 512 and "max_completion_tokens" not in payload
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["stream_options"] == {"include_usage": True}
    assert records["options"][0]["trust_env"] is False
    assert records["options"][0]["follow_redirects"] is False
    assert stream.closed and all(client.is_closed for client in records["clients"])


async def test_empty_choices_usage_after_length_and_no_fabricated_usage(transport):
    usage = {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}
    stream = BytesStream([frame("截断", finish="length"), frame(choices=False, usage=usage)])
    transport(lambda _: response(stream))
    adapter = providers.DeepSeekProvider(
        configured(deepseek_base_url="https://api.deepseek.com/v1/")
    )
    assert await collect(adapter) == "截断" and adapter.finish_reason == "length"
    assert adapter.usage == {"input_tokens": 2, "output_tokens": 1}
    assert adapter.usage_details == {"total_tokens": 3}
    missing = BytesStream([frame("无用量", finish="stop")])
    transport(lambda _: response(missing))
    assert await collect(adapter) == "无用量"
    assert adapter.usage is None and adapter.usage_details is None


@pytest.mark.parametrize(
    "chunks",
    [
        [frame("partial")],
        [frame(finish="tool_calls")],
        [frame(finish="content_filter")],
        [frame("ok", finish="stop"), frame("illegal after terminal")],
        [frame(finish="stop"), frame(finish="stop")],
        [frame("x", finish="stop", model="untrusted-model")],
        [
            frame(
                "x",
                finish="stop",
                usage={"prompt_tokens": -1, "completion_tokens": 2, "total_tokens": 1},
            )
        ],
        [
            frame(
                "x",
                finish="stop",
                usage={"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 4},
            )
        ],
        [
            frame(
                "x",
                finish="stop",
                usage={
                    "prompt_tokens": 1,
                    "completion_tokens": 2,
                    "total_tokens": 3,
                    "prompt_cache_hit_tokens": 2,
                },
            )
        ],
    ],
)
async def test_invalid_protocol_or_usage_never_reports_success(chunks, transport):
    stream = BytesStream(chunks)
    records = transport(lambda _: response(stream))
    with pytest.raises(AppError) as error:
        await collect(providers.DeepSeekProvider(configured()))
    assert error.value.code == "PROVIDER_FAILED"
    assert stream.closed and records["clients"][0].is_closed


def test_usage_rejects_boolean_or_coerced_values():
    adapter = providers.DeepSeekProvider(configured())
    for count in (True, "1", 1.0):
        with pytest.raises(AppError):
            adapter._capture_usage(
                SimpleNamespace(prompt_tokens=count, completion_tokens=2, total_tokens=3)
            )


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "PROVIDER_AUTH_FAILED"),
        (403, "PROVIDER_AUTH_FAILED"),
        (402, "PROVIDER_BILLING_UNAVAILABLE"),
        (429, "PROVIDER_RATE_LIMITED"),
        (500, "PROVIDER_UNAVAILABLE"),
        (503, "PROVIDER_UNAVAILABLE"),
        (302, "PROVIDER_UNAVAILABLE"),
    ],
)
async def test_sdk_errors_are_redacted_and_never_retried(status, code, transport, caplog):
    records = transport(
        lambda _: httpx.Response(
            status,
            headers={"Location": "https://outside.invalid"},
            json={"error": {"message": FICTIONAL_KEY + " private upstream body"}},
        )
    )
    with caplog.at_level(logging.DEBUG), pytest.raises(AppError) as failure:
        await collect(providers.DeepSeekProvider(configured()))
    assert failure.value.code == code
    formatted = "".join(traceback.format_exception(failure.value))
    assert FICTIONAL_KEY not in formatted + caplog.text
    assert "private upstream body" not in formatted + caplog.text
    assert "你好" not in caplog.text
    assert len(records["requests"]) == 1
    assert records["clients"][0].is_closed
    assert not providers._private_provider_call.get()


async def test_private_sdk_logs_suppressed_without_affecting_other_task_or_later_call(
    transport, caplog
):
    logger = logging.getLogger("openai._base_client")
    request_started, concurrent_logged = asyncio.Event(), asyncio.Event()

    async def unrelated_task():
        await request_started.wait()
        logger.debug("unrelated SDK diagnostic remains available")
        concurrent_logged.set()

    async def upstream(_):
        logger.debug("private upstream response %s", FICTIONAL_KEY)
        request_started.set()
        await concurrent_logged.wait()
        return response(BytesStream([frame("ok", finish="stop")]))

    transport(upstream)
    with caplog.at_level(logging.DEBUG):
        unrelated = asyncio.create_task(unrelated_task())
        try:
            assert await collect(providers.DeepSeekProvider(configured())) == "ok"
            await unrelated
            logger.debug("later SDK diagnostic remains available")
        finally:
            if not unrelated.done():
                unrelated.cancel()
    assert "unrelated SDK diagnostic" in caplog.text
    assert "later SDK diagnostic" in caplog.text
    assert "private upstream response" not in caplog.text
    assert FICTIONAL_KEY not in caplog.text and "你好" not in caplog.text
    assert not providers._private_provider_call.get()


async def test_total_timeout_and_connection_errors_close_client(transport):
    async def slow(_):
        await asyncio.sleep(1)

    records = transport(slow)
    with pytest.raises(AppError) as error:
        await collect(providers.DeepSeekProvider(configured(deepseek_timeout_seconds=0.02)))
    assert error.value.code == "PROVIDER_TIMEOUT"
    assert len(records["requests"]) == 1 and records["clients"][0].is_closed

    def unavailable(request):
        raise httpx.ConnectError(FICTIONAL_KEY, request=request)

    records = transport(unavailable)
    with pytest.raises(AppError) as error:
        await collect(providers.DeepSeekProvider(configured()))
    assert error.value.code == "PROVIDER_UNAVAILABLE" and FICTIONAL_KEY not in str(error.value)
    assert len(records["requests"]) == 1 and records["clients"][0].is_closed


async def test_cancel_and_early_consumer_close_release_response_and_client(transport):
    stream = BytesStream([frame("partial")], hold=True)
    records = transport(lambda _: response(stream))
    adapter = providers.DeepSeekProvider(configured())
    task = asyncio.create_task(collect(adapter))
    await asyncio.wait_for(stream.waiting.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed and records["clients"][0].is_closed
    assert adapter.usage is None and adapter.finish_reason is None

    stream = BytesStream([frame("one"), frame("two", finish="stop")])
    records = transport(lambda _: response(stream))
    adapter = providers.DeepSeekProvider(configured())
    async with aclosing(adapter.stream([], "safe")) as iterator:
        assert await anext(iterator) == "one"
    assert stream.closed and records["clients"][0].is_closed
    assert adapter.usage is None
