import asyncio
import json
from collections.abc import AsyncIterator
from typing import Literal

from langsmith import tracing_context

from app.agent.graph import build_companion_graph
from app.agent.providers import MockLLM
from app.agent.state import AgentState


def encode_event(event: Literal["meta", "delta", "done", "error"], data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def mock_demo_events(message: str, request_id: str) -> AsyncIterator[str]:
    yield encode_event(
        "meta",
        {
            "mode": "mock",
            "persisted": False,
            "request_id": request_id,
        },
    )
    state: AgentState = {
        "messages": [{"role": "user", "content": message}],
        "prompt_version": "",
        "output": "",
        "mode": "mock",
    }
    try:
        async with asyncio.timeout(20):
            # Always Mock regardless of environment/provider selector.
            graph = build_companion_graph(MockLLM())
            # Disable external telemetry even if the host has unrelated tracing credentials.
            with tracing_context(enabled=False):
                async for chunk in graph.astream(state, stream_mode="custom"):
                    yield encode_event("delta", chunk)
        yield encode_event("done", {"mode": "mock", "persisted": False})
    except Exception:
        # Cancellations propagate; failures never emit a successful done event.
        yield encode_event("error", {"code": "STREAM_FAILED", "request_id": request_id})
