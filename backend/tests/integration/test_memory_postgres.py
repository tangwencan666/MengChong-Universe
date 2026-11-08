"""Opt-in acceptance against a pre-migrated, explicitly isolated P4-A database.

This suite never creates, migrates, deletes or truncates a database. Each test
creates identifiable synthetic accounts through the real auth API. Their data
remain as evidence; failed constraint probes roll back their own transactions.
"""

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from auth_helpers import csrf, login, register
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.main import create_app
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.memory.models import (
    Memory,
    MemoryConsentEvent,
    MemoryGenerationRef,
    MemoryOperation,
    MemoryPreferences,
    MemorySource,
)

PREFIX = "/api/v1/memory"
CHAT = "/api/v1/companion"
CONTRACT = {
    "confirmed": True,
    "policy_version": "memory-policy/1",
    "notice_version": "memory-notice/1",
}
pytestmark = pytest.mark.skipif(
    not os.environ.get("WEIBIYE_P4A_TEST_DATABASE_URL"),
    reason="Requires isolated WEIBIYE_P4A_TEST_DATABASE_URL; never falls back to weibiye",
)


@pytest.fixture(scope="module")
def isolated_memory_postgres():
    url = make_url(os.environ["WEIBIYE_P4A_TEST_DATABASE_URL"])
    assert url.drivername in {"postgresql", "postgresql+psycopg"}
    assert not url.query, "Refusing connection option overrides"
    assert (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
    assert re.fullmatch(r"weibiye_p4a_test_[0-9a-f]{32}", url.database or ""), (
        "Refusing a database without the exact isolated P4-A name"
    )
    url = url.set(drivername="postgresql+psycopg")
    engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
    try:
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            assert db.scalar(text("SELECT current_database()")) == url.database
            assert db.scalar(text("SELECT current_user")) == "weibiye"
            assert db.scalar(text("SELECT system_identifier::text FROM pg_control_system()")) == (
                "7703042374370492450"
            )
            assert db.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == [
                "0005"
            ]
            assert (
                len(set(inspect(db).get_table_names(schema="public")) - {"alembic_version"}) == 26
            )
        yield engine, url.render_as_string(hide_password=False)
    finally:
        engine.dispose()


def client_for(settings):
    return TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    )


@pytest.fixture
def pg_memory_accounts(isolated_memory_postgres):
    engine, url = isolated_memory_postgres
    settings = Settings(
        environment="test",
        database_url=SecretStr(url),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        llm_provider="mock",
        real_llm_enabled=False,
        memory_management_enabled=True,
        memory_injection_enabled=False,
        memory_hmac_key=SecretStr("p4a-pg-acceptance-only-not-a-production-key"),
        chat_runner_enabled=False,
        frontend_origin="http://testserver",
        cors_origins=["http://testserver"],
    )
    run = uuid4().hex
    with ExitStack() as stack:
        accounts = []
        for label in ("a", "b"):
            client = stack.enter_context(client_for(settings))
            email = f"p4apg-{run}-{label}@example.com"
            assert register(client, email=email, name=f"P4APG {label}").status_code == 202
            response = login(client, email=email)
            assert response.status_code == 200
            accounts.append((client, UUID(response.json()["id"])))
        assert accounts[0][1] != accounts[1][1]
        yield engine, settings, accounts


def command(client, method, path, payload=None, *, key=None, prefix=PREFIX):
    headers = csrf(client)
    headers["Idempotency-Key"] = key or str(uuid4())
    return client.request(method, prefix + path, json=payload, headers=headers)


def preference(client):
    response = client.get(PREFIX + "/preferences")
    assert response.status_code == 200
    return response.json()


def enable(client):
    current = preference(client)
    response = command(
        client,
        "PATCH",
        "/preferences",
        {
            "long_term_memory_enabled": True,
            "expected_version": current["version"],
            "consent": CONTRACT,
        },
    )
    assert response.status_code == 200
    assert response.json()["long_term_memory_enabled"] is True
    return response.json()


def payload(client, *, content="希望优先了解后端开发岗位。", title="P4APG 求职方向"):
    return {
        "title": title,
        "content": content,
        "category": "career_goal",
        "source": {"kind": "manual"},
        "expected_preferences_version": preference(client)["version"],
        "consent": CONTRACT,
    }


def create_memory(client, *, content="希望优先了解后端开发岗位。", key=None):
    body = payload(client, content=content)
    response = command(client, "POST", "/items", body, key=key)
    assert response.status_code == 201
    return response.json()["item"], body


def race(settings, source, requests):
    """Distinct ASGI lifespans, loops and DB pools exercise PostgreSQL row locks."""
    barrier = Barrier(len(requests))
    cookies = dict(source.cookies)

    def issue(request):
        method, path, body, key = request
        with client_for(settings) as client:
            client.cookies.update(cookies)
            headers = csrf(client)
            headers["Idempotency-Key"] = key
            barrier.wait(timeout=30)
            response = client.request(method, PREFIX + path, json=body, headers=headers)
            return response.status_code, response.json() if response.content else None

    with ThreadPoolExecutor(max_workers=len(requests)) as executor:
        futures = [executor.submit(issue, request) for request in requests]
        return [future.result(timeout=60) for future in futures]


def test_pg_default_off_csrf_and_no_implicit_memory(pg_memory_accounts):
    engine, _, ((a, owner), (b, _)) = pg_memory_accounts
    current = preference(a)
    assert current["long_term_memory_enabled"] is False and current["version"] == 0
    assert preference(b)["long_term_memory_enabled"] is False
    response = command(a, "POST", "/items", payload(a))
    assert response.status_code == 409 and response.json()["error"]["code"] == "MEMORY_DISABLED"
    response = a.patch(
        PREFIX + "/preferences",
        json={"long_term_memory_enabled": True, "expected_version": 0, "consent": CONTRACT},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 403
    with engine.connect() as db:
        assert (
            db.scalar(select(func.count()).select_from(Memory).where(Memory.owner_id == owner)) == 0
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(MemoryPreferences)
                .where(MemoryPreferences.user_id == owner)
            )
            == 0
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(MemoryConsentEvent)
                .where(MemoryConsentEvent.owner_id == owner)
            )
            == 0
        )


def test_pg_simultaneous_same_key_creates_one_fact_and_grant(pg_memory_accounts):
    engine, settings, ((a, owner), _) = pg_memory_accounts
    enable(a)
    body, key = payload(a), str(uuid4())
    results = race(settings, a, [("POST", "/items", body, key), ("POST", "/items", body, key)])
    assert [status for status, _ in results] == [201, 201]
    assert results[0][1]["item"]["id"] == results[1][1]["item"]["id"]
    assert sorted(result["idempotent_replay"] for _, result in results) == [False, True]
    with engine.connect() as db:
        assert (
            db.scalar(select(func.count()).select_from(Memory).where(Memory.owner_id == owner)) == 1
        )
        assert (
            db.scalar(
                select(func.count()).select_from(MemorySource).where(MemorySource.owner_id == owner)
            )
            == 1
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(MemoryConsentEvent)
                .where(
                    MemoryConsentEvent.owner_id == owner, MemoryConsentEvent.action == "confirmed"
                )
            )
            == 1
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(MemoryOperation)
                .where(
                    MemoryOperation.owner_id == owner, MemoryOperation.operation_scope == "create"
                )
            )
            == 1
        )


def test_pg_two_edits_of_same_version_have_one_winner(pg_memory_accounts):
    engine, settings, ((a, owner), _) = pg_memory_accounts
    enable(a)
    item, create_body = create_memory(a)
    common = {key: value for key, value in create_body.items() if key != "source"}
    requests = [
        (
            "PATCH",
            f"/items/{item['id']}",
            {**common, "content": content, "expected_version": 1},
            str(uuid4()),
        )
        for content in ("希望优先了解后端岗位。", "希望优先了解测试开发岗位。")
    ]
    results = race(settings, a, requests)
    assert sorted(status for status, _ in results) == [200, 409]
    winner = next(result for status, result in results if status == 200)
    current = a.get(PREFIX + f"/items/{item['id']}")
    assert current.status_code == 200
    assert current.json()["content"] == winner["content"] and current.json()["version"] == 2
    with engine.connect() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(MemoryConsentEvent)
                .where(
                    MemoryConsentEvent.owner_id == owner, MemoryConsentEvent.action == "corrected"
                )
            )
            == 1
        )


def test_pg_delete_racing_old_create_cannot_restore_erased_body(pg_memory_accounts):
    engine, settings, ((a, owner), _) = pg_memory_accounts
    enable(a)
    key = str(uuid4())
    item, body = create_memory(a, key=key)
    results = race(
        settings,
        a,
        [
            ("DELETE", f"/items/{item['id']}", {"expected_version": 1}, str(uuid4())),
            ("POST", "/items", body, key),
        ],
    )
    assert results[0][0] == 204
    # The replay may linearize before deletion (201) or after it (410).
    assert results[1][0] in {201, 410}
    replay = command(a, "POST", "/items", body, key=key)
    assert replay.status_code == 410 and replay.json()["error"]["code"] == "MEMORY_UNAVAILABLE"
    assert a.get(PREFIX + f"/items/{item['id']}").status_code == 404
    with engine.connect() as db:
        row = db.execute(
            select(
                Memory.status,
                Memory.content,
                Memory.title,
                Memory.summary,
                Memory.active_consent_id,
            ).where(Memory.id == UUID(item["id"]), Memory.owner_id == owner)
        ).one()
        assert tuple(row) == ("deleted", "", "", "", None)
        assert (
            db.scalar(select(func.count()).select_from(Memory).where(Memory.owner_id == owner)) == 1
        )


def test_pg_clear_is_owner_scoped_and_preserves_authorization(pg_memory_accounts):
    engine, _, ((a, owner), (b, other)) = pg_memory_accounts
    enable(a)
    enable(b)
    first, _ = create_memory(a)
    second, _ = create_memory(a, content="希望用简洁自然的方式交流。")
    other_item, _ = create_memory(b, content="希望优先了解前端开发岗位。")
    before = preference(a)
    response = command(
        a, "POST", "/clear", {"confirmed": True, "expected_revision": before["revision"]}
    )
    assert response.status_code == 204
    assert a.get(PREFIX + "/items").json()["items"] == []
    assert preference(a)["long_term_memory_enabled"] is True
    assert b.get(PREFIX + f"/items/{other_item['id']}").status_code == 200
    assert a.get(PREFIX + f"/items/{first['id']}").status_code == 404
    assert a.get(PREFIX + f"/items/{second['id']}").status_code == 404
    with engine.connect() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Memory)
                .where(
                    Memory.owner_id == owner,
                    Memory.status == "deleted",
                    Memory.content == "",
                    Memory.summary == "",
                    Memory.title == "",
                )
            )
            == 2
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(Memory)
                .where(Memory.owner_id == other, Memory.status == "active")
            )
            == 1
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(MemoryConsentEvent)
                .where(
                    MemoryConsentEvent.owner_id == owner,
                    MemoryConsentEvent.action == "deleted",
                    MemoryConsentEvent.affected_all.is_(True),
                )
            )
            == 1
        )


def test_pg_stale_clear_revision_does_not_erase_new_confirmation(pg_memory_accounts):
    _, _, ((a, _), _) = pg_memory_accounts
    enable(a)
    old = preference(a)
    item, _ = create_memory(a)
    response = command(
        a, "POST", "/clear", {"confirmed": True, "expected_revision": old["revision"]}
    )
    assert response.status_code == 409
    assert a.get(PREFIX + f"/items/{item['id']}").status_code == 200


def test_pg_cross_owner_management_sources_and_export_remain_isolated(pg_memory_accounts):
    _, _, ((a, _), (b, _)) = pg_memory_accounts
    enable(a)
    enable(b)
    item, body = create_memory(a)
    other, _ = create_memory(b, content="希望优先了解设计岗位。")
    assert b.get(PREFIX + f"/items/{item['id']}").status_code == 404
    assert b.get(PREFIX + f"/items/{item['id']}/sources").status_code == 404
    edit = {key: value for key, value in body.items() if key != "source"}
    assert (
        command(b, "PATCH", f"/items/{item['id']}", {**edit, "expected_version": 1}).status_code
        == 404
    )
    assert command(b, "DELETE", f"/items/{item['id']}", {"expected_version": 1}).status_code == 404
    exported = command(b, "POST", "/export", {"format": "json", "include_inactive": True})
    assert exported.status_code == 200 and exported.headers["cache-control"] == "no-store"
    assert {record["id"] for record in exported.json()["items"]} == {other["id"]}
    assert a.get(PREFIX + f"/items/{item['id']}").status_code == 200


def test_pg_revoke_is_independent_of_recent_topic_and_export(pg_memory_accounts):
    _, _, ((a, _), (b, _)) = pg_memory_accounts
    enable(a)
    item, _ = create_memory(a)
    topic = a.get(CHAT + "/preferences").json()
    topic_enabled = command(
        a,
        "PATCH",
        "/preferences",
        {"recent_topic_enabled": True, "expected_version": topic["version"]},
        prefix=CHAT,
    )
    assert topic_enabled.status_code == 200
    before = preference(a)
    response = command(
        a,
        "PATCH",
        "/preferences",
        {"long_term_memory_enabled": False, "expected_version": before["version"]},
    )
    assert response.status_code == 200 and response.json()["long_term_memory_enabled"] is False
    assert a.get(CHAT + "/preferences").json()["recent_topic_enabled"] is True
    assert preference(b)["long_term_memory_enabled"] is False
    assert a.get(PREFIX).json() == []
    assert a.get(PREFIX + f"/{item['id']}").status_code == 404
    current = a.get(PREFIX + f"/items/{item['id']}")
    assert current.status_code == 200 and current.json()["status"] == "revoked"
    assert command(a, "POST", "/items", payload(a)).status_code == 409
    exported = command(a, "POST", "/export", {"format": "json", "include_inactive": True})
    assert exported.status_code == 200 and exported.json()["items"][0]["status"] == "revoked"


def test_pg_grant_owner_version_and_erasure_constraints_are_real(pg_memory_accounts):
    engine, _, ((a, owner), (_, other)) = pg_memory_accounts
    enable(a)
    item, _ = create_memory(a)
    memory_id = UUID(item["id"])
    with pytest.raises(IntegrityError) as bad_owner, engine.begin() as db:
        db.execute(
            MemoryConsentEvent.__table__.insert().values(
                id=uuid4(),
                owner_id=other,
                revision=999,
                action="confirmed",
                memory_id=memory_id,
                memory_version=1,
                policy_version="memory-policy/1",
                notice_version="memory-notice/1",
                privacy_epoch=1,
            )
        )
    assert bad_owner.value.orig.sqlstate == "23503"
    with pytest.raises(IntegrityError) as bad_version, engine.begin() as db:
        db.execute(
            Memory.__table__.update()
            .where(Memory.id == memory_id, Memory.owner_id == owner)
            .values(version=2)
        )
    assert bad_version.value.orig.sqlstate == "23503"
    with pytest.raises(IntegrityError) as bad_erasure, engine.begin() as db:
        db.execute(
            Memory.__table__.update()
            .where(Memory.id == memory_id, Memory.owner_id == owner)
            .values(status="deleted", active_consent_id=None, deleted_at=func.now())
        )
    assert bad_erasure.value.orig.sqlstate == "23514"
    assert a.get(PREFIX + f"/items/{memory_id}").json()["version"] == 1


def test_pg_v5_chat_persists_mock_sse_without_memory_injection(pg_memory_accounts):
    engine, settings, ((a, owner), _) = pg_memory_accounts
    runtime = settings.model_copy(
        update={
            "chat_runner_enabled": True,
            "chat_run_timeout_seconds": 10,
            "chat_first_chunk_timeout_seconds": 5,
        }
    )
    with client_for(runtime) as client:
        client.cookies.update(dict(a.cookies))
        response = command(
            client, "POST", "/sessions", {"title": "P4APG V5 chat regression"}, prefix=CHAT
        )
        assert response.status_code == 201
        session = response.json()["session"]["id"]
        sent = command(
            client,
            "POST",
            f"/sessions/{session}/messages",
            {"client_message_id": str(uuid4()), "content": "P4APG 合成聊天冒烟。"},
            prefix=CHAT,
        )
        assert sent.status_code == 202
        accepted = sent.json()
        stream = client.get(accepted["events_url"], headers={"Accept": "text/event-stream"})
        assert stream.status_code == 200 and "text/event-stream" in stream.headers["content-type"]
        frames = []
        for frame in stream.text.replace("\r\n", "\n").split("\n\n"):
            data = next(
                (line[6:] for line in frame.splitlines() if line.startswith("data: ")), None
            )
            kind = next(
                (line[7:] for line in frame.splitlines() if line.startswith("event: ")), None
            )
            if data is not None:
                frames.append((kind, json.loads(data)))
        assert frames[0][0] == "start" and frames[-1][0] == "completed"
        assert any(kind == "delta" for kind, _ in frames)
        generation_id = UUID(accepted["generation"]["id"])
        assert [data["sequence"] for _, data in frames] == list(range(1, len(frames) + 1))
        assert all(data["generation_id"] == str(generation_id) for _, data in frames)
        history = client.get(CHAT + f"/sessions/{session}/messages").json()["items"]
        assert len(history) == 2 and history[-1]["content"] == frames[-1][1]["content"]
        assert history[-1]["status"] == "completed"
        with engine.connect() as db:
            assert (
                db.scalar(
                    select(ChatGeneration.state).where(
                        ChatGeneration.id == generation_id, ChatGeneration.owner_id == owner
                    )
                )
                == "completed"
            )
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ChatMessage)
                    .where(ChatMessage.session_id == UUID(session), ChatMessage.owner_id == owner)
                )
                == 2
            )
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ChatGenerationEvent)
                    .where(
                        ChatGenerationEvent.generation_id == generation_id,
                        ChatGenerationEvent.event_type == "completed",
                    )
                )
                == 1
            )
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(MemoryGenerationRef)
                    .where(MemoryGenerationRef.generation_id == generation_id)
                )
                == 0
            )
