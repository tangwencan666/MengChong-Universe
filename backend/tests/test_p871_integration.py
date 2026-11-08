import asyncio
import secrets
from dataclasses import replace
from types import SimpleNamespace

import pytest
from auth_helpers import csrf
from qq_p871_helpers import APP_ID, NOW, RecordingHTTP, credentials, envelope, payload
from test_memory_api import account, use_account
from test_p85_instances import adopt
from test_pet_memory import create as memory
from test_pet_memory import enable
from test_pet_memory import memory_client as memory_client

from app.modules.qq_p87.context import ExistingPetContextReader
from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p87.mocks import MockModel
from app.modules.qq_p87.runtime import MockPetChannel
from app.modules.qq_p87.store import MockStore
from app.modules.qq_p871.adapter import OfficialQQAdapter
from app.modules.qq_p871.http import OfficialHTTP
from app.modules.qq_p871.protocol import QQWebhookProtocol
from app.modules.qq_p871.routes import install_qq_routes
from app.modules.qq_p871.runtime import OfficialSandboxPetChannel

PREFIX = "/api/v1/qq"


@pytest.fixture
def lab(memory_client):
    client = memory_client
    _, cookie_a = account(client)
    owner = client.get("/api/v1/auth/me").json()["id"]
    first, sibling = adopt(client)["pet_instance_id"], adopt(client)["pet_instance_id"]
    for identity, text in [
        (first, "SYNTHETIC_FIRST_PRIVATE"),
        (sibling, "SYNTHETIC_SIBLING_PRIVATE"),
    ]:
        enable(client, identity)
        memory(client, identity, content=text)
    client.cookies.clear()
    _, cookie_b = account(client, "p871-b@example.com")
    other_owner = client.get("/api/v1/auth/me").json()["id"]
    foreign = adopt(client, species="daodun")["pet_instance_id"]
    enable(client, foreign)
    memory(client, foreign, content="SYNTHETIC_OTHER_OWNER_PRIVATE")
    use_account(client, cookie_a)
    recorded, store = RecordingHTTP(), MockStore(secrets.token_bytes(32))
    for identity in (owner, other_owner):
        store.add_account(identity, 5)
    store.add_bot(APP_ID)

    async def setup():
        model = MockModel()
        adapter = OfficialQQAdapter(
            QQWebhookProtocol(credentials()),
            OfficialHTTP(
                credentials(),
                transport=recorded.transport(),
                allow_send=True,
            ),
            now=lambda: NOW,
        )
        service = OfficialSandboxPetChannel(
            store,
            ExistingPetContextReader(client.app.state.session_factory),
            model,
            adapter,
            now=lambda: NOW,
            enable=True,
        )
        return service

    service = client.portal.call(setup)
    install_qq_routes(client.app, service, enabled=True)
    value = SimpleNamespace(
        client=client,
        service=service,
        recorded=recorded,
        store=store,
        owner=owner,
        other_owner=other_owner,
        first=first,
        sibling=sibling,
        foreign=foreign,
        cookie_a=cookie_a,
        cookie_b=cookie_b,
    )
    yield value
    client.portal.call(service.close)
    assert not service._tasks and not service._pending and not service.adapter._verified
    store.close()


def callback(lab, message):
    body, supplied = envelope(message)
    return lab.client.post(PREFIX + "/callback", content=body, headers=supplied)


def bind(lab, identity, subject):
    start = lab.client.post(
        PREFIX + "/bindings/challenges",
        json={"pet_instance_id": identity},
        headers=csrf(lab.client),
    )
    assert start.status_code == 200, start.text
    token = start.json()["token"]
    assert callback(
        lab, payload("/bind " + token, subject=subject, identity="ROBOT1.0_bind_" + subject)
    ).json() == {"op": 12}
    drain(lab)
    code = lab.recorded.sends[-1]["content"].split("：", 1)[1]
    response = lab.client.post(
        PREFIX + "/bindings/confirm",
        json={
            "token": token,
            "confirmation": code,
            "allow_memory": True,
        },
        headers=csrf(lab.client),
    )
    assert response.status_code == 200, response.text
    return response


def drain(lab):
    async def finish():
        await asyncio.gather(*list(lab.service._tasks))

    lab.client.portal.call(finish)


def test_real_fastapi_auth_binding_dedupe_and_same_species_private_memory_are_reused(lab):
    for identity, subject in [(lab.first, "QQ_A"), (lab.sibling, "QQ_SIBLING")]:
        bind(lab, identity, subject)
        message = payload(subject=subject, identity="ROBOT1.0_message_" + subject)
        assert callback(lab, message).status_code == 200
        drain(lab)
        message["id"], message["s"] = "new-dispatch-id", 900
        assert callback(lab, message).status_code == 200
        drain(lab)
    assert lab.service.model.calls == 2
    contexts = [request.context for request in lab.service.model.requests]
    assert {context.pet for context in contexts} == {lab.first, lab.sibling}
    assert contexts[0].memories[0].content == "SYNTHETIC_FIRST_PRIVATE"
    assert contexts[1].memories[0].content == "SYNTHETIC_SIBLING_PRIVATE"
    rows = list(lab.store.db.execute("SELECT * FROM jobs"))
    assert len(rows) == 2 and all(row["model_attempts"] == 1 for row in rows)
    assert all(
        row["channel"] == "qq-official-sandbox-c2c" and row["actual_cost_usd"] is None
        for row in rows
    )
    listing = lab.client.get(PREFIX + "/bindings").json()["bindings"]
    assert len(listing) == 2 and all("subject" not in item for item in listing)


def test_platform_cookie_csrf_wrong_pet_and_other_owner_cannot_claim_bindings(lab):
    bad = lab.client.post(
        PREFIX + "/bindings/challenges",
        json={"pet_instance_id": lab.foreign},
        headers=csrf(lab.client),
    )
    assert bad.status_code == 400
    no_csrf = lab.client.post(PREFIX + "/bindings/challenges", json={"pet_instance_id": lab.first})
    assert no_csrf.status_code == 403
    bind(lab, lab.first, "QQ_A")
    use_account(lab.client, lab.cookie_b)
    assert lab.client.get(PREFIX + "/bindings").json()["bindings"] == []
    bind(lab, lab.foreign, "QQ_B")
    assert callback(lab, payload(subject="QQ_B", identity="ROBOT1.0_owner_b")).status_code == 200
    drain(lab)
    assert lab.service.model.requests[-1].context.owner == lab.other_owner
    assert "FIRST_PRIVATE" not in lab.recorded.sends[-1]["content"]
    lab.client.cookies.clear()
    assert lab.client.get(PREFIX + "/bindings").status_code == 401


@pytest.mark.parametrize("limit", ["quota", "budget", "rate", "paused", "unbound"])
def test_protocol_events_cannot_bypass_admission_controls(lab, limit):
    bind(lab, lab.first, "QQ_A")
    initial = len(lab.recorded.sends)
    if limit == "quota":
        lab.store.db.execute("UPDATE accounts SET spent=granted WHERE owner=?", (lab.owner,))
    if limit == "budget":
        lab.service.limits = replace(lab.service.limits, global_daily_micro_usd=1)
    if limit == "rate":
        lab.service.limits = replace(lab.service.limits, account_per_minute=1)
        assert callback(lab, payload(subject="QQ_A", identity="ROBOT1.0_one")).status_code == 200
        drain(lab)
        initial += 1
    if limit == "paused":
        lab.service.pause()
    subject = "QQ_UNBOUND" if limit == "unbound" else "QQ_A"
    response = callback(lab, payload(subject=subject, identity="ROBOT1.0_two"))
    assert response.status_code == 200
    drain(lab)
    assert len(lab.recorded.sends) == initial
    assert lab.service.model.calls == (1 if limit == "rate" else 0)


@pytest.mark.parametrize("action", ["revoke", "pause"])
def test_token_fetch_cannot_allow_a_late_send_after_revoke_or_pause(lab, action):
    bind(lab, lab.first, "QQ_A")

    async def hold():
        lab.service.adapter.http._token = None
        lab.recorded.token_gate = asyncio.Event()
        lab.recorded.token_started = asyncio.Event()

    lab.client.portal.call(hold)
    assert callback(lab, payload(subject="QQ_A", identity="ROBOT1.0_held")).json() == {"op": 12}

    async def started():
        await asyncio.wait_for(lab.recorded.token_started.wait(), 2)

    lab.client.portal.call(started)
    if action == "revoke":
        binding = lab.client.get(PREFIX + "/bindings").json()["bindings"][0]
        result = lab.client.post(
            PREFIX + "/bindings/revoke",
            json={"subject_hmac": binding["subject_hmac"]},
            headers=csrf(lab.client),
        )
        assert result.status_code == 200
    else:
        lab.service.pause()

    async def release():
        lab.recorded.token_gate.set()

    lab.client.portal.call(release)
    drain(lab)
    assert len(lab.recorded.sends) == 1  # only the earlier control confirmation
    assert not lab.service._pending
    row = lab.store.db.execute("SELECT * FROM jobs").fetchone()
    assert row["status"] == "blocked" and row["model_attempts"] == 1


def test_qq_routes_are_opt_in_and_paid_model_or_mock_guard_bypass_is_denied(memory_client):
    client = memory_client
    assert client.post(PREFIX + "/callback", json={}).status_code == 404
    with pytest.raises(Rejected, match="QQ_SANDBOX_DISABLED"):
        OfficialSandboxPetChannel(None, None, None, None)
    with pytest.raises(Rejected, match="QQ_PAID_MODEL_DISABLED"):
        OfficialSandboxPetChannel(None, None, object(), None, enable=True)
    with pytest.raises(Rejected, match="LIVE_CHANNEL_DISABLED"):
        MockPetChannel(None, None, MockModel(), object(), now=lambda: NOW)


def test_binding_callback_ack_does_not_wait_for_token_network_io(lab):
    response = lab.client.post(
        PREFIX + "/bindings/challenges",
        json={
            "pet_instance_id": lab.first,
        },
        headers=csrf(lab.client),
    )
    token = response.json()["token"]

    async def hold():
        lab.recorded.token_gate = asyncio.Event()

    lab.client.portal.call(hold)
    assert callback(lab, payload("/bind " + token)).json() == {"op": 12}
    assert lab.service._tasks and not lab.recorded.sends

    async def release():
        lab.recorded.token_gate.set()

    lab.client.portal.call(release)
    drain(lab)
    assert lab.service.control_status == "sent" and lab.service.model.calls == 0
