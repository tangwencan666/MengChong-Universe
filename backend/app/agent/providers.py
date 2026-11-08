import asyncio
import logging
import re
from collections.abc import AsyncIterator
from contextvars import ContextVar
from typing import Literal, NotRequired, Protocol, TypedDict

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    DefaultAsyncHttpxClient,
)
from openai.types.chat import ChatCompletionMessageParam

from app.agent.state import Message
from app.core.config import Settings
from app.core.errors import AppError

_private_provider_call: ContextVar[bool] = ContextVar("private_provider_call", default=False)


class _PrivateProviderLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # SDK DEBUG logs include entire prompts and HTTP headers. Suppress only
        # this call's dependency logs, without changing concurrent call levels.
        return not _private_provider_call.get()


for _dependency in (
    "openai._base_client",
    "openai._response",
    "httpx",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
):
    logging.getLogger(_dependency).addFilter(_PrivateProviderLogFilter())


class ModelProvider(Protocol):
    name: str

    def stream(self, messages: list[Message], system_prompt: str) -> AsyncIterator[str]: ...


class ProviderUsage(TypedDict):
    input_tokens: int
    output_tokens: int


class DeepSeekUsageDetails(TypedDict):
    total_tokens: int
    prompt_cache_hit_tokens: NotRequired[int]
    prompt_cache_miss_tokens: NotRequired[int]


class MockLLM:
    name = "mock"

    async def stream(self, messages: list[Message], system_prompt: str) -> AsyncIterator[str]:
        # Fixed and explicitly labeled. Never claim to analyze user risk or give model advice.
        for chunk in (
            "【Mock 演示】这里是未毕业的 AI 陪伴界面。",
            "这段文字来自固定的本地响应，没有调用真实模型。",
            "当前不会分析你的输入、保存会话或写入长期记忆。",
            "你可以用它体验流式显示，真实陪伴能力将在后续阶段接入。",
        ):
            await asyncio.sleep(0)
            yield chunk


class PrivateMockLLM:
    """Fixed local output whose privacy description matches account persistence."""

    name = "mock"

    async def stream(self, messages: list[Message], system_prompt: str) -> AsyncIterator[str]:
        for chunk in (
            "【Mock 演示】这段文字来自固定的本地回复，没有调用真实模型。",
            "消息会保存于当前账户；长期记忆仅在你逐条确认后保存。",
            "当前不会分析你的输入，也不提供真实的个性化建议。",
            "你可以用它体验已保存会话的流式显示。",
        ):
            await asyncio.sleep(0)
            yield chunk


class OpenAIProvider:
    """Adapter only; no public endpoint selects it in this foundation."""

    name = "openai"

    def __init__(self, settings: Settings):
        if (
            not settings.real_llm_enabled
            or not settings.openai_api_key
            or not settings.openai_model
        ):
            raise AppError(503, "REAL_LLM_DISABLED", "真实模型调用未启用。")
        self.api_key = settings.openai_api_key
        self.model = settings.openai_model
        self.finish_reason: Literal["stop", "length"] | None = None
        self.usage: ProviderUsage | None = None

    async def stream(self, messages: list[Message], system_prompt: str) -> AsyncIterator[str]:
        self.finish_reason = None
        self.usage = None
        payload: list[ChatCompletionMessageParam] = [{"role": "system", "content": system_prompt}]
        for message in messages:
            if message["role"] == "user":
                payload.append({"role": "user", "content": message["content"]})
            elif message["role"] == "assistant":
                payload.append({"role": "assistant", "content": message["content"]})
        async with AsyncOpenAI(
            api_key=self.api_key.get_secret_value(), timeout=20, max_retries=0
        ) as client:
            response = await client.chat.completions.create(
                model=self.model,
                messages=payload,
                stream=True,
                stream_options={"include_usage": True},
                max_completion_tokens=512,
            )
            async with response:
                async for chunk in response:
                    if chunk.usage is not None:
                        self.usage = {
                            "input_tokens": chunk.usage.prompt_tokens,
                            "output_tokens": chunk.usage.completion_tokens,
                        }
                    if chunk.choices and chunk.choices[0].finish_reason is not None:
                        finish_reason = chunk.choices[0].finish_reason
                        if finish_reason not in {"stop", "length"}:
                            raise AppError(503, "PROVIDER_FAILED", "回复生成失败，请稍后重试。")
                        self.finish_reason = finish_reason
                    if chunk.choices and chunk.choices[0].delta.content:
                        yield chunk.choices[0].delta.content
                if self.finish_reason is None:
                    raise AppError(503, "PROVIDER_FAILED", "回复生成失败，请稍后重试。")


class DeepSeekProvider:
    """Explicit official endpoint, bounded streaming, no retries or secret logging.

    Public/private chat usage retains P3's exact two-field contract. Optional
    cache/total details are separate for auditing; missing usage remains unknown.
    """

    name = "deepseek"

    def __init__(self, settings: Settings):
        if (
            settings.llm_provider != "deepseek"
            or not settings.real_llm_enabled
            or settings.deepseek_api_key is None
            or not settings.deepseek_api_key.get_secret_value().strip()
        ):
            raise AppError(503, "REAL_LLM_DISABLED", "真实模型调用未启用。")
        # Revalidate even when an internal caller used model_copy(update=...),
        # which bypasses Pydantic validation and must not bypass host/model gates.
        validated = Settings.model_validate(
            settings.model_dump()
            | {
                "deepseek_api_key": settings.deepseek_api_key,
            }
        )
        self.api_key = validated.deepseek_api_key
        self.model = validated.deepseek_model
        self.base_url = validated.deepseek_base_url
        self.max_tokens = validated.deepseek_max_tokens
        self.timeout_seconds = validated.deepseek_timeout_seconds
        self.finish_reason: Literal["stop", "length"] | None = None
        self.usage: ProviderUsage | None = None
        self.usage_details: DeepSeekUsageDetails | None = None
        self.response_model: str | None = None

    def _capture_usage(self, raw) -> None:
        if raw is None:
            return
        prompt = getattr(raw, "prompt_tokens", None)
        completion = getattr(raw, "completion_tokens", None)
        total = getattr(raw, "total_tokens", None)
        if any(type(value) is not int or value < 0 for value in (prompt, completion, total)):
            raise AppError(503, "PROVIDER_FAILED", "模型返回的用量信息不完整。")
        if total != prompt + completion:
            raise AppError(503, "PROVIDER_FAILED", "模型返回的用量信息不完整。")
        details: DeepSeekUsageDetails = {"total_tokens": total}
        for key in ("prompt_cache_hit_tokens", "prompt_cache_miss_tokens"):
            count = getattr(raw, key, None)
            if count is not None:
                if type(count) is not int or not 0 <= count <= prompt:
                    raise AppError(503, "PROVIDER_FAILED", "模型返回的用量信息不完整。")
                details[key] = count
        if (
            "prompt_cache_hit_tokens" in details
            and "prompt_cache_miss_tokens" in details
            and details["prompt_cache_hit_tokens"] + details["prompt_cache_miss_tokens"] != prompt
        ):
            raise AppError(503, "PROVIDER_FAILED", "模型返回的用量信息不完整。")
        usage: ProviderUsage = {"input_tokens": prompt, "output_tokens": completion}
        if self.usage is not None and (self.usage != usage or self.usage_details != details):
            raise AppError(503, "PROVIDER_FAILED", "模型返回的用量信息不一致。")
        self.usage, self.usage_details = usage, details

    async def stream(self, messages: list[Message], system_prompt: str) -> AsyncIterator[str]:
        self.finish_reason = None
        self.usage = self.usage_details = self.response_model = None
        payload: list[ChatCompletionMessageParam] = [{"role": "system", "content": system_prompt}]
        for message in messages:
            if message["role"] == "user":
                payload.append({"role": "user", "content": message["content"]})
            elif message["role"] == "assistant":
                payload.append({"role": "assistant", "content": message["content"]})
        private_log_token = _private_provider_call.set(True)
        try:
            async with asyncio.timeout(self.timeout_seconds):
                async with DefaultAsyncHttpxClient(
                    timeout=self.timeout_seconds, trust_env=False, follow_redirects=False
                ) as transport:
                    async with AsyncOpenAI(
                        api_key=self.api_key.get_secret_value(),
                        base_url=self.base_url,
                        timeout=self.timeout_seconds,
                        max_retries=0,
                        http_client=transport,
                    ) as client:
                        response = await client.chat.completions.create(
                            model=self.model,
                            messages=payload,
                            stream=True,
                            stream_options={"include_usage": True},
                            max_tokens=self.max_tokens,
                            extra_body={"thinking": {"type": "disabled"}},
                        )
                        async with response:
                            async for chunk in response:
                                # DeepSeek may put usage on a terminal choices
                                # chunk, unlike the empty-choices SDK example.
                                self._capture_usage(chunk.usage)
                                if chunk.model:
                                    if not isinstance(chunk.model, str) or not re.fullmatch(
                                        r"deepseek[-A-Za-z0-9_.:]{0,100}", chunk.model
                                    ):
                                        raise AppError(503, "PROVIDER_FAILED", "模型响应格式无效。")
                                    self.response_model = chunk.model
                                if not chunk.choices:
                                    continue
                                if self.finish_reason is not None:
                                    raise AppError(503, "PROVIDER_FAILED", "模型结束后仍返回内容。")
                                if len(chunk.choices) != 1 or chunk.choices[0].index != 0:
                                    raise AppError(503, "PROVIDER_FAILED", "模型响应格式无效。")
                                choice = chunk.choices[0]
                                if choice.finish_reason is not None:
                                    if choice.finish_reason not in {"stop", "length"}:
                                        raise AppError(
                                            503, "PROVIDER_FAILED", "回复生成失败，请稍后重试。"
                                        )
                                    self.finish_reason = choice.finish_reason
                                text = choice.delta.content
                                if text is not None:
                                    if not isinstance(text, str):
                                        raise AppError(503, "PROVIDER_FAILED", "模型响应格式无效。")
                                    if text:
                                        yield text
                            if self.finish_reason is None:
                                raise AppError(503, "PROVIDER_FAILED", "回复未完整结束，请重试。")
        except asyncio.CancelledError:
            raise
        except (TimeoutError, APITimeoutError):
            raise AppError(504, "PROVIDER_TIMEOUT", "模型服务响应超时，请稍后重试。") from None
        except APIStatusError as error:
            status = error.status_code
            if status in {401, 403}:
                failure = AppError(503, "PROVIDER_AUTH_FAILED", "模型服务认证未通过。")
            elif status == 402:
                failure = AppError(503, "PROVIDER_BILLING_UNAVAILABLE", "模型服务额度暂不可用。")
            elif status == 429:
                failure = AppError(429, "PROVIDER_RATE_LIMITED", "模型服务繁忙，请稍后重试。")
            else:
                failure = AppError(503, "PROVIDER_UNAVAILABLE", "模型服务暂不可用。")
            raise failure from None
        except APIConnectionError:
            raise AppError(503, "PROVIDER_UNAVAILABLE", "模型服务暂不可用。") from None
        except AppError:
            raise
        except Exception:
            # SDK messages/bodies can echo credentials and chat. Never expose
            # their text or traceback chain to the API/SSE or application logs.
            raise AppError(503, "PROVIDER_FAILED", "回复生成失败，请稍后重试。") from None
        finally:
            _private_provider_call.reset(private_log_token)


def build_provider(settings: Settings) -> ModelProvider:
    if settings.llm_provider == "mock":
        return MockLLM()
    return (
        DeepSeekProvider(settings)
        if settings.llm_provider == "deepseek"
        else OpenAIProvider(settings)
    )


def build_private_provider(settings: Settings, provider: str, model: str | None) -> ModelProvider:
    """Use a task's frozen selection while retaining the live server safety gates."""
    if provider == "mock":
        return PrivateMockLLM()
    if provider == "deepseek":
        if (
            settings.environment == "test"
            or settings.llm_provider != "deepseek"
            or model != settings.deepseek_model
        ):
            raise AppError(503, "REAL_LLM_DISABLED", "真实模型调用未启用。")
        return DeepSeekProvider(settings)
    if (
        settings.environment == "test"
        or provider != "openai"
        or settings.llm_provider != "openai"
        or not model
    ):
        raise AppError(503, "REAL_LLM_DISABLED", "真实模型调用未启用。")
    adapter = OpenAIProvider(settings)
    adapter.model = model
    return adapter
