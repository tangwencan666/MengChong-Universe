"""Opt-in pet isolation against an already migrated, dedicated PostgreSQL database.

Never creates/migrates/removes databases or deletes existing rows. Synthetic test
accounts are identifiable and retained. Failed constraint probes roll back only
their own transaction; no development-database fallback is permitted.
"""

import asyncio
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import UTC, datetime
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, func, inspect, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from app.core.config import Settings
from app.core.event_loop import new_event_loop
from app.db.capabilities import PET_TABLES, require_capability
from app.db.session import build_database
from app.main import create_app
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatMessage
from app.modules.pets.models import (
    Pet,
    PetChatBinding,
    PetMemory,
    PetMemoryConsent,
    PetMemorySource,
)
from tests.auth_helpers import csrf, login, register

PREFIX = "/api/v1/pets"
CLUSTER = "7703042374370492450"
pytestmark = pytest.mark.skipif(
    not os.environ.get("WEIBIYE_PET_TEST_DATABASE_URL"),
    reason="Requires isolated WEIBIYE_PET_TEST_DATABASE_URL; never falls back to weibiye",
)


@pytest.fixture(scope="module")
def isolated_pet_database():
    url = make_url(os.environ["WEIBIYE_PET_TEST_DATABASE_URL"])
    assert url.drivername in {"postgresql", "postgresql+psycopg"}
    assert not url.query, "Refusing connection option overrides"
    assert (url.host, url.port, url.username) == ("127.0.0.1", 25433, "weibiye")
    assert re.fullmatch(r"weibiye_pet_test_[0-9a-f]{32}", url.database or ""), (
        "Refusing a database without the exact isolated pet-test name"
    )
    url = url.set(drivername="postgresql+psycopg")
    engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
    try:
        with engine.connect() as db:
            db.execute(text("SET TRANSACTION READ ONLY"))
            assert db.scalar(text("SELECT current_database()")) == url.database
            assert db.scalar(text("SELECT current_user")) == "weibiye"
            assert (
                db.scalar(text("SELECT system_identifier::text FROM pg_control_system()"))
                == CLUSTER
            )
            assert int(db.scalar(text("SHOW server_version_num"))) // 10000 == 17
            assert db.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == [
                "0006"
            ]
            tables = set(inspect(db).get_table_names(schema="public")) - {"alembic_version"}
            assert len(tables) == 34 and PET_TABLES <= tables
        yield engine, url.render_as_string(hide_password=False)
    finally:
        engine.dispose()


def client_for(settings):
    return TestClient(
        create_app(settings),
        backend_options={"loop_factory": new_event_loop},
        headers={"Origin": "http://testserver"},
    )


def command(client, method, path="", payload=None, key=None):
    headers = csrf(client)
    headers["Idempotency-Key"] = key or str(uuid4())
    return client.request(method, PREFIX + path, json=payload, headers=headers)


def create_pet(client, label):
    response = command(client, "POST", payload={"name": label, "role_type": "cat"})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def pet_accounts(isolated_pet_database):
    engine, url = isolated_pet_database
    settings = Settings(
        environment="test",
        database_url=SecretStr(url),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        auth_store_backend="memory",
        rate_limit_backend="memory",
        llm_provider="mock",
        real_llm_enabled=False,
        chat_runner_enabled=False,
        memory_management_enabled=True,
        memory_injection_enabled=True,
        memory_hmac_key=SecretStr("pet-postgres-test-only-not-a-production-key"),
        frontend_origin="http://testserver",
        cors_origins=["http://testserver"],
    )
    run = uuid4().hex
    with ExitStack() as stack:
        accounts = []
        for label in ["a", "b"]:
            client = stack.enter_context(client_for(settings))
            email = f"petpg-{run}-{label}@example.com"
            assert register(client, email=email, name="PetPG " + label).status_code == 202
            signed_in = login(client, email=email)
            assert signed_in.status_code == 200
            pets = [create_pet(client, f"PetPG {label}{number}") for number in [1, 2]]
            accounts.append((client, UUID(signed_in.json()["id"]), pets))
        assert accounts[0][1] != accounts[1][1]
        yield engine, settings, accounts


def race(settings, source, requests):
    barrier = Barrier(len(requests))
    cookies = dict(source.cookies)

    def issue(prepared):
        client, method, path, payload, headers = prepared
        barrier.wait(timeout=30)
        response = client.request(method, PREFIX + path, json=payload, headers=headers)
        return response.status_code, response.json() if response.content else None

    with ExitStack() as stack:
        prepared = []
        for method, path, payload, key in requests:
            client = stack.enter_context(client_for(settings))
            client.cookies.update(cookies)
            # Build each application's effective routes sequentially. FastAPI's
            # lazy Pydantic construction temporarily changes process-wide warning
            # filters; concurrent cold startup can otherwise turn a framework
            # warning into a request failure under pytest's strict warning policy.
            # HTTP commands still race on independent loops, engines and pools.
            client.app.openapi()
            headers = csrf(client)
            headers["Idempotency-Key"] = key
            prepared.append((client, method, path, payload, headers))
        with ThreadPoolExecutor(max_workers=len(requests)) as pool:
            pending = [pool.submit(issue, request) for request in prepared]
            return [future.result(timeout=60) for future in pending]


def test_pg_pet_manifest_and_two_account_isolation(pet_accounts):
    _, _, ((a, _, pets_a), (b, _, pets_b)) = pet_accounts
    for client, own, foreign in [(a, pets_a, pets_b), (b, pets_b, pets_a)]:
        assert {row["pet_id"] for row in client.get(PREFIX).json()["items"]} == {
            row["pet_id"] for row in own
        }
        for pet in own:
            preferences = client.get(PREFIX + "/" + pet["pet_id"] + "/memory/preferences")
            assert preferences.status_code == 200
            assert preferences.json()["long_term_memory_enabled"] is False
        for pet in foreign:
            assert client.get(PREFIX + "/" + pet["pet_id"]).status_code == 404
            assert (
                command(
                    client, "PATCH", "/" + pet["pet_id"], {"expected_version": 1, "name": "blocked"}
                ).status_code
                == 404
            )

    async def manifest():
        engine, factory = build_database(pet_accounts[1].database_url.get_secret_value())
        try:
            async with factory() as db:
                for capability in ["chat", "memory", "pets"]:
                    assert await require_capability(db, capability, verify_schema=True) == "0006"
        finally:
            await engine.dispose()

    with asyncio.Runner(loop_factory=new_event_loop) as runner:
        runner.run(manifest())


def test_pg_pet_simultaneous_create_same_key_commits_one_identity(pet_accounts):
    engine, settings, ((a, owner, _), _) = pet_accounts
    body, key = {"name": "PetPG concurrent same-key", "role_type": "dog"}, str(uuid4())
    results = race(settings, a, [("POST", "", body, key)] * 2)
    assert [status for status, _ in results] == [201, 201]
    assert results[0][1]["pet_id"] == results[1][1]["pet_id"]
    with engine.connect() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Pet)
                .where(Pet.owner_id == owner, Pet.create_key == key)
            )
            == 1
        )
    changed = command(a, "POST", payload={"name": "different"}, key=key)
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


def test_pg_pet_expected_version_serializes_competing_writers(pet_accounts):
    _, settings, ((a, _, pets), _) = pet_accounts
    pet = pets[0]
    results = race(
        settings,
        a,
        [
            ("PATCH", "/" + pet["pet_id"], {"expected_version": 1, "name": label}, str(uuid4()))
            for label in ["PetPG winner a", "PetPG winner b"]
        ],
    )
    assert sorted(status for status, _ in results) == [200, 409]
    final = a.get(PREFIX + "/" + pet["pet_id"]).json()
    assert final["version"] == 2
    assert final["name"] == next(body["name"] for status, body in results if status == 200)


def test_pg_pet_chat_keys_and_cancel_are_scoped_and_idempotent(pet_accounts):
    engine, settings, ((a, owner, pets), (b, _, _)) = pet_accounts
    key = str(uuid4())
    sessions = []
    for pet in pets:
        path = "/" + pet["pet_id"] + "/sessions"
        first = command(a, "POST", path, {}, key)
        replay = command(a, "POST", path, {}, key)
        assert first.status_code == replay.status_code == 201
        assert first.json()["session"]["id"] == replay.json()["session"]["id"]
        sessions.append(first.json()["session"]["id"])
    assert sessions[0] != sessions[1]
    path = "/" + pets[0]["pet_id"] + "/sessions/" + sessions[0]
    assert a.get(PREFIX + "/" + pets[1]["pet_id"] + "/sessions/" + sessions[0]).status_code == 404
    assert b.get(PREFIX + path).status_code == 404
    body = {"client_message_id": str(uuid4()), "content": "PetPG queued cancellation probe"}
    send_key = str(uuid4())
    accepted = race(settings, a, [("POST", path + "/messages", body, send_key)] * 2)
    assert [status for status, _ in accepted] == [202, 202]
    generation_id = accepted[0][1]["generation"]["id"]
    assert generation_id == accepted[1][1]["generation"]["id"]
    cancel_path = path + "/generations/" + generation_id + "/cancel"
    cancelled = race(settings, a, [("POST", cancel_path, {}, str(uuid4()))] * 2)
    assert [status for status, _ in cancelled] == [200, 200]
    with engine.connect() as db:
        assert (
            db.scalar(select(ChatGeneration.state).where(ChatGeneration.id == UUID(generation_id)))
            == "cancelled"
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatGenerationEvent)
                .where(
                    ChatGenerationEvent.generation_id == UUID(generation_id),
                    ChatGenerationEvent.event_type.in_(["completed", "error", "cancelled"]),
                )
            )
            == 1
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(ChatMessage)
                .where(
                    ChatMessage.owner_id == owner,
                    ChatMessage.session_id == UUID(sessions[0]),
                )
            )
            == 2
        )


def test_pg_pet_composite_foreign_keys_reject_cross_scope_sources_and_grants(pet_accounts):
    engine, _, ((a, owner_a, pets_a), (_, owner_b, pets_b)) = pet_accounts
    pet_a, pet_b = UUID(pets_a[0]["pet_id"]), UUID(pets_a[1]["pet_id"])
    response = command(a, "POST", "/" + str(pet_a) + "/sessions", {})
    assert response.status_code == 201
    session_id = UUID(response.json()["session"]["id"])
    memory_id, message_id = uuid4(), uuid4()
    with engine.begin() as db:
        db.execute(
            PetMemory.__table__.insert().values(
                id=memory_id,
                owner_id=owner_a,
                pet_id=pet_b,
                content="PetPG synthetic fixture",
                consent_granted_at=datetime.now(UTC),
            )
        )
        db.execute(
            ChatMessage.__table__.insert().values(
                id=message_id,
                owner_id=owner_a,
                session_id=session_id,
                role="user",
                content="PetPG synthetic source",
                sequence=0,
                status="completed",
            )
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            update(PetChatBinding)
            .where(PetChatBinding.session_id == session_id)
            .values(owner_id=owner_b, pet_id=UUID(pets_b[0]["pet_id"]))
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            PetMemorySource.__table__.insert().values(
                id=uuid4(),
                owner_id=owner_a,
                pet_id=pet_b,
                memory_id=memory_id,
                kind="chat_message",
                session_id=session_id,
                message_id=message_id,
                source_message_version=1,
            )
        )
    with pytest.raises(IntegrityError), engine.begin() as db:
        db.execute(
            PetMemoryConsent.__table__.insert().values(
                id=uuid4(),
                owner_id=owner_a,
                pet_id=pet_a,
                revision=1,
                action="confirmed",
                memory_id=memory_id,
                memory_version=1,
                policy_version="memory-policy/1",
                notice_version="memory-notice/1",
                privacy_epoch=0,
            )
        )
