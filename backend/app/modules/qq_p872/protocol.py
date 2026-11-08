"""C2C receipts from an authenticated gateway session, never forged Webhook headers."""

import hashlib
import hmac
import secrets
from dataclasses import dataclass

from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p871.protocol import decode, normalize_c2c


@dataclass(frozen=True, repr=False)
class _Proof:
    tag: bytes


class WebSocketProtocol:
    def __init__(self, app_id):
        self.app_id = app_id
        self._key = secrets.token_bytes(32)
        self._session = None

    def _activate(self, session):
        self._session = session

    def _deactivate(self):
        self._session = None

    def _tag(self, body):
        return hmac.new(self._key, self._session.encode() + b"\0" + body, hashlib.sha256).digest()

    def _attest(self, body):
        if self._session is None:
            raise Rejected("QQ_WS_NOT_AUTHENTICATED")
        return _Proof(self._tag(body))

    def verify(self, body, proof, now):
        if (
            self._session is None
            or not isinstance(proof, _Proof)
            or not isinstance(body, bytes)
            or len(body) > 32768
            or not hmac.compare_digest(proof.tag, self._tag(body))
        ):
            raise Rejected("QQ_WS_UNTRUSTED_EVENT")
        return normalize_c2c(decode(body), self.app_id, now)
