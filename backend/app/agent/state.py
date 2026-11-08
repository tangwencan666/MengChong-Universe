from typing import Any, Literal, NotRequired, TypedDict


class Message(TypedDict):
    role: Literal["user", "assistant", "system"]
    content: str


class AgentState(TypedDict):
    messages: list[Message]
    prompt_version: str
    output: str
    mode: Literal["mock", "openai", "deepseek"]
    # Private invocation state only; no checkpointer, logging, or SSE serialization.
    persona_snapshot: NotRequired[dict[str, Any]]
    memory_policy_snapshot: NotRequired[dict[str, Any]]
    memory_hits: NotRequired[list[Any]]
    memory_budget: NotRequired[Any]
    provider_messages: NotRequired[list[Message]]
    provider_system_prompt: NotRequired[str]
