"""Finite HTTP replay checks; no test waits on an unbounded TestClient stream."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update
from starlette.requests import Request
from test_chat import (  # noqa: F401
    PREFIX,
    assert_error,
    command,
    create_session,
    generation_path,
    identity,
    run_one,
    send,
)
from test_chat import (
    chat_client as chat_client,
)
from test_chat import (
    chat_database as chat_database,
)

from app.agent.chat_runner import ChatRunner
from app.core.event_loop import new_event_loop
from app.db.base import Base
from app.main import create_app
from app.modules.auth.models import AuthSession
from app.modules.auth.service import digest, principal_for
from app.modules.companion.events import prepare_events


def parse_frames(body):
    frames = []
    for block in body.replace("\r\n", "\n").split("\n\n"):
        if not block.strip() or block.startswith(":"):
            continue
        fields = {}
        data = []
        for line in block.splitlines():
            key, _, value = line.partition(":")
            if key == "data":
                data.append(value.lstrip(" "))
            else:
                fields[key] = value.lstrip(" ")
        fields["data"] = json.loads("\n".join(data))
        frames.append(fields)
    return frames


def assert_generation_frames(frames, accepted, session_id):
    assert frames
    generation = accepted["generation"]
    for index, frame in enumerate(frames, 1):
        payload = frame["data"]
        assert frame["id"] == f"{generation['id']}:{index}"
        assert payload["version"] == 1 and payload["scope"] == "generation"
        assert payload["sequence"] == index
        assert payload["generation_id"] == generation["id"]
        assert payload["session_id"] == session_id
        assert payload["message_id"] == accepted["assistant_message"]["id"]
        assert payload["occurred_at"].endswith("Z")
    assert frames[0]["event"] == "start"
    assert frames[0]["data"]["state"] == "queued"
    assert frames[0]["data"]["mode"] == "mock"
    assert frames[0]["data"]["persisted"] is True
    assert frames[0]["data"]["user_message_id"] == accepted["user_message"]["id"]
    assert (
        len([frame for frame in frames if frame["event"] in {"completed", "error", "cancelled"}])
        == 1
    )


def test_completed_replay_is_ordered_exclusive_and_read_only(chat_client, chat_database):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    run_one(chat_client)
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"])
    table_names = ["chat_messages", "chat_generations", "chat_generation_events"]
    with chat_database[0].connect() as db:
        counts = {
            name: db.scalar(select(func.count()).select_from(Base.metadata.tables[name]))
            for name in table_names
        }
    response = chat_client.get(path + "/events")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert "no-cache" in response.headers["cache-control"]
    assert "no-store" in response.headers["cache-control"]
    assert response.headers["x-accel-buffering"] == "no"
    frames = parse_frames(response.text)
    assert_generation_frames(frames, accepted, session["id"])
    assert frames[-1]["event"] == "completed"
    assert frames[-1]["data"]["state"] == "completed"
    assert frames[-1]["data"]["finish_reason"] == "stop"
    assert frames[-1]["data"]["usage"] is None
    deltas = [frame["data"]["text"] for frame in frames if frame["event"] == "delta"]
    assert deltas and all(deltas)
    assert "".join(deltas) == frames[-1]["data"]["content"]
    snapshot = chat_client.get(path).json()
    assert snapshot["assistant_message"]["content"] == frames[-1]["data"]["content"]
    assert snapshot["resume_after_event_id"] == frames[-1]["id"]
    for frame in frames:
        resumed = chat_client.get(path + "/events", headers={"Last-Event-ID": frame["id"]})
        assert resumed.status_code == 200
        assert [item["id"] for item in parse_frames(resumed.text)] == [
            item["id"] for item in frames[frame["data"]["sequence"] :]
        ]
    with chat_database[0].connect() as db:
        assert {
            name: db.scalar(select(func.count()).select_from(Base.metadata.tables[name]))
            for name in table_names
        } == counts


def test_cancelled_queue_has_one_terminal_event_and_empty_preserved_content(chat_client):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    path = generation_path(session["id"], accepted["generation"]["id"])
    for _ in range(2):
        assert command(chat_client, "POST", path + "/cancel", {}).status_code == 200
    frames = parse_frames(chat_client.get(PREFIX + path + "/events").text)
    assert_generation_frames(frames, accepted, session["id"])
    assert [frame["event"] for frame in frames] == ["start", "cancelled"]
    assert frames[-1]["data"]["state"] == "cancelled"
    assert frames[-1]["data"]["reason"] == "user_requested"
    assert frames[-1]["data"]["content"] == ""
    snapshot = chat_client.get(PREFIX + path).json()
    assert snapshot["assistant_message"]["status"] == "cancelled"
    assert snapshot["resume_after_event_id"] == frames[-1]["id"]


@pytest.mark.parametrize(
    "invalid", ["bad-id", "foreign", "future", "negative", "decimal", "oversize"]
)
def test_invalid_last_event_ids_are_rejected_before_stream_headers(chat_client, invalid):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    path = generation_path(session["id"], accepted["generation"]["id"])
    command(chat_client, "POST", path + "/cancel", {})
    generation_id = accepted["generation"]["id"]
    value = {
        "bad-id": "malformed",
        "foreign": str(uuid4()) + ":1",
        "future": generation_id + ":999999",
        "negative": generation_id + ":-1",
        "decimal": generation_id + ":1.5",
        "oversize": generation_id + ":" + "9" * 2000,
    }[invalid]
    response = chat_client.get(PREFIX + path + "/events", headers={"Last-Event-ID": value})
    assert_error(response, 422, "INVALID_EVENT_ID")
    assert response.headers["content-type"].startswith("application/json")


def test_expired_replay_is_410_but_consistent_snapshot_remains_available(
    chat_client, chat_database
):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    run_one(chat_client)
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"])
    generation = Base.metadata.tables["chat_generations"]
    with chat_database[0].begin() as db:
        db.execute(
            update(generation)
            .where(generation.c.id == UUID(accepted["generation"]["id"]))
            .values(finished_at=datetime.now(UTC) - timedelta(hours=25))
        )
    for headers in [{}, {"Last-Event-ID": accepted["generation"]["last_event_id"]}]:
        assert_error(
            chat_client.get(path + "/events", headers=headers), 410, "EVENT_REPLAY_EXPIRED"
        )
    snapshot = chat_client.get(path)
    assert snapshot.status_code == 200
    assert snapshot.json()["generation"]["state"] == "completed"
    assert snapshot.json()["assistant_message"]["content"]


def test_generation_ids_do_not_cross_parent_sessions(chat_client):
    identity(chat_client)
    first = create_session(chat_client)
    second = create_session(chat_client)
    accepted = send(chat_client, first["id"])
    right_path = generation_path(first["id"], accepted["generation"]["id"])
    command(chat_client, "POST", right_path + "/cancel", {})
    wrong_path = generation_path(second["id"], accepted["generation"]["id"])
    for suffix in ["", "/events"]:
        assert_error(chat_client.get(PREFIX + wrong_path + suffix), 404, "RESOURCE_NOT_FOUND")
    assert_error(
        command(chat_client, "POST", wrong_path + "/cancel", {}), 404, "RESOURCE_NOT_FOUND"
    )


def test_event_id_cors_header_is_allowed_only_from_explicit_origin(chat_client):
    allowed = chat_client.options(
        PREFIX + "/sessions",
        headers={
            "Origin": "http://testserver",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Last-Event-ID",
        },
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://testserver"
    assert allowed.headers["access-control-allow-credentials"] == "true"
    rejected = chat_client.options(
        PREFIX + "/sessions",
        headers={
            "Origin": "https://foreign.invalid",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Last-Event-ID",
        },
    )
    assert rejected.status_code == 400
    assert "access-control-allow-origin" not in rejected.headers


def install_provider(monkeypatch, provider):
    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", lambda *_: provider)


def test_provider_failure_preserves_committed_partial_and_never_emits_completed(
    chat_client, monkeypatch
):
    class FailingProvider:
        name = "mock"

        async def stream(self, messages, system_prompt):
            yield "已经提交的部分。" * 40
            raise RuntimeError("private-sdk-error-and-secret-must-not-escape")

    install_provider(monkeypatch, FailingProvider())
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    run_one(chat_client)
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"])
    snapshot = chat_client.get(path)
    assert snapshot.json()["generation"]["state"] == "failed"
    assert snapshot.json()["generation"]["error"]["code"] == "PROVIDER_FAILED"
    assert snapshot.json()["assistant_message"]["content"] == "已经提交的部分。" * 40
    response = chat_client.get(path + "/events")
    frames = parse_frames(response.text)
    assert_generation_frames(frames, accepted, session["id"])
    assert frames[-1]["event"] == "error"
    assert frames[-1]["data"]["state"] == "failed"
    assert frames[-1]["data"]["content"] == snapshot.json()["assistant_message"]["content"]
    assert "private-sdk-error" not in response.text + snapshot.text
    assert all(frame["event"] != "completed" for frame in frames)


def test_output_limit_is_completed_with_visible_length_reason(chat_client, monkeypatch):
    class LongProvider:
        name = "mock"

        async def stream(self, messages, system_prompt):
            yield "🧪" * 9000

    install_provider(monkeypatch, LongProvider())
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    run_one(chat_client)
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"])
    frames = parse_frames(chat_client.get(path + "/events").text)
    assert frames[-1]["event"] == "completed"
    assert frames[-1]["data"]["finish_reason"] == "length"
    assert frames[-1]["data"]["content"] == "🧪" * 8000
    assert (
        "".join(frame["data"]["text"] for frame in frames if frame["event"] == "delta")
        == "🧪" * 8000
    )


def test_actual_provider_context_contains_completed_rounds_and_retry_input_once(
    chat_client, monkeypatch
):
    seen = []

    class RecordingProvider:
        name = "mock"

        async def stream(self, messages, system_prompt):
            seen.append((messages, system_prompt))
            yield "上一轮成功的回复"

    install_provider(monkeypatch, RecordingProvider())
    identity(chat_client)
    session = create_session(chat_client)
    send(chat_client, session["id"], "第一轮输入")
    run_one(chat_client)
    cancelled = send(chat_client, session["id"], "需要重试的输入")
    command(
        chat_client,
        "POST",
        generation_path(session["id"], cancelled["generation"]["id"]) + "/cancel",
        {},
    )
    retry = command(
        chat_client,
        "POST",
        f"/sessions/{session['id']}/generations",
        {"retry_of_generation_id": cancelled["generation"]["id"]},
        key=str(uuid4()),
    )
    assert retry.status_code == 202
    run_one(chat_client)
    assert seen[0][0] == [{"role": "user", "content": "第一轮输入"}]
    assert seen[1][0] == [
        {"role": "user", "content": "第一轮输入"},
        {"role": "assistant", "content": "上一轮成功的回复"},
        {"role": "user", "content": "需要重试的输入"},
    ]
    assert seen[0][1] and seen[0][1] == seen[1][1]


@pytest.mark.parametrize("remove_session", [False, True])
def test_running_cancel_or_delete_closes_provider_and_prevents_late_body_writes(
    chat_client, chat_database, monkeypatch, remove_session
):
    waiting, closed, committed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    partial = "已持久化" * 80
    original_flush = chat_client.app.state.chat_runner._flush

    async def observe_commit(claim, text):
        await original_flush(claim, text)
        committed.set()

    monkeypatch.setattr(chat_client.app.state.chat_runner, "_flush", observe_commit)

    class HoldingProvider:
        name = "mock"

        async def stream(self, messages, system_prompt):
            try:
                yield partial
                waiting.set()
                await asyncio.Event().wait()
                yield "迟到内容绝不能保存"
            finally:
                closed.set()

    async def await_signal(signal):
        await asyncio.wait_for(signal.wait(), timeout=5)

    install_provider(monkeypatch, HoldingProvider())
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    task = chat_client.portal.start_task_soon(chat_client.app.state.chat_runner.run_once)
    try:
        chat_client.portal.call(await_signal, waiting)
        # LangGraph's writer queues without waiting for the consumer's DB commit.
        # This case tests preservation of committed data, not buffered provider data.
        chat_client.portal.call(await_signal, committed)
        path = generation_path(session["id"], accepted["generation"]["id"])
        if remove_session:
            response = command(chat_client, "DELETE", f"/sessions/{session['id']}")
            assert response.status_code == 204
        else:
            response = command(chat_client, "POST", path + "/cancel", {})
            assert response.status_code == 202
            assert response.json()["generation"]["state"] == "cancel_requested"
        assert task.result(timeout=5)
        chat_client.portal.call(await_signal, closed)
        with chat_database[0].connect() as db:
            messages = Base.metadata.tables["chat_messages"]
            assistant = (
                db.execute(
                    select(messages).where(
                        messages.c.id == UUID(accepted["assistant_message"]["id"])
                    )
                )
                .mappings()
                .one()
            )
            assert assistant["content"] == partial
            assert assistant["status"] == "cancelled"
        if remove_session:
            assert_error(chat_client.get(PREFIX + path), 404, "RESOURCE_NOT_FOUND")
        else:
            frames = parse_frames(chat_client.get(PREFIX + path + "/events").text)
            assert_generation_frames(frames, accepted, session["id"])
            assert frames[-1]["event"] == "cancelled"
            assert all(frame["event"] != "completed" for frame in frames)
    finally:
        if not task.done():
            chat_client.portal.call(
                chat_client.app.state.chat_runner.cancel, UUID(accepted["generation"]["id"])
            )
            task.result(timeout=5)


@pytest.mark.parametrize("remove_session", [False, True])
def test_running_cancel_before_first_flush_discards_uncommitted_provider_chunk(
    chat_client, chat_database, monkeypatch, remove_session
):
    reached_flush, closed = asyncio.Event(), asyncio.Event()

    class UncommittedProvider:
        name = "mock"

        async def stream(self, messages, system_prompt):
            try:
                yield "尚未提交的内容" * 80
                await asyncio.Event().wait()
            finally:
                closed.set()

    async def paused_flush(_claim, _text):
        reached_flush.set()
        await asyncio.Event().wait()
        raise AssertionError("Cancelled generation must never resume a buffered flush")

    async def await_signal(signal):
        await asyncio.wait_for(signal.wait(), timeout=5)

    install_provider(monkeypatch, UncommittedProvider())
    runner = chat_client.app.state.chat_runner
    monkeypatch.setattr(runner, "_flush", paused_flush)
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    task = chat_client.portal.start_task_soon(runner.run_once)
    try:
        chat_client.portal.call(await_signal, reached_flush)
        path = generation_path(session["id"], accepted["generation"]["id"])
        response = (
            command(chat_client, "DELETE", f"/sessions/{session['id']}")
            if remove_session
            else command(chat_client, "POST", path + "/cancel", {})
        )
        assert response.status_code == (204 if remove_session else 202)
        assert task.result(timeout=5)
        chat_client.portal.call(await_signal, closed)
        with chat_database[0].connect() as db:
            messages = Base.metadata.tables["chat_messages"]
            assistant = db.execute(
                select(messages.c.content, messages.c.status).where(
                    messages.c.id == UUID(accepted["assistant_message"]["id"])
                )
            ).one()
            assert tuple(assistant) == ("", "cancelled")
        if not remove_session:
            frames = parse_frames(chat_client.get(PREFIX + path + "/events").text)
            assert [frame["event"] for frame in frames] == ["start", "cancelled"]
            assert frames[-1]["data"]["content"] == ""
    finally:
        if not task.done():
            chat_client.portal.call(runner.cancel, UUID(accepted["generation"]["id"]))
            task.result(timeout=5)


@pytest.mark.parametrize(
    "state,code", [("running", "SERVER_RESTARTED"), ("queued", "QUEUE_TIMEOUT")]
)
def test_recovery_terminalizes_expired_work_without_calling_provider(
    chat_client, chat_database, monkeypatch, state, code
):
    def forbidden(*args):
        raise AssertionError("Expired work must not be sent to a provider")

    monkeypatch.setattr("app.agent.chat_runner.build_private_provider", forbidden)
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    generation = Base.metadata.tables["chat_generations"]
    messages = Base.metadata.tables["chat_messages"]
    past = datetime.now(UTC) - timedelta(minutes=5)
    values = {"state": state, "created_at": past}
    if state == "running":
        values.update(started_at=past, lease_expires_at=past, lease_version=1)
    with chat_database[0].begin() as db:
        db.execute(
            update(generation)
            .where(generation.c.id == UUID(accepted["generation"]["id"]))
            .values(**values)
        )
        if state == "running":
            db.execute(
                update(messages)
                .where(messages.c.id == UUID(accepted["assistant_message"]["id"]))
                .values(status="streaming")
            )
    run_one(chat_client)
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"])
    snapshot = chat_client.get(path).json()
    assert snapshot["generation"]["state"] == "failed"
    assert snapshot["generation"]["error"]["code"] == code
    frames = parse_frames(chat_client.get(path + "/events").text)
    assert [frame["event"] for frame in frames] == ["start", "error"]
    assert frames[-1]["data"]["error"]["code"] == code


def test_open_stream_stops_after_database_session_revocation_without_changing_job(
    chat_client, chat_database
):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    token = chat_client.cookies.get("weibiye_session")
    path = PREFIX + generation_path(session["id"], accepted["generation"]["id"]) + "/events"

    async def capture_revoked_stream():
        received = False
        revoked = False
        disconnected = asyncio.Event()
        bodies = []
        status = None

        async def receive():
            nonlocal received
            if not received:
                received = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def capture(message):
            nonlocal revoked, status
            if message["type"] == "http.response.start":
                status = message["status"]
            elif message["type"] == "http.response.body":
                body = message.get("body", b"").decode("utf-8")
                bodies.append(body)
                # Change the authoritative auth row only after a real private frame
                # has passed the app's ASGI send boundary on an already-open stream.
                if "event: start" in body and not revoked:
                    async with chat_client.app.state.session_factory() as db, db.begin():
                        await db.execute(
                            update(AuthSession)
                            .where(AuthSession.token_hash == digest(token))
                            .values(revoked_at=datetime.now(UTC))
                        )
                    revoked = True

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"host", b"testserver"),
                (b"cookie", f"weibiye_session={token}".encode()),
                (b"accept", b"text/event-stream"),
            ],
            "client": ("127.0.0.1", 44001),
            "server": ("testserver", 80),
        }
        try:
            await asyncio.wait_for(chat_client.app(scope, receive, capture), timeout=7)
        finally:
            disconnected.set()
        assert status == 200 and revoked
        return "".join(bodies)

    frames = parse_frames(chat_client.portal.call(capture_revoked_stream))
    assert [frame["event"] for frame in frames] == ["start", "error"]
    assert "id" not in frames[-1]
    assert frames[-1]["data"] == {
        "version": 1,
        "scope": "connection",
        "error": {
            "code": "AUTHENTICATION_REQUIRED",
            "message": frames[-1]["data"]["error"]["message"],
            "retryable": False,
        },
    }
    with chat_database[0].connect() as db:
        generations = Base.metadata.tables["chat_generations"]
        events = Base.metadata.tables["chat_generation_events"]
        assert (
            db.scalar(
                select(generations.c.state).where(
                    generations.c.id == UUID(accepted["generation"]["id"])
                )
            )
            == "queued"
        )
        assert db.scalar(select(func.count()).select_from(events)) == 1


def test_background_supervisor_completes_without_any_event_subscriber(chat_database, monkeypatch):
    finished = asyncio.Event()
    original_finish = ChatRunner._finish

    class ImmediateProvider:
        name = "mock"

        async def stream(self, messages, system_prompt):
            yield "没有打开事件连接，后台任务也会保存完成的回复。"

    async def observe_committed_finish(runner, *args, **kwargs):
        result = await original_finish(runner, *args, **kwargs)
        finished.set()
        return result

    async def wait_for_finish():
        await asyncio.wait_for(finished.wait(), timeout=5)

    install_provider(monkeypatch, ImmediateProvider())
    monkeypatch.setattr(ChatRunner, "_finish", observe_committed_finish)
    settings = chat_database[1].model_copy(update={"chat_runner_enabled": True})
    with TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    ) as client:
        identity(client)
        session = create_session(client)
        accepted = send(client, session["id"])
        client.portal.call(wait_for_finish)
        snapshot = client.get(
            PREFIX + generation_path(session["id"], accepted["generation"]["id"])
        ).json()
        assert snapshot["generation"]["state"] == "completed"
        assert (
            snapshot["assistant_message"]["content"]
            == "没有打开事件连接，后台任务也会保存完成的回复。"
        )


def test_lost_stream_slot_stops_before_next_persisted_private_frame(chat_client, chat_database):
    identity(chat_client)
    session = create_session(chat_client)
    accepted = send(chat_client, session["id"])
    run_one(chat_client)
    token = chat_client.cookies.get("weibiye_session")
    session_id, generation_id = UUID(session["id"]), UUID(accepted["generation"]["id"])

    async def capture_lost_slot():
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        request = Request(
            {
                "type": "http",
                "app": chat_client.app,
                "method": "GET",
                "scheme": "http",
                "path": PREFIX + generation_path(str(session_id), str(generation_id)) + "/events",
                "query_string": b"",
                "headers": [(b"cookie", f"weibiye_session={token}".encode())],
                "client": ("127.0.0.1", 44002),
                "server": ("testserver", 80),
            },
            receive=receive,
        )
        principal = await principal_for(request)
        iterator = await prepare_events(request, principal, session_id, generation_id, None)
        try:
            first = await asyncio.wait_for(anext(iterator), timeout=3)
            assert parse_frames(first)[0]["event"] == "start"
            # Expire only this connection's independent chat slot after the first
            # frame, while the already-read terminal batch still has body deltas.
            for slots in chat_client.app.state.chat_streams.values():
                for key in slots:
                    slots[key] = 0
            second = await asyncio.wait_for(anext(iterator), timeout=3)
            with pytest.raises(StopAsyncIteration):
                await asyncio.wait_for(anext(iterator), timeout=3)
            return first + second
        finally:
            await iterator.aclose()

    frames = parse_frames(chat_client.portal.call(capture_lost_slot))
    assert [frame["event"] for frame in frames] == ["start", "error"]
    assert "id" not in frames[-1]
    assert frames[-1]["data"]["scope"] == "connection"
    assert frames[-1]["data"]["error"]["code"] == "STREAM_UNAVAILABLE"
    assert frames[-1]["data"]["error"]["retryable"] is True
    assert "text" not in frames[-1]["data"] and "content" not in frames[-1]["data"]
    with chat_database[0].connect() as db:
        generations = Base.metadata.tables["chat_generations"]
        assert (
            db.scalar(select(generations.c.state).where(generations.c.id == generation_id))
            == "completed"
        )
