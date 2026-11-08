"""Bounded, event-driven gateway loop. Cursor advances only after handling/admission."""

import asyncio
import json
import random
import time

from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p871.protocol import decode

from .state import Disconnected, GatewayState, Reconnect
from .transport import gateway_url


class GatewayRunner:
    def __init__(
        self,
        channel,
        connector,
        *,
        approved_c2c=False,
        max_attempts=3,
        max_seconds=600,
        monotonic=time.monotonic,
        jitter=None,
        backoff=None,
    ):
        if not approved_c2c:
            raise Rejected("QQ_WS_C2C_APPROVAL_REQUIRED")
        if (
            type(max_attempts) is not int
            or not 1 <= max_attempts <= 3
            or not 1 <= max_seconds <= 600
        ):
            raise Rejected("QQ_WS_RUN_LIMIT_INVALID")
        self.channel, self.connector = channel, connector
        self.http, self.protocol = channel.adapter.http, channel.adapter.protocol
        self.state = GatewayState()
        self.max_attempts, self.max_seconds, self.clock = max_attempts, max_seconds, monotonic
        self.jitter = jitter or random.SystemRandom().uniform
        self.backoff = backoff
        self.stop = asyncio.Event()
        self.attempts, self.identifies, self.resumes = 0, 0, 0
        self.remaining = 0
        self.chat_attempts, self.ignored_events, self.rejected_events = 0, 0, 0
        self.status, self.last_chat_status = "idle", "none"
        self._task, self._watch, self._control_watch = None, None, None

    def snapshot(self):
        return {
            "status": self.status,
            "attempts": self.attempts,
            "identifies": self.identifies,
            "resumes": self.resumes,
            "chat_attempts": self.chat_attempts,
            "last_chat_status": self.last_chat_status,
            "ignored_events": self.ignored_events,
            "rejected_events": self.rejected_events,
            "outbound_attempts": self.http.outbound_attempts,
            "paid_model_enabled": False,
        }

    def start(self):
        if self._task is not None:
            raise Rejected("QQ_WS_ALREADY_STARTED")
        self._task = asyncio.create_task(self.run())
        return self._task

    async def _watch_chat(self, owner, key):
        try:
            await asyncio.gather(*list(self.channel._tasks), return_exceptions=True)
            self.last_chat_status = self.channel.store.state(owner, key)["status"]
        except Exception:
            self.last_chat_status = "internal_failure"
        if not self.stop.is_set():
            self.status = "test_complete" if self.last_chat_status == "sent" else "test_failed"
        self.stop.set()

    async def _watch_control(self):
        await asyncio.gather(*list(self.channel._tasks), return_exceptions=True)
        if self.channel.control_status != "sent" and not self.stop.is_set():
            self.status = "binding_reply_failed"
            self.stop.set()

    async def _dispatch(self, data, raw):
        sequence = data["s"]
        if data.get("t") != "C2C_MESSAGE_CREATE":
            self.ignored_events += 1
            self.state.commit(sequence)
            return
        if self.state.cursor is not None and sequence <= self.state.cursor:
            return
        proof = self.protocol._attest(raw)
        try:
            receipt = self.channel.adapter.verify(raw, proof, self.channel.now())
            if receipt.text.startswith("/bind "):
                if self._control_watch is None or self._control_watch.done():
                    await self.channel.enqueue_binding(raw, proof, receipt.text[6:])
                    self._control_watch = asyncio.create_task(self._watch_control())
            elif self.chat_attempts == 0:
                result = await self.channel.enqueue(raw, proof)
                if result.status == "admitted" and not result.replay:
                    self.chat_attempts += 1
                    owner = self.channel.store.binding(receipt).owner
                    self._watch = asyncio.create_task(self._watch_chat(owner, result.key))
        except Rejected:
            self.rejected_events += 1
        # Errors not in the explicit rejection set propagate: never advance on a
        # failed DB transaction, so an in-process Resume can replay safely.
        self.state.commit(sequence)

    async def _connection(self, socket, token, run_deadline):
        self.state.connect(self.clock())
        receive = asyncio.create_task(socket.recv())
        stopped = asyncio.create_task(self.stop.wait())
        try:
            while not self.stop.is_set():
                now = self.clock()
                timeout = max(0, min(self.state.deadline(), run_deadline) - now)
                done, _ = await asyncio.wait(
                    {receive, stopped}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
                )
                if stopped in done or self.stop.is_set():
                    return
                now = self.clock()
                if now >= run_deadline:
                    self.status = "run_deadline"
                    self.stop.set()
                    return
                if receive not in done:
                    action = self.state.tick(now)
                    if action:
                        await socket.send(json.dumps(action))
                    continue
                text = receive.result()
                raw = text.encode("utf-8") if isinstance(text, str) else text
                data = decode(raw)
                action = self.state.receive(data, now, token)
                if action:
                    if action["op"] == 2:
                        if self.remaining < 1:
                            raise Rejected("QQ_WS_SESSION_START_EXHAUSTED")
                        self.remaining -= 1
                        self.identifies += 1
                    elif action["op"] == 6:
                        self.resumes += 1
                    await socket.send(json.dumps(action))
                if data.get("t") in {"READY", "RESUMED"} and self.state.phase == "ready":
                    self.protocol._activate(self.state.session)
                    self.status = "connected"
                elif data["op"] == 0:
                    if self.state.phase == "replaying":
                        self.protocol._activate(self.state.session)
                        self.status = "replaying"
                    await self._dispatch(data, raw)
                receive = asyncio.create_task(socket.recv())
            return
        finally:
            self.protocol._deactivate()
            for task in (receive, stopped):
                task.cancel()
            await asyncio.gather(receive, stopped, return_exceptions=True)

    async def run(self):
        deadline, gateway = self.clock() + self.max_seconds, None
        try:
            for attempt in range(self.max_attempts):
                if self.stop.is_set():
                    break
                self.attempts = attempt + 1
                self.status = "connecting"
                try:
                    if gateway is None:
                        data = await self.http.gateway()
                        gateway = gateway_url(data.get("url"))
                        limit = data.get("session_start_limit")
                        if (
                            type(data.get("shards")) is not int
                            or data["shards"] != 1
                            or not isinstance(limit, dict)
                            or any(
                                type(limit.get(k)) is not int or limit[k] < 0
                                for k in ("total", "remaining", "reset_after", "max_concurrency")
                            )
                            or not 0 < limit["remaining"] <= limit["total"]
                            or limit["max_concurrency"] < 1
                        ):
                            raise Rejected("QQ_WS_GATEWAY_LIMIT_INVALID")
                        self.remaining = limit["remaining"]
                    token = await self.http._access_token()
                    async with self.connector.open(gateway) as socket:
                        await self._connection(socket, token, deadline)
                    if self.stop.is_set():
                        break
                    raise Reconnect()
                except Reconnect as error:
                    if error.fresh:
                        self.state.clear()
                except Disconnected as error:
                    if error.code == 4004 or 4000 <= error.code < 5000:
                        self.status = "authentication_or_permission_rejected"
                        break
                    if error.code in {9001, 9005}:
                        self.state.clear()
                except Rejected as error:
                    self.status = error.code
                    break
                if self.stop.is_set():
                    break
                if attempt + 1 >= self.max_attempts:
                    self.status = "retry_exhausted"
                    break
                self.status = "backoff"
                delay = min(30, 5 * 2**attempt) + self.jitter(0, 1)
                if self.backoff is not None:
                    await self.backoff(delay, self.stop)
                    continue
                try:
                    await asyncio.wait_for(
                        self.stop.wait(), min(delay, max(0, deadline - self.clock()))
                    )
                except TimeoutError:
                    pass
                if self.clock() >= deadline:
                    self.status = "run_deadline"
                    break
        except asyncio.CancelledError:
            self.status = "stopped"
            raise
        except Exception:
            self.status = "internal_failure"
        finally:
            self.stop.set()
            self.protocol._deactivate()
            self.state.phase = "closed"
            self.state.session = None
            self.http.allow_send = False

    async def close(self):
        self.stop.set()
        for task in (self._task, self._watch, self._control_watch):
            if task is not None:
                task.cancel()
        await asyncio.gather(
            *(task for task in (self._task, self._watch, self._control_watch) if task is not None),
            return_exceptions=True,
        )
