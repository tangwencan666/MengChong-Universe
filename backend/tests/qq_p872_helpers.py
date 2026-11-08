"""Synthetic queues replace sockets; only httpx.MockTransport is used for REST."""

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
from qq_p871_helpers import APP_ID, NOW, RecordingHTTP, credentials, payload

from app.modules.qq_p87.contracts import Context, Memory, Receipt
from app.modules.qq_p87.mocks import FixtureContextReader, MockModel
from app.modules.qq_p87.store import MockStore
from app.modules.qq_p872.channel import TestBudgetHTTP as BudgetHTTP
from app.modules.qq_p872.channel import WebSocketPetChannel, WebSocketQQAdapter
from app.modules.qq_p872.protocol import WebSocketProtocol
from app.modules.qq_p872.state import Disconnected

IDS = [f"20000000-0000-4000-8000-{n:012}" for n in range(1, 8)]
OWNER, PET, SIBLING, OTHER, FOREIGN, MEMORY, GRANT = IDS


class GatewayHTTP(RecordingHTTP):
    def __init__(self):
        super().__init__()
        self.gateway_result = {
            "url": "wss://api.bot.qq.com/websocket/",
            "shards": 1,
            "session_start_limit": {
                "total": 10,
                "remaining": 10,
                "reset_after": 86400000,
                "max_concurrency": 1,
            },
        }

    async def handle(self, request):
        if request.url.path == "/gateway/bot":
            self.requests.append(request)
            return httpx.Response(200, json=self.gateway_result)
        return await super().handle(request)


class FakeSocket:
    def __init__(self, frames=(), on_send=None):
        self.frames, self.sent, self.on_send = asyncio.Queue(), [], on_send
        self.drained = asyncio.Event()
        self.closed = False
        for frame in frames:
            self.frames.put_nowait(frame)

    async def recv(self):
        if self.frames.empty():
            self.drained.set()
        item = await self.frames.get()
        if isinstance(item, Exception):
            raise item
        return json.dumps(item, ensure_ascii=False)

    async def send(self, raw):
        frame = json.loads(raw)
        self.sent.append(frame)
        if self.on_send:
            await self.on_send(frame, self)


class FakeConnector:
    def __init__(self, sockets):
        self.sockets, self.opened = list(sockets), []

    @asynccontextmanager
    async def open(self, url):
        self.opened.append(url)
        if not self.sockets:
            raise Disconnected()
        socket = self.sockets.pop(0)
        try:
            yield socket
        finally:
            socket.closed = True


def hello(interval=45000):
    return {"op": 10, "d": {"heartbeat_interval": interval}}


def ready(sequence=1, session="SYNTHETIC_SESSION"):
    return {
        "op": 0,
        "t": "READY",
        "s": sequence,
        "d": {"session_id": session, "shard": [0, 1], "user": {"bot": True}},
    }


def event(sequence=2, subject="QQ_A", identity="ROBOT1.0_ws_synthetic", text="你好"):
    data = payload(text, subject=subject, identity=identity)
    data["s"] = sequence
    return data


async def instant_backoff(delay, stop):
    assert 5 <= delay <= 31
    await asyncio.sleep(0)


def make_channel():
    store = MockStore(b"p872-synthetic-lab-pepper-only!!!"[:32])
    store.add_bot(APP_ID)
    for owner in (OWNER, OTHER):
        store.add_account(owner, 5)
    contexts = [
        Context(
            OWNER,
            PET,
            "同名哈吉米",
            "温柔人格A",
            "warm",
            1,
            1,
            (Memory(OWNER, PET, MEMORY, GRANT, 1, "SYNTHETIC_A_MEMORY"),),
        ),
        Context(OWNER, SIBLING, "同名哈吉米", "独立人格B", "playful", 1, 1),
        Context(OTHER, FOREIGN, "刀盾", "独立人格C", "calm", 1, 1),
    ]
    recorded = GatewayHTTP()
    http = BudgetHTTP(credentials(), allow_send=True, transport=recorded.transport())
    protocol = WebSocketProtocol(APP_ID)
    adapter = WebSocketQQAdapter(protocol, http, now=lambda: NOW)
    model = MockModel()
    channel = WebSocketPetChannel(
        store, FixtureContextReader(contexts), model, adapter, now=lambda: NOW, enable=True
    )
    return SimpleNamespace(
        store=store,
        http=http,
        protocol=protocol,
        adapter=adapter,
        model=model,
        channel=channel,
        recorded=recorded,
    )


def bind_fixture(lab, *, owner=OWNER, pet=PET, subject="QQ_A", memory=True):
    token = lab.store.start_binding(owner, pet, APP_ID, NOW)
    receipt = Receipt(APP_ID, subject, "ROBOT1.0_bind", "0", "/bind " + token, NOW)
    code = lab.store.observe_binding(receipt, token, NOW)
    lab.store.confirm_binding(owner, token, code, NOW, memory=memory)
    return receipt


async def close_lab(lab):
    await lab.channel.close()
    lab.store.close()
