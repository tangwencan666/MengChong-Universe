"""Public synthetic-only values. No real environment lookup or QQ request."""

import asyncio
import json
from datetime import UTC, datetime

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import SecretStr

from app.modules.qq_p871.config import QQCredentials

APP_ID = "12345678"
SECRET = "P871-SYNTHETIC-NOT-A-REAL-SECRET"
NOW = int(datetime(2026, 11, 3, 4, tzinfo=UTC).timestamp())
TOKEN = "P871-SYNTHETIC-ACCESS-TOKEN-NOT-REAL"


def credentials(app_id=APP_ID, secret=SECRET):
    return QQCredentials(app_id, SecretStr(secret))


def payload(
    text="你好",
    *,
    subject="SYNTHETIC_OPENID_A",
    identity="ROBOT1.0_synthetic",
    index="REFIDX_synthetic==",
):
    return {
        "id": "synthetic-event-1",
        "op": 0,
        "t": "C2C_MESSAGE_CREATE",
        "s": 1,
        "d": {
            "id": identity,
            "author": {"user_openid": subject, "bot": False},
            "content": text,
            "message_type": 0,
            "timestamp": datetime.fromtimestamp(NOW, UTC).isoformat(),
            "message_scene": {"source": "default", "ext": ["msg_idx=" + index]},
        },
    }


def envelope(data, *, body=None, stamp=NOW, app_id=APP_ID, secret=SECRET):
    raw = body if body is not None else json.dumps(data, ensure_ascii=False).encode("utf-8")
    # Independent test construction of the documented seed and timestamp+raw body.
    key = Ed25519PrivateKey.from_private_bytes((secret.encode("ascii") * 32)[:32])
    return raw, {
        "X-Bot-Appid": app_id,
        "X-Signature-Timestamp": str(stamp),
        "X-Signature-Ed25519": key.sign(str(stamp).encode() + raw).hex(),
    }


class RecordingHTTP:
    def __init__(self):
        self.requests = []
        self.token_calls = 0
        self.send_result = None
        self.token_gate = None
        self.token_started = asyncio.Event()

    async def handle(self, request):
        self.requests.append(request)
        if request.url.path == "/app/getAppAccessToken":
            self.token_calls += 1
            self.token_started.set()
            if self.token_gate is not None:
                await self.token_gate.wait()
            await asyncio.sleep(0)
            return httpx.Response(200, json={"access_token": TOKEN, "expires_in": "7200"})
        if self.send_result:
            return await self.send_result(request)
        return httpx.Response(
            200, json={"id": "ROBOT1.0_reply", "timestamp": "2026-11-03T04:00:00Z"}
        )

    def transport(self):
        return httpx.MockTransport(self.handle)

    @property
    def sends(self):
        return [
            json.loads(request.content)
            for request in self.requests
            if request.url.path.endswith("/messages")
        ]
