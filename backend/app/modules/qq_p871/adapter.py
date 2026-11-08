"""Verified inbound receipts are the sole authority for an outbound destination."""

import asyncio
import hashlib
import hmac
import json
import re
import secrets
from collections import OrderedDict
from dataclasses import asdict

from app.modules.qq_p87.contracts import Receipt, Rejected, SendNotAccepted, SendUncertain
from app.modules.qq_p87.safety import plain, screen_output

from .http import OfficialHTTP
from .protocol import QQWebhookProtocol


class OfficialQQAdapter:
    name = "qq-official-webhook-sandbox"

    def __init__(self, protocol: QQWebhookProtocol, http: OfficialHTTP, *, now):
        if protocol.app_id != http.credentials.app_id:
            raise Rejected("QQ_APPID_MISMATCH")
        self.protocol, self.http, self.now = protocol, http, now
        self._pepper = secrets.token_bytes(32)
        self._verified = OrderedDict()
        self._deliveries, self._guards = {}, {}
        self._send_lock = asyncio.Lock()
        self.closed = False

    def _key(self, receipt):
        raw = json.dumps(asdict(receipt), ensure_ascii=False, separators=(",", ":")).encode()
        return hmac.new(self._pepper, raw, hashlib.sha256).hexdigest()

    def verify(self, body, supplied, now):
        if self.closed:
            raise Rejected("QQ_ADAPTER_CLOSED")
        receipt = self.protocol.verify(body, supplied, now)
        for key, expiry in list(self._verified.items()):
            if expiry < now:
                del self._verified[key]
                self._deliveries.pop(key, None)
        self._verified[self._key(receipt)] = receipt.timestamp + 120
        while len(self._verified) > 256:
            key, _ = self._verified.popitem(last=False)
            self._deliveries.pop(key, None)
        return receipt

    async def reply(self, receipt: Receipt, text: str, *, sequence: int):
        async with self._send_lock:
            return await self._reply(receipt, text, sequence=sequence)

    async def _reply(self, receipt: Receipt, text: str, *, sequence: int):
        if self.closed or self._verified.get(self._key(receipt), 0) < self.now() or sequence != 1:
            raise SendNotAccepted("QQ_VERIFIED_REPLY_REQUIRED")
        # Binding confirmation is a trusted control response, never model output.
        if text.startswith(("仅本地Mock绑定确认码：", "QQ测试绑定确认码：")):
            plain(text, 240)
            if not re.fullmatch(
                r"(?:仅本地Mock绑定确认码|QQ测试绑定确认码)：[A-Za-z0-9_-]{32}", text
            ):
                raise SendNotAccepted("QQ_CONTROL_REPLY_INVALID")
        else:
            screen_output(text, protected=True)
        key = self._key(receipt)
        fingerprint = hmac.new(self._pepper, text.encode(), hashlib.sha256).hexdigest()
        row = self._deliveries.get(key)
        if row:
            if row["fingerprint"] != fingerprint:
                raise SendNotAccepted("QQ_REPLY_CONFLICT")
            if row["state"] == "sent":
                return row["id"]
            if row["state"] == "unknown":
                raise SendUncertain("QQ_DELIVERY_UNCERTAIN")
            if row["attempts"] >= 2:
                raise SendNotAccepted("QQ_DELIVERY_RETRY_LIMIT")
        else:
            row = {"fingerprint": fingerprint, "state": "new", "attempts": 0}
            self._deliveries[key] = row
        row["attempts"] += 1

        async def guard():
            if self.closed or self._verified.get(key, 0) < self.now():
                raise Rejected("QQ_VERIFIED_REPLY_REQUIRED")
            if key in self._guards:
                await self._guards[key]()

        try:
            result = await self.http.reply(receipt, text, sequence=sequence, before_send=guard)
        except SendNotAccepted:
            row["state"] = "not-accepted"
            raise
        except asyncio.CancelledError:
            row["state"] = "unknown"
            raise
        except Exception:
            row["state"] = "unknown"
            raise SendUncertain("QQ_DELIVERY_UNCERTAIN") from None
        row.update(state="sent", id=result)
        return result

    def guard_send(self, receipt, guard):
        key = self._key(receipt)
        if guard is None:
            self._guards.pop(key, None)
        else:
            self._guards[key] = guard

    def clear_captures(self):
        self._verified.clear()
        self._deliveries.clear()
        self._guards.clear()

    async def close(self):
        self.closed = True
        self.clear_captures()
        await self.http.close()
