"""Pure runtime regressions: no database, service, Redis or provider network calls."""

import asyncio
import json
import time
from contextlib import aclosing, asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import anyio
import pytest
from langsmith import tracing_context

from app.agent.chat_protocol import append_event
from app.agent.chat_runner import ChatRunner, _Claim, _Identity
from app.agent.graph import build_companion_graph
from app.agent.providers import PrivateMockLLM
from app.agent.sse import mock_demo_events
from app.core.config import Settings
from app.modules.companion import events


def graph_state():
    return {
        "messages": [{"role": "user", "content": "runtime probe"}],
        "prompt_version": "companion-v1",
        "mode": "mock",
        "output": "",
    }


@pytest.mark.parametrize("chunk_size,cap", [(1, 17), (1, 8000), (20000, 8000)])
async def test_fast_provider_stops_at_source_cap_and_closes(chunk_size, cap):
    class FastProvider:
        name = "mock"
        produced = 0
        closed = False

        async def stream(self, messages, system_prompt):
            try:
                for _ in range(20000):
                    self.produced += 1
                    yield "x" * chunk_size
            finally:
                self.closed = True

    provider = FastProvider()
    graph = build_companion_graph(provider, max_output_chars=cap)
    with tracing_context(enabled=False):
        chunks = [chunk async for chunk in graph.astream(graph_state(), stream_mode="custom")]
    assert "".join(chunk["text"] for chunk in chunks) == "x" * cap
    assert provider.produced == (cap + chunk_size - 1) // chunk_size
    assert len(chunks) <= cap
    assert provider.closed


async def test_fast_empty_provider_remains_cancellable_without_queued_empty_events():
    started = asyncio.Event()

    class EmptyProvider:
        name = "mock"
        closed = False

        async def stream(self, messages, system_prompt):
            try:
                while True:
                    started.set()
                    yield ""
            finally:
                self.closed = True

    provider = EmptyProvider()
    graph = build_companion_graph(provider, max_output_chars=8000)
    chunks = []

    async def consume():
        with tracing_context(enabled=False):
            async with aclosing(graph.astream(graph_state(), stream_mode="custom")) as stream:
                async for chunk in stream:
                    chunks.append(chunk)

    task = asyncio.create_task(consume())
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1)
    assert provider.closed
    assert chunks == []


async def test_graph_rejects_invalid_provider_chunks_and_closes_iterator():
    class InvalidProvider:
        name = "mock"
        closed = False

        async def stream(self, messages, system_prompt):
            try:
                yield None
            finally:
                self.closed = True

    provider = InvalidProvider()
    graph = build_companion_graph(provider, max_output_chars=8000)
    with tracing_context(enabled=False), pytest.raises(RuntimeError, match="invalid chunk"):
        async for _ in graph.astream(graph_state(), stream_mode="custom"):
            pytest.fail("Invalid provider chunks must never enter the event queue")
    assert provider.closed


async def run_without_storage(monkeypatch, provider, cap):
    runner = ChatRunner(
        None,
        Settings(environment="test", chat_run_timeout_seconds=2, chat_output_max_chars=cap),
    )
    identity = _Identity(uuid4(), uuid4(), uuid4())
    claim = _Claim(identity, 1, "mock", None, "companion-v1", (), uuid4())
    saved, result = [], {}

    async def load_context(_claim):
        return graph_state()["messages"]

    async def authorize_dispatch(guarded_claim):
        assert guarded_claim == claim

    async def renew(*_args):
        await asyncio.Event().wait()

    async def flush(_claim, text):
        saved.append(text)

    async def finish(_claim, state, **kwargs):
        result.update(state=state, **kwargs)
        saved.append(kwargs.get("pending", ""))

    monkeypatch.setattr(runner, "_load_context", load_context)
    monkeypatch.setattr(runner, "_authorize_dispatch", authorize_dispatch)
    monkeypatch.setattr(runner, "_renew", renew)
    monkeypatch.setattr(runner, "_flush", flush)
    monkeypatch.setattr(runner, "_finish", finish)
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_args: provider)
    await runner._run(claim)
    return "".join(saved), result


async def test_private_runner_passes_configured_cap_to_graph(monkeypatch):
    class FastProvider:
        name = "mock"
        produced = 0
        closed = False

        async def stream(self, messages, system_prompt):
            try:
                for _ in range(20000):
                    self.produced += 1
                    yield "x"
            finally:
                self.closed = True

    provider = FastProvider()
    content, result = await run_without_storage(monkeypatch, provider, 19)
    assert content == "x" * 19
    assert result["state"] == "completed"
    assert result["reason"] == "length"
    assert provider.produced == 19 and provider.closed


def reader_stubs(monkeypatch, rows=(), *, high=0, generation_state="completed"):
    principal = SimpleNamespace(user_id=uuid4(), session_id=uuid4())

    class JournalReader:
        async def scalars(self, query):
            return SimpleNamespace(all=lambda: list(rows))

    @asynccontextmanager
    async def session_factory():
        yield JournalReader()

    class OwnedService:
        async def session(self, db, session_id):
            return None

        async def generation_row(self, db, session_id, generation_id):
            return SimpleNamespace(state=generation_state, last_event_sequence=high)

    async def authenticated(request):
        return SimpleNamespace(id=principal.session_id), SimpleNamespace(id=principal.user_id)

    async def connected():
        return False

    state = SimpleNamespace(
        session_factory=session_factory,
        chat_scope="runtime-review",
        chat_stream_lock=asyncio.Lock(),
        chat_streams={},
        settings=SimpleNamespace(
            rate_limit_backend="memory",
            chat_stream_limit=3,
            chat_heartbeat_seconds=0,
            chat_poll_seconds=0.01,
        ),
    )
    state.chat_streams[f"weibiye:chat:{state.chat_scope}:streams:{principal.user_id}"] = {
        "slot": time.time() + 15
    }
    request = SimpleNamespace(app=SimpleNamespace(state=state), is_disconnected=connected)
    monkeypatch.setattr(events, "ChatService", lambda *_args: OwnedService())
    monkeypatch.setattr(events, "session_user", authenticated)
    return request, principal


@pytest.mark.parametrize("blocked_release", [False, True])
async def test_asgi_cancellation_shields_slot_cleanup_with_bounded_timeout(
    monkeypatch, blocked_release
):
    ready = anyio.Event()

    class RedisStub:
        entered = False
        released = False

        async def zrem(self, key, token):
            self.entered = True
            if blocked_release:
                await anyio.sleep_forever()
            await anyio.lowlevel.checkpoint()
            self.released = True

    async def blocked_identity(request):
        ready.set()
        await anyio.sleep_forever()

    request, principal = reader_stubs(monkeypatch)
    redis = RedisStub()
    request.app.state.redis = redis
    request.app.state.settings.rate_limit_backend = "redis"
    monkeypatch.setattr(events, "session_user", blocked_identity)

    async def consume():
        async for _ in events.event_iterator(request, principal, uuid4(), uuid4(), 0, "slot"):
            pytest.fail("An identity check still in flight must not emit private events")

    async with anyio.create_task_group() as group:
        group.start_soon(consume)
        await ready.wait()
        started = time.monotonic()
        group.cancel_scope.cancel()
    elapsed = time.monotonic() - started
    assert redis.entered
    assert redis.released is not blocked_release
    assert elapsed < 2
    if blocked_release:
        assert elapsed >= 0.8


@pytest.mark.parametrize("generation_state", ["running", "completed"])
async def test_missing_journal_suffix_returns_connection_error(monkeypatch, generation_state):
    request, principal = reader_stubs(monkeypatch, high=3, generation_state=generation_state)
    iterator = events.event_iterator(request, principal, uuid4(), uuid4(), 1, "slot")
    frame = await asyncio.wait_for(anext(iterator), timeout=1)
    assert "event: error\n" in frame
    assert '"scope": "connection"' in frame
    assert '"code": "STREAM_UNAVAILABLE"' in frame
    assert "id:" not in frame
    with pytest.raises(StopAsyncIteration):
        await anext(iterator)


async def test_active_journal_at_high_water_mark_keeps_waiting(monkeypatch):
    request, principal = reader_stubs(monkeypatch, high=1, generation_state="running")
    async with aclosing(
        events.event_iterator(request, principal, uuid4(), uuid4(), 1, "slot")
    ) as iterator:
        assert await asyncio.wait_for(anext(iterator), timeout=1) == ": ping\n\n"


async def test_completed_journal_at_high_water_mark_closes_normally(monkeypatch):
    request, principal = reader_stubs(monkeypatch, high=3)
    iterator = events.event_iterator(request, principal, uuid4(), uuid4(), 3, "slot")
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(iterator), timeout=1)


async def test_events_committed_after_generation_read_are_replayed_normally(monkeypatch):
    # READ COMMITTED may observe journal rows newer than the generation SELECT.
    rows = [
        SimpleNamespace(event_sequence=2, event_type="delta", payload={"text": "new output"}),
        SimpleNamespace(
            event_sequence=3, event_type="completed", payload={"content": "new output"}
        ),
    ]
    request, principal = reader_stubs(monkeypatch, rows, high=1, generation_state="running")
    iterator = events.event_iterator(request, principal, uuid4(), uuid4(), 1, "slot")
    frames = [frame async for frame in iterator]
    assert [frame.split("event: ", 1)[1].splitlines()[0] for frame in frames] == [
        "delta",
        "completed",
    ]


async def test_private_mock_keeps_normal_persisted_sse_contract(monkeypatch):
    content, result = await run_without_storage(monkeypatch, PrivateMockLLM(), 8000)
    assert result == {"state": "completed", "pending": content, "reason": "stop", "usage": None}
    assert "消息会保存于当前账户；长期记忆仅在你逐条确认后保存。" in content
    assert "没有调用真实模型" in content

    rows = []

    class JournalWriter:
        revision_reads = 0

        async def execute(self, query):
            assert str(query) == "SELECT version_num FROM alembic_version"
            self.revision_reads += 1
            return SimpleNamespace(scalars=lambda: iter(("0005",)))

        def add(self, row):
            rows.append(row)

        async def flush(self):
            pass

    generation = SimpleNamespace(
        id=uuid4(),
        session_id=uuid4(),
        owner_id=uuid4(),
        assistant_message_id=uuid4(),
        last_event_sequence=0,
    )
    writer = JournalWriter()
    await append_event(
        writer,
        generation,
        "start",
        {"user_message_id": str(uuid4()), "state": "queued", "mode": "mock", "persisted": True},
    )
    await append_event(writer, generation, "delta", {"text": content})
    await append_event(
        writer,
        generation,
        "completed",
        {"state": "completed", "content": content, "finish_reason": "stop", "usage": None},
    )
    assert writer.revision_reads == 3
    request, principal = reader_stubs(monkeypatch, rows, high=3)
    iterator = events.event_iterator(
        request, principal, generation.session_id, generation.id, 0, "slot"
    )
    frames = [frame async for frame in iterator]
    assert [frame.split("event: ", 1)[1].splitlines()[0] for frame in frames] == [
        "start",
        "delta",
        "completed",
    ]
    payloads = [json.loads(frame.split("data: ", 1)[1]) for frame in frames]
    assert [payload["sequence"] for payload in payloads] == [1, 2, 3]
    assert payloads[0]["mode"] == "mock" and payloads[0]["persisted"] is True
    assert payloads[1]["text"] == payloads[2]["content"] == content
    assert payloads[2]["finish_reason"] == "stop" and payloads[2]["usage"] is None


async def test_public_demo_keeps_old_nonpersistent_mock_protocol():
    frames = [frame async for frame in mock_demo_events("runtime probe", "runtime-review")]
    assert frames[0].startswith("event: meta\n")
    assert '"persisted": false' in frames[0]
    assert "保存会话或写入长期记忆" in "".join(frames)
    assert frames[-1].startswith("event: done\n")
