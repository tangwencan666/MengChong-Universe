"""Official Webhook Ed25519 and conservative C2C-only normalization, no network."""

import json
import re
from collections.abc import Mapping
from datetime import datetime

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.modules.qq_p87.contracts import Receipt, Rejected
from app.modules.qq_p87.safety import plain

from .config import QQCredentials


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _constant(_value):
    raise ValueError


def decode(body: bytes) -> dict:
    try:
        if not isinstance(body, bytes) or not 1 <= len(body) <= 32768:
            raise ValueError
        value = json.loads(body, object_pairs_hook=_pairs, parse_constant=_constant)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, TypeError, RecursionError):
        raise Rejected("QQ_PAYLOAD_INVALID") from None


def headers(value) -> dict:
    if not isinstance(value, Mapping):
        raise Rejected("QQ_SIGNATURE_INVALID")
    result = {}
    for key, data in value.items():
        if not isinstance(key, str) or not isinstance(data, str):
            raise Rejected("QQ_SIGNATURE_INVALID")
        name = key.lower()
        if name in result:
            raise Rejected("QQ_SIGNATURE_INVALID")
        result[name] = data
    return result


def opaque(value, pattern=r"[\x21-\x7e]{1,256}") -> str:
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise Rejected("QQ_EVENT_UNSUPPORTED")
    return value


def seconds(value) -> int:
    try:
        if not isinstance(value, str) or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
            r"(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})",
            value,
        ):
            raise ValueError
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return int(parsed.timestamp())
    except (ValueError, OverflowError, TypeError):
        raise Rejected("QQ_EVENT_UNSUPPORTED") from None


class QQWebhookProtocol:
    def __init__(self, credentials: QQCredentials, *, validation_until: int = 0):
        self.app_id = credentials.app_id
        secret = credentials.app_secret.get_secret_value().encode("ascii")
        # Tencent's documented repetition then truncation, not a hash/KDF.
        seed = (secret * ((32 + len(secret) - 1) // len(secret)))[:32]
        self._key = Ed25519PrivateKey.from_private_bytes(seed)
        self.validation_until = validation_until
        self._validations = []

    def validation(self, body: bytes, supplied, now: int) -> dict:
        data, supplied = decode(body), headers(supplied)
        if (
            supplied.get("x-bot-appid") != self.app_id
            or not now < self.validation_until <= now + 300
        ):
            raise Rejected("QQ_VALIDATION_DISABLED")
        detail = data.get("d")
        if type(data.get("op")) is not int or data["op"] != 13 or not isinstance(detail, dict):
            raise Rejected("QQ_VALIDATION_INVALID")
        # Unsigned op=13 is present in the official example. Do not provide an
        # arbitrary signing oracle that could sign an attacker-selected JSON event.
        token = opaque(detail.get("plain_token"), r"[A-Za-z0-9_-]{16,128}")
        stamp = opaque(detail.get("event_ts"), r"[0-9]{10}")
        if not now - 300 <= int(stamp) <= now + 15:
            raise Rejected("QQ_VALIDATION_INVALID")
        self._validations = [value for value in self._validations if value > now - 60]
        if len(self._validations) >= 5:
            raise Rejected("QQ_VALIDATION_LIMIT")
        self._validations.append(now)
        return {"plain_token": token, "signature": self._key.sign((stamp + token).encode()).hex()}

    def verify(self, body: bytes, supplied, now: int) -> Receipt:
        supplied = headers(supplied)
        if not isinstance(body, bytes) or not 1 <= len(body) <= 32768:
            raise Rejected("QQ_SIGNATURE_INVALID")
        stamp = supplied.get("x-signature-timestamp", "")
        signature = supplied.get("x-signature-ed25519", "")
        if (
            supplied.get("x-bot-appid") != self.app_id
            or not re.fullmatch(r"[0-9]{10}", stamp)
            or not now - 300 <= int(stamp) <= now + 15
            or not re.fullmatch(r"[0-9a-fA-F]{128}", signature)
        ):
            raise Rejected("QQ_SIGNATURE_INVALID")
        try:
            self._key.public_key().verify(bytes.fromhex(signature), stamp.encode() + body)
        except (InvalidSignature, ValueError):
            raise Rejected("QQ_SIGNATURE_INVALID") from None
        return normalize_c2c(decode(body), self.app_id, now)


def normalize_c2c(data: dict, app_id: str, now: int) -> Receipt:
    detail = data.get("d")
    if (
        type(data.get("op")) is not int
        or data["op"] != 0
        or data.get("t") != "C2C_MESSAGE_CREATE"
        or not isinstance(detail, dict)
    ):
        raise Rejected("QQ_EVENT_UNSUPPORTED")
    author = detail.get("author")
    if (
        not isinstance(author, dict)
        or author.get("bot", False) is not False
        or type(detail.get("message_type", 0)) is not int
        or detail.get("message_type", 0) != 0
        or any(
            detail.get(key)
            for key in ("attachments", "ark_data", "msg_elements", "message_reference")
        )
    ):
        raise Rejected("QQ_EVENT_UNSUPPORTED")
    subject = opaque(author.get("user_openid"), r"[A-Za-z0-9_-]{1,128}")
    identity = opaque(detail.get("id"))
    timestamp = seconds(detail.get("timestamp"))
    if not now - 120 <= timestamp <= now + 15:
        raise Rejected("QQ_MESSAGE_EXPIRED")
    scene = detail.get("message_scene", {})
    if not isinstance(scene, dict) or scene.get("source", "default") != "default":
        raise Rejected("QQ_EVENT_UNSUPPORTED")
    extra = scene.get("ext", [])
    if (
        not isinstance(extra, list)
        or len(extra) > 32
        or any(not isinstance(v, str) or len(v) > 512 for v in extra)
    ):
        raise Rejected("QQ_EVENT_UNSUPPORTED")
    indexes = [v.partition("=")[2] for v in extra if v.startswith("msg_idx=")]
    if len(indexes) > 1 or any(v.startswith("ref_msg_idx=") for v in extra):
        raise Rejected("QQ_EVENT_UNSUPPORTED")
    if indexes:
        index = opaque(indexes[0])
    else:
        legacy = detail.get("msg_seq", 0)
        if type(legacy) is not int or not 0 <= legacy <= 2**31:
            raise Rejected("QQ_EVENT_UNSUPPORTED")
        index = "legacy-" + str(legacy)
    return Receipt(app_id, subject, identity, index, plain(detail.get("content"), 3000), timestamp)
