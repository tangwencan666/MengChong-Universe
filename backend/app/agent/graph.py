import asyncio
from collections.abc import Awaitable, Callable
from contextlib import aclosing
from typing import Any, Protocol

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from app.agent.prompts import PROMPT_VERSION, generation_prompt, get_prompt
from app.agent.providers import ModelProvider
from app.agent.state import AgentState


class MemoryGraphRuntime(Protocol):
    """Owner-bound private hooks; never installed by the public demonstration graph."""

    async def authorize_memory(self, state: AgentState) -> dict[str, Any]: ...

    async def retrieve_memory(self, state: AgentState) -> dict[str, Any]: ...

    async def budget_context(self, state: AgentState) -> dict[str, Any]: ...

    async def assemble_context(self, state: AgentState) -> dict[str, Any]: ...

    async def before_provider(self, state: AgentState) -> None: ...


def build_companion_graph(
    provider: ModelProvider,
    *,
    max_output_chars: int | None = None,
    memory_runtime: MemoryGraphRuntime | None = None,
    dispatch_guard: Callable[[], Awaitable[None]] | None = None,
    request_guard: Callable[[list, str], Awaitable[None]] | None = None,
):
    def prepare(state: AgentState):
        # Private jobs pin a validated version; the public demo leaves it empty.
        version = state.get("prompt_version") or PROMPT_VERSION
        get_prompt(version)
        return {"prompt_version": version, "mode": provider.name}

    async def respond(state: AgentState):
        messages = state["messages"]
        system_prompt = generation_prompt(state["prompt_version"], state.get("persona_snapshot"))
        if memory_runtime is not None:
            # This is the final owner/consent/version check and reference commit.
            # It must complete before a Provider iterator is even constructed.
            await memory_runtime.before_provider(state)
            messages = state.get("provider_messages", messages)
            system_prompt = state.get("provider_system_prompt", system_prompt)
        elif dispatch_guard is not None:
            # Disabling retrieval must not bypass the privacy fence for ordinary
            # chat history that was loaded before a deletion or revocation.
            await dispatch_guard()
        if request_guard is not None:
            # Runs after final memory assembly and before ANY provider iterator.
            await request_guard(messages, system_prompt)
        writer = get_stream_writer()
        output = ""
        async with aclosing(provider.stream(messages, system_prompt)) as stream:
            async for text in stream:
                # The writer queues without backpressure. Bound private output at
                # its source, before either the queue or graph state can grow.
                # Also let cancellation/deadlines interrupt fast or empty streams.
                await asyncio.sleep(0)
                if not isinstance(text, str):
                    raise RuntimeError("Provider returned an invalid chunk")
                if max_output_chars is not None:
                    text = text[: max(0, max_output_chars - len(output))]
                if not text:
                    continue
                writer({"text": text})
                output += text
                if max_output_chars is not None and len(output) >= max_output_chars:
                    break
        return {"output": output}

    graph = StateGraph(AgentState)
    graph.add_node("prepare", prepare)
    graph.add_node("respond", respond)
    graph.add_edge(START, "prepare")
    previous = "prepare"
    if memory_runtime is not None:
        # These hooks only authorize/read/assemble. Extraction and memory saving
        # remain explicit API commands, and are never generation side effects.
        for name in ("authorize_memory", "retrieve_memory", "budget_context", "assemble_context"):
            graph.add_node(name, getattr(memory_runtime, name))
            graph.add_edge(previous, name)
            previous = name
    graph.add_edge(previous, "respond")
    graph.add_edge("respond", END)
    # No checkpointer = no accidental cross-user persistence in the public demo.
    return graph.compile()
