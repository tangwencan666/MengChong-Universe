import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from qq_p871_helpers import APP_ID, NOW, SECRET, credentials, envelope, payload

from app.modules.qq_p87.contracts import Rejected
from app.modules.qq_p871.config import load_options
from app.modules.qq_p871.protocol import QQWebhookProtocol, decode


class NoCredentialLookup(dict):
    def get(self, name, default=None):
        assert name not in {"WEIBIYE_QQ_APP_ID", "WEIBIYE_QQ_APP_SECRET"}
        return super().get(name, default)


def test_default_mock_and_unauthorized_official_mode_never_read_credentials():
    assert load_options(NoCredentialLookup()).mode == "mock"
    with pytest.raises(Rejected, match="QQ_CREDENTIAL_ACCESS_NOT_AUTHORIZED"):
        load_options(NoCredentialLookup(WEIBIYE_QQ_MODE="official-webhook"))
    with pytest.raises(Rejected, match="QQ_MODE_NOT_SUPPORTED"):
        load_options(NoCredentialLookup(WEIBIYE_QQ_MODE="personal-qq"))


def test_synthetic_env_loading_is_redacted_and_network_and_send_default_off():
    options = load_options(
        {
            "WEIBIYE_QQ_MODE": "official-webhook",
            "WEIBIYE_QQ_APP_ID": APP_ID,
            "WEIBIYE_QQ_APP_SECRET": SECRET,
        },
        authorize_secret_read=True,
    )
    assert not options.allow_network and not options.allow_send
    assert SECRET not in repr(options) + repr(options.credentials)
    assert options.credentials.app_secret.get_secret_value() == SECRET
    with pytest.raises(Rejected, match="QQ_CREDENTIAL_FORMAT") as error:
        credentials(secret="SYNTHETIC\r\nINJECTION")
    assert "INJECTION" not in str(error.value)


def test_official_signature_preserves_raw_bytes_real_id_shapes_and_opaque_index():
    protocol = QQWebhookProtocol(credentials())
    raw, supplied = envelope(payload("你好，伙伴！"))
    result = protocol.verify(raw, supplied, NOW)
    assert result.message_id == "ROBOT1.0_synthetic"
    assert result.message_index == "REFIDX_synthetic==" and result.bot == APP_ID
    assert result.subject == "SYNTHETIC_OPENID_A"
    assert protocol.verify(raw, {k.lower(): v for k, v in supplied.items()}, NOW) == result
    with pytest.raises(Rejected, match="QQ_SIGNATURE_INVALID"):
        protocol.verify(raw + b" ", supplied, NOW)


@pytest.mark.parametrize(
    "change", ["wrong-bot", "expired", "future", "wrong-key", "bad-hex", "duplicated-header"]
)
def test_forged_stale_cross_app_or_ambiguous_headers_fail(change):
    raw, supplied = envelope(payload())
    if change == "wrong-bot":
        supplied["X-Bot-Appid"] = "87654321"
    if change == "expired":
        raw, supplied = envelope(payload(), stamp=NOW - 301)
    if change == "future":
        raw, supplied = envelope(payload(), stamp=NOW + 16)
    if change == "wrong-key":
        raw, supplied = envelope(payload(), secret="SYNTHETIC_DIFFERENT_32BYTE_KEY___")
    if change == "bad-hex":
        supplied["X-Signature-Ed25519"] = "NOT-HEX"
    if change == "duplicated-header":
        supplied["x-bot-appid"] = APP_ID
    with pytest.raises(Rejected, match="QQ_SIGNATURE_INVALID"):
        QQWebhookProtocol(credentials()).verify(raw, supplied, NOW)


@pytest.mark.parametrize(
    "change",
    [
        "group",
        "bot",
        "no-openid",
        "union-only",
        "path-injection",
        "card",
        "quote",
        "attachment",
        "forward",
        "reference",
        "duplicate-index",
        "bool-op",
        "bool-type",
        "bad-scene",
        "naive-time",
        "old-message",
    ],
)
def test_unsupported_or_mis_scoped_events_never_normalize_as_private_chat(change):
    data = payload()
    detail = data["d"]
    if change == "group":
        data["t"] = "GROUP_AT_MESSAGE_CREATE"
    if change == "bot":
        detail["author"]["bot"] = True
    if change == "no-openid":
        detail["author"] = {"username": "SYNTHETIC_OPENID_A"}
    if change == "union-only":
        detail["author"] = {"union_openid": "SYNTHETIC_OPENID_A"}
    if change == "path-injection":
        detail["author"]["user_openid"] = "../other"
    if change == "card":
        detail["message_type"] = 3
    if change == "quote":
        detail["message_type"] = 103
    if change == "attachment":
        detail["attachments"] = [{"url": "https://example.invalid"}]
    if change == "forward":
        detail["msg_elements"] = [{"content": "SYNTHETIC_PRIVATE"}]
    if change == "reference":
        detail["message_scene"]["ext"].append("ref_msg_idx=REFIDX_other==")
    if change == "duplicate-index":
        detail["message_scene"]["ext"].append("msg_idx=second")
    if change == "bool-op":
        data["op"] = False
    if change == "bool-type":
        detail["message_type"] = False
    if change == "bad-scene":
        detail["message_scene"]["source"] = "group"
    if change == "naive-time":
        detail["timestamp"] = "2026-11-03T04:00:00"
    if change == "old-message":
        detail["timestamp"] = "2026-11-03T03:57:59Z"
    with pytest.raises(Rejected):
        QQWebhookProtocol(credentials()).verify(*envelope(data), NOW)


def test_legacy_text_is_explicitly_supported_but_never_falls_back_to_nickname_or_union_id():
    data = payload()
    del data["d"]["message_type"], data["d"]["message_scene"]
    data["d"]["msg_seq"] = 7
    data["d"]["author"]["union_openid"] = "UNUSED_FOREIGN_APP_ID"
    result = QQWebhookProtocol(credentials()).verify(*envelope(data), NOW)
    assert result.message_index == "legacy-7" and result.subject == "SYNTHETIC_OPENID_A"


@pytest.mark.parametrize("raw", [b'{"op":0,"op":13}', b'{"op":NaN}', b"[]", b"\xff", b"x" * 32769])
def test_ambiguous_or_oversized_json_is_rejected(raw):
    with pytest.raises(Rejected, match="QQ_PAYLOAD_INVALID"):
        decode(raw)


def test_unsigned_setup_challenge_is_constrained_short_lived_and_not_a_json_signing_oracle():
    data = {"op": 13, "d": {"plain_token": "SYNTHETIC_CHALLENGE_TOKEN", "event_ts": str(NOW)}}
    raw = json.dumps(data).encode()
    supplied = {"X-Bot-Appid": APP_ID}
    with pytest.raises(Rejected, match="QQ_VALIDATION_DISABLED"):
        QQWebhookProtocol(credentials()).validation(raw, supplied, NOW)
    protocol = QQWebhookProtocol(credentials(), validation_until=NOW + 300)
    result = protocol.validation(raw, supplied, NOW)
    public = Ed25519PrivateKey.from_private_bytes((SECRET.encode() * 32)[:32]).public_key()
    public.verify(
        bytes.fromhex(result["signature"]), (str(NOW) + data["d"]["plain_token"]).encode()
    )
    data["d"]["plain_token"] = '{"op":0,"d":{"content":"FORGED"}}'
    with pytest.raises(Rejected):
        protocol.validation(json.dumps(data).encode(), supplied, NOW)
    with pytest.raises(Rejected, match="QQ_VALIDATION_DISABLED"):
        protocol.validation(raw, supplied, NOW + 300)
    for _ in range(4):
        protocol.validation(raw, supplied, NOW)
    with pytest.raises(Rejected, match="QQ_VALIDATION_LIMIT"):
        protocol.validation(raw, supplied, NOW)
