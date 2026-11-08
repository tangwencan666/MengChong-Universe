"""Pure QQ gateway state and deadlines; no socket, secret lookup, or body audit."""

from dataclasses import dataclass

from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p871.protocol import opaque

C2C_INTENT = 1 << 25  # Officially bundled with group/friend events; filter locally.


class Reconnect(Exception):
    def __init__(self, *, fresh=False):
        self.fresh = fresh
        super().__init__("QQ_WS_RECONNECT")


class Disconnected(Exception):
    def __init__(self, code=1006):
        self.code = code
        super().__init__("QQ_WS_DISCONNECTED")


@dataclass(repr=False)
class GatewayState:
    session: str | None = None
    cursor: int | None = None
    phase: str = "closed"
    interval: float = 45
    next_beat: float = 0
    handshake_deadline: float = 0
    awaiting_ack: bool = False

    def connect(self, now):
        self.phase, self.awaiting_ack = "hello", False
        self.handshake_deadline = now + 5

    def clear(self):
        self.session, self.cursor = None, None

    def deadline(self):
        if self.phase in {"hello", "identify", "resume", "replaying"}:
            return (
                min(self.handshake_deadline, self.next_beat)
                if self.phase != "hello"
                else self.handshake_deadline
            )
        return self.next_beat

    def heartbeat(self, now):
        if self.phase == "hello":
            raise Reconnect()
        if self.awaiting_ack:
            raise Reconnect()
        self.awaiting_ack, self.next_beat = True, now + self.interval
        return {"op": 1, "d": self.cursor}

    def tick(self, now):
        if (
            self.phase in {"hello", "identify", "resume", "replaying"}
            and now >= self.handshake_deadline
        ):
            raise Reconnect()
        if now >= self.next_beat:
            return self.heartbeat(now)
        return None

    def receive(self, data, now, token):
        op = data.get("op")
        if type(op) is not int:
            raise Rejected("QQ_WS_FRAME_INVALID")
        if op == 10:
            detail = data.get("d")
            value = detail.get("heartbeat_interval") if isinstance(detail, dict) else None
            if self.phase != "hello" or type(value) is not int or not 1000 <= value <= 120000:
                raise Rejected("QQ_WS_HELLO_INVALID")
            self.interval, self.next_beat = value / 1000, now + value / 1000
            self.handshake_deadline = now + 10
            if self.session is not None and self.cursor is not None:
                self.phase = "resume"
                return {
                    "op": 6,
                    "d": {
                        "token": "QQBot " + token,
                        "session_id": self.session,
                        "seq": self.cursor,
                    },
                }
            self.phase = "identify"
            return {
                "op": 2,
                "d": {
                    "token": "QQBot " + token,
                    "intents": C2C_INTENT,
                    "shard": [0, 1],
                    "properties": {"$os": "windows"},
                },
            }
        if op == 11:
            if self.phase == "hello":
                raise Rejected("QQ_WS_FRAME_INVALID")
            self.awaiting_ack = False
            return None
        if op == 1:
            return self.heartbeat(now)
        if op == 7:
            raise Reconnect()
        if op == 9:
            # Official botpy discards session on invalid session; never endlessly
            # replay the same failed Resume or broaden the requested intents.
            raise Reconnect(fresh=True)
        if op != 0:
            raise Rejected("QQ_WS_FRAME_INVALID")
        sequence = data.get("s")
        if type(sequence) is not int or not 0 <= sequence < 2**53:
            raise Rejected("QQ_WS_SEQUENCE_INVALID")
        kind = data.get("t")
        if kind == "READY":
            detail = data.get("d")
            if self.phase != "identify" or not isinstance(detail, dict):
                raise Rejected("QQ_WS_READY_INVALID")
            self.session = opaque(detail.get("session_id"), r"[A-Za-z0-9_-]{1,256}")
            self.phase, self.cursor = "ready", sequence
        elif kind == "RESUMED":
            if self.phase not in {"resume", "replaying"}:
                raise Rejected("QQ_WS_READY_INVALID")
            self.phase = "ready"
            self.commit(sequence)
        elif self.phase in {"resume", "replaying"} and self.session is not None:
            # QQ replays missed Dispatch frames before the final RESUMED event.
            self.phase = "replaying"
        elif self.phase != "ready":
            raise Rejected("QQ_WS_NOT_AUTHENTICATED")
        return None

    def commit(self, sequence):
        if self.cursor is None or sequence > self.cursor:
            self.cursor = sequence
