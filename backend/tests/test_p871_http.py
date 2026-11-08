import asyncio
import json
import logging
import socket
from dataclasses import replace

import httpx
import pytest
from qq_p871_helpers import (
    APP_ID,
    NOW,
    SECRET,
    TOKEN,
    RecordingHTTP,
    credentials,
    envelope,
    payload,
)

from app.modules.qq_p87.contracts import Rejected, SendNotAccepted, SendUncertain
from app.modules.qq_p871.adapter import OfficialQQAdapter
from app.modules.qq_p871.http import TOKEN_URL, OfficialHTTP
from app.modules.qq_p871.protocol import QQWebhookProtocol


@pytest.fixture(autouse=True)
async def no_network(monkeypatch):
    def deny(*_args, **_kwargs):
        pytest.fail("P871 protocol tests must never connect to a network")

    monkeypatch.setattr(socket.socket, "connect", deny)
    monkeypatch.setattr(socket, "create_connection", deny)
    yield


def adapter(recording=None, *, now=lambda: NOW, **options):
    recording = recording or RecordingHTTP()
    http = OfficialHTTP(credentials(), transport=recording.transport(), **options)
    return OfficialQQAdapter(QQWebhookProtocol(credentials()), http, now=now), recording


async def test_default_network_and_send_gates_fail_without_token_request_or_dns():
    http = OfficialHTTP(credentials())
    try:
        assert http._client is None
        with pytest.raises(Rejected, match="QQ_TOKEN_UNAVAILABLE"):
            await http._access_token()
        assert http._client is None
    finally:
        await http.close()


async def test_fixed_origin_passive_payload_and_lazy_singleflight_token_cache():
    transport, recorded = adapter(allow_send=True)
    receipt = transport.verify(*envelope(payload()), NOW)
    try:
        assert not recorded.requests
        outcomes = await asyncio.gather(
            *(transport.reply(receipt, "【AI宠物·测试Mock】你好", sequence=1) for _ in range(8))
        )
        assert len(outcomes) == 8 and recorded.token_calls == 1 and len(recorded.sends) == 1
        first, sending = recorded.requests[0], recorded.requests[-1]
        assert str(first.url) == TOKEN_URL
        assert json.loads(first.content) == {"appId": APP_ID, "clientSecret": SECRET}
        assert sending.url.host == "api.bot.qq.com" and sending.url.scheme == "https"
        assert sending.url.path == "/v2/users/SYNTHETIC_OPENID_A/messages"
        assert sending.headers["authorization"] == "QQBot " + TOKEN
        assert sending.headers["x-union-appid"] == APP_ID
        assert recorded.sends[-1] == {
            "content": "【AI宠物·测试Mock】你好",
            "msg_type": 0,
            "msg_id": "ROBOT1.0_synthetic",
            "msg_seq": 1,
        }
    finally:
        await transport.close()


async def test_no_arbitrary_target_sequence_or_expired_receipt_can_be_sent():
    clock = [NOW]
    transport, recorded = adapter(allow_send=True, now=lambda: clock[0])
    receipt = transport.verify(*envelope(payload()), NOW)
    try:
        for bad in (replace(receipt, subject="OTHER"), replace(receipt, bot="87654321")):
            with pytest.raises(SendNotAccepted, match="QQ_VERIFIED_REPLY_REQUIRED"):
                await transport.reply(bad, "你好", sequence=1)
        with pytest.raises(SendNotAccepted):
            await transport.reply(receipt, "你好", sequence=2)
        clock[0] += 121
        with pytest.raises(SendNotAccepted):
            await transport.reply(receipt, "你好", sequence=1)
        assert not recorded.requests
    finally:
        await transport.close()


@pytest.mark.parametrize(
    "response",
    [
        {"code": 100016, "message": SECRET},
        {"access_token": TOKEN, "expires_in": "0"},
        {"access_token": TOKEN, "expires_in": 7201},
        {"access_token": "BAD\r\nHEADER", "expires_in": 7200},
        {"access_token": TOKEN, "expires_in": True},
    ],
)
async def test_http_200_business_error_or_invalid_token_ttl_fails_closed_and_redacts(response):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json=response)

    http = OfficialHTTP(credentials(), transport=httpx.MockTransport(handle), allow_send=True)
    try:
        for _ in range(2):
            with pytest.raises(Rejected, match="QQ_TOKEN_UNAVAILABLE") as error:
                await http._access_token()
            assert SECRET not in str(error.value)
        assert len(requests) == 1
    finally:
        await http.close()


async def test_expiring_token_refreshes_once_under_concurrency_without_background_timer():
    recorded, clock = RecordingHTTP(), [100]
    http = OfficialHTTP(credentials(), transport=recorded.transport(), monotonic=lambda: clock[0])
    try:
        await asyncio.gather(*(http._access_token() for _ in range(10)))
        assert recorded.token_calls == 1
        clock[0] = 100 + 7140
        await asyncio.gather(*(http._access_token() for _ in range(10)))
        assert recorded.token_calls == 2
    finally:
        await http.close()


@pytest.mark.parametrize(
    "status,data,uncertain",
    [
        (200, {"code": 40054005}, True),
        (202, {"code": 304023}, True),
        (200, {"code": 0}, True),
        (200, {"id": "accepted-but-no-timestamp"}, True),
        (500, {"message": "SYNTHETIC_PRIVATE"}, True),
        (302, {"location": "https://example.invalid"}, True),
        (200, {"code": [1]}, True),
        (200, {"code": 40054013}, False),
        (401, {"code": 11244}, False),
        (403, {"code": 11244}, False),
        (429, {"code": 11244}, False),
    ],
)
async def test_message_errors_audit_and_unknown_results_never_automatically_retry(
    status, data, uncertain
):
    transport, recorded = adapter(allow_send=True)

    async def fail(_request):
        return httpx.Response(status, json=data, headers={"Retry-After": "10"})

    recorded.send_result = fail
    receipt = transport.verify(*envelope(payload()), NOW)
    try:
        with pytest.raises(SendUncertain if uncertain else SendNotAccepted):
            await transport.reply(receipt, "你好", sequence=1)
        if uncertain:
            with pytest.raises(SendUncertain):
                await transport.reply(receipt, "你好", sequence=1)
        assert recorded.token_calls == 1 and len(recorded.sends) == 1
        if status == 401:
            assert transport.http._token is None
    finally:
        await transport.close()


async def test_send_timeout_has_unknown_delivery_and_private_http_logs_are_suppressed(caplog):
    transport, recorded = adapter(allow_send=True)

    async def fail(request):
        logging.getLogger("httpx").debug("%s %s %s", SECRET, TOKEN, request.url)
        raise httpx.ReadTimeout("SYNTHETIC_RAW_PRIVATE_ERROR " + SECRET, request=request)

    recorded.send_result = fail
    receipt = transport.verify(*envelope(payload()), NOW)
    try:
        with caplog.at_level(logging.DEBUG, logger="httpx"):
            with pytest.raises(SendUncertain) as error:
                await transport.reply(receipt, "你好", sequence=1)
        assert SECRET not in str(error.value) + caplog.text
        assert TOKEN not in caplog.text and "SYNTHETIC_OPENID_A" not in caplog.text
        assert len(recorded.sends) == 1
    finally:
        await transport.close()


async def test_verified_receipt_cache_is_bounded_and_discarded_on_close():
    transport, _ = adapter()
    try:
        for n in range(300):
            transport.verify(*envelope(payload(identity="ROBOT1.0_" + str(n))), NOW)
        assert len(transport._verified) == 256
    finally:
        await transport.close()
    assert not transport._verified and transport.http.closed


async def test_send_gate_prevents_even_a_synthetic_token_request():
    transport, recorded = adapter()
    receipt = transport.verify(*envelope(payload()), NOW)
    try:
        with pytest.raises(SendNotAccepted, match="QQ_SEND_DISABLED"):
            await transport.reply(receipt, "你好", sequence=1)
        assert not recorded.requests
    finally:
        await transport.close()
