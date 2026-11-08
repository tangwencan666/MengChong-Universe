"""Reuse existing pet/consent tables in disposable SQLite, not a QQ memory copy."""

import secrets
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import event, func, select
from test_memory_api import account, use_account
from test_pet_memory import command, create, enable
from test_pet_memory import memory_client as memory_client
from test_pets import create as pet

from app.modules.pets.models import PetMemory
from app.modules.qq_p87.context import ExistingPetContextReader
from app.modules.qq_p87.contracts import Receipt, Rejected
from app.modules.qq_p87.mocks import MockModel, MockQQAdapter
from app.modules.qq_p87.runtime import MockPetChannel
from app.modules.qq_p87.store import MockStore


def read(client, reader, owner, pet_id, allowed=True):
    async def execute():
        return await reader.read(owner, pet_id, allow_memory=allowed)

    return client.portal.call(execute)


def test_existing_context_reader_is_read_only_and_keeps_same_species_and_owners_separate(
    memory_client, auth_database, tmp_path
):
    client = memory_client
    _, cookies = account(client)
    owner = client.get("/api/v1/auth/me").json()["id"]
    one, sibling = pet(client, "同名")["pet_id"], pet(client, "同名")["pet_id"]
    for identity, content in [(one, "SYNTHETIC_OWNER_ALPHA"), (sibling, "SYNTHETIC_SIBLING")]:
        enable(client, identity)
        create(client, identity, content=content)
    client.cookies.clear()
    account(client, "qq-prototype-other@example.com")
    other_owner = client.get("/api/v1/auth/me").json()["id"]
    foreign = pet(client)["pet_id"]
    enable(client, foreign)
    create(client, foreign, content="SYNTHETIC_OTHER_OWNER")
    use_account(client, cookies)
    assert str(client.app.state.engine.url).startswith("sqlite+aiosqlite:")
    assert Path(auth_database[0].url.database).resolve() == (tmp_path / "auth.db").resolve()
    reader = ExistingPetContextReader(client.app.state.session_factory)
    statements = []

    def observe(_connection, _cursor, sql, _parameters, _context, _many):
        statements.append(sql.lstrip().split()[0].upper())

    engine = client.app.state.engine.sync_engine
    with auth_database[0].connect() as db:
        before = db.scalar(select(func.count()).select_from(PetMemory))
    event.listen(engine, "before_cursor_execute", observe)
    try:
        assert read(client, reader, owner, one).memories[0].content == "SYNTHETIC_OWNER_ALPHA"
        assert read(client, reader, owner, sibling).memories[0].content == "SYNTHETIC_SIBLING"
        assert (
            read(client, reader, other_owner, foreign).memories[0].content
            == "SYNTHETIC_OTHER_OWNER"
        )
        assert read(client, reader, owner, one, False).memories == ()
        with pytest.raises(Rejected, match="PET_ACCESS_DENIED"):
            read(client, reader, owner, foreign)
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert statements and set(statements) <= {"SELECT"}
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(PetMemory)) == before == 3


def test_existing_memory_revocation_and_persona_version_are_rechecked(memory_client):
    client = memory_client
    account(client)
    owner = client.get("/api/v1/auth/me").json()["id"]
    identity = pet(client)["pet_id"]
    enable(client, identity)
    saved = create(client, identity, content="SYNTHETIC_REVOKABLE_CONTEXT")
    reader = ExistingPetContextReader(client.app.state.session_factory)
    before = read(client, reader, owner, identity)
    assert len(before.memories) == 1
    result = command(
        client,
        identity,
        "POST",
        "/items/" + saved["id"] + "/revocations",
        {
            "expected_version": saved["version"],
        },
    )
    assert result.status_code == 200
    after = read(client, reader, owner, identity)
    assert not after.memories and after.privacy_epoch > before.privacy_epoch


def test_mock_channel_reads_existing_authorized_memory_without_writing_app_chat(
    memory_client, auth_database
):
    from app.modules.companion.models import ChatMessage

    client = memory_client
    account(client)
    owner = client.get("/api/v1/auth/me").json()["id"]
    identity = pet(client)["pet_id"]
    enable(client, identity)
    create(client, identity, content="SYNTHETIC_EXISTING_MEMORY")

    async def pipeline():
        store = MockStore(secrets.token_bytes(32))
        store.add_account(owner, 10)
        store.add_bot("synthetic-existing")
        model = MockModel()
        adapter = MockQQAdapter({"synthetic-existing": secrets.token_bytes(32)})
        service = MockPetChannel(
            store,
            ExistingPetContextReader(client.app.state.session_factory),
            model,
            adapter,
            now=lambda: 1793678400,
        )
        try:
            token = await service.start_binding(owner, identity, "synthetic-existing")
            proof = Receipt(
                "synthetic-existing",
                "synthetic-person",
                str(uuid4()),
                "0",
                "/bind " + token,
                1793678400,
            )
            await service.prove_binding(*adapter.envelope(proof), token)
            confirmation = adapter.sent.pop().text.split("：", 1)[1]
            await service.confirm_binding(owner, token, confirmation, memory=True)
            message = Receipt(
                "synthetic-existing", "synthetic-person", "message-1", "0", "你好", 1793678400
            )
            result = await service.receive(*adapter.envelope(message))
            assert result.status == "sent"
            assert "SYNTHETIC_EXISTING_MEMORY" in adapter.sent[-1].text
            assert model.requests[-1].context.pet == identity
        finally:
            await service.close()
            store.close()

    with auth_database[0].connect() as db:
        before = db.scalar(select(func.count()).select_from(ChatMessage))
    client.portal.call(pipeline)
    with auth_database[0].connect() as db:
        assert db.scalar(select(func.count()).select_from(ChatMessage)) == before == 0
