"""Explicit, fixed-origin official HTTP; no constructor I/O or automatic retries."""

import asyncio
import logging
import re
import time
from contextvars import ContextVar

import httpx
from pydantic import SecretStr

from app.modules.qq_p87.contracts import Receipt, Rejected, SendNotAccepted, SendUncertain

from .config import QQCredentials
from .protocol import decode, opaque, seconds

TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken"
API_ORIGIN = "https://api.bot.qq.com"
_private_call = ContextVar("qq_private_http_call", default=False)


class _PrivateFilter(logging.Filter):
    def filter(self, record):
        return not _private_call.get()


for _name in (
    "httpx",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
):
    logging.getLogger(_name).addFilter(_PrivateFilter())


def successful_code(data):
    return "code" not in data or (type(data["code"]) is int and data["code"] == 0)


class OfficialHTTP:
    def __init__(
        self,
        credentials: QQCredentials,
        *,
        allow_network=False,
        allow_send=False,
        transport: httpx.MockTransport | None = None,
        monotonic=time.monotonic,
    ):
        if transport is not None and (
            not isinstance(transport, httpx.MockTransport) or allow_network
        ):
            raise Rejected("QQ_TEST_TRANSPORT_REQUIRED")
        self.credentials, self.allow_network, self.allow_send = (
            credentials,
            allow_network,
            allow_send,
        )
        self._transport, self._client = transport, None
        self._clock, self._lock = monotonic, asyncio.Lock()
        self._token, self._expires, self._cooldown = None, 0, 0
        self.closed = False

    async def _post(self, url, payload, supplied=None):
        return await self._request("POST", url, payload, supplied)

    async def _request(self, method, url, payload=None, supplied=None):
        if self.closed or (not self.allow_network and self._transport is None):
            raise Rejected("QQ_NETWORK_DISABLED")
        if self._clock() < self._cooldown:
            raise Rejected("QQ_HTTP_COOLDOWN")
        token = _private_call.set(True)
        try:
            if self._client is None:
                self._client = httpx.AsyncClient(
                    transport=self._transport,
                    trust_env=False,
                    follow_redirects=False,
                    timeout=httpx.Timeout(5, connect=3),
                )
            async with self._client.stream(method, url, json=payload, headers=supplied) as response:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 32768:
                        raise Rejected("QQ_RESPONSE_INVALID")
                if response.status_code == 429:
                    value = response.headers.get("retry-after", "30")
                    delay = int(value) if re.fullmatch(r"[0-9]{1,4}", value) else 30
                    self._cooldown = self._clock() + max(1, min(delay, 300))
                return response.status_code, decode(bytes(body))
        except (httpx.HTTPError, OSError, ValueError):
            raise Rejected("QQ_TRANSPORT_UNCERTAIN") from None
        finally:
            _private_call.reset(token)

    async def _access_token(self):
        async with self._lock:
            if self._token is not None and self._clock() < self._expires:
                return self._token.get_secret_value()
            try:
                status, data = await self._post(
                    TOKEN_URL,
                    {
                        "appId": self.credentials.app_id,
                        "clientSecret": self.credentials.app_secret.get_secret_value(),
                    },
                )
                if status != 200 or not successful_code(data):
                    raise Rejected("QQ_TOKEN_UNAVAILABLE")
                raw, lifetime = data.get("access_token"), data.get("expires_in")
                if not isinstance(raw, str) or not re.fullmatch(r"[\x21-\x7e]{1,8192}", raw):
                    raise Rejected("QQ_TOKEN_UNAVAILABLE")
                if isinstance(lifetime, str) and re.fullmatch(r"[0-9]{1,5}", lifetime):
                    lifetime = int(lifetime)
                if type(lifetime) is not int or not 1 <= lifetime <= 7200:
                    raise Rejected("QQ_TOKEN_UNAVAILABLE")
                self._token = SecretStr(raw)
                self._expires = self._clock() + lifetime - min(60, lifetime / 2)
                return raw
            except Rejected:
                self._token, self._expires = None, 0
                self._cooldown = max(self._cooldown, self._clock() + 30)
                raise Rejected("QQ_TOKEN_UNAVAILABLE") from None

    async def gateway(self):
        access = await self._access_token()
        status, data = await self._request(
            "GET",
            API_ORIGIN + "/gateway/bot",
            supplied={
                "Authorization": "QQBot " + access,
                "X-Union-Appid": self.credentials.app_id,
            },
        )
        if status in {401, 403, 429}:
            raise Rejected("QQ_GATEWAY_ACCESS_DENIED")
        if status != 200 or not successful_code(data):
            raise Rejected("QQ_GATEWAY_UNAVAILABLE")
        return data

    async def reply(self, receipt: Receipt, text: str, *, sequence=1, before_send=None):
        if self.closed or not self.allow_send:
            raise SendNotAccepted("QQ_SEND_DISABLED")
        if sequence != 1 or receipt.bot != self.credentials.app_id or receipt.scene != "c2c":
            raise SendNotAccepted("QQ_SEND_SCOPE_DENIED")
        # Only the verified adapter may call this transport with a recipient.
        subject = opaque(receipt.subject, r"[A-Za-z0-9_-]{1,128}")
        try:
            access = await self._access_token()
        except Rejected:
            raise SendNotAccepted("QQ_TOKEN_UNAVAILABLE") from None
        # Token acquisition yields; pause, revocation or privacy can change while
        # it runs. Revalidate before any message POST, without refreshing/retrying.
        if before_send is not None:
            try:
                await before_send()
            except Rejected:
                raise SendNotAccepted("QQ_SEND_SCOPE_DENIED") from None
        if not self.allow_send or self.closed:
            raise SendNotAccepted("QQ_SEND_DISABLED")
        try:
            status, data = await self._post(
                API_ORIGIN + f"/v2/users/{subject}/messages",
                {
                    "content": text,
                    "msg_type": 0,
                    "msg_id": receipt.message_id,
                    "msg_seq": 1,
                },
                {"Authorization": "QQBot " + access, "X-Union-Appid": self.credentials.app_id},
            )
        except Rejected:
            raise SendUncertain("QQ_DELIVERY_UNCERTAIN") from None
        if status in {401, 403, 429}:
            if status == 401:
                self._token, self._expires = None, 0
            raise SendNotAccepted("QQ_SEND_REJECTED")
        # Known expiry/permission/content errors prove rejection. Duplicate/audit
        # codes and every other ambiguous result must never trigger a blind resend.
        if type(data.get("code")) is int and data["code"] in {
            40034005,
            40034006,
            40034024,
            40034100,
            40034105,
            40034128,
            40054004,
            40054007,
            40054013,
        }:
            raise SendNotAccepted("QQ_SEND_REJECTED")
        if status not in {200, 201} or not successful_code(data):
            raise SendUncertain("QQ_DELIVERY_UNCERTAIN")
        try:
            result = opaque(data.get("id"))
            seconds(data.get("timestamp"))
        except Rejected:
            raise SendUncertain("QQ_DELIVERY_UNCERTAIN") from None
        return result

    async def close(self):
        self.closed, self._token = True, None
        if self._client is not None:
            await self._client.aclose()
