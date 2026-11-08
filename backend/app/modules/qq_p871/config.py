"""Explicit process-environment loading; never inspect secrets in default Mock mode."""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from pydantic import SecretStr

from app.modules.qq_p87.contracts import Rejected


@dataclass(frozen=True, repr=False)
class QQCredentials:
    app_id: str
    app_secret: SecretStr = field(repr=False)

    def __post_init__(self):
        if not isinstance(self.app_id, str) or not re.fullmatch(r"[1-9][0-9]{4,31}", self.app_id):
            raise Rejected("QQ_CREDENTIAL_FORMAT")
        if not isinstance(self.app_secret, SecretStr) or not re.fullmatch(
            r"[\x21-\x7e]{16,128}", self.app_secret.get_secret_value()
        ):
            raise Rejected("QQ_CREDENTIAL_FORMAT")

    def __repr__(self):
        return "QQCredentials(<redacted>)"


@dataclass(frozen=True)
class QQOptions:
    mode: str = "mock"
    allow_network: bool = False
    allow_send: bool = False
    credentials: QQCredentials | None = field(default=None, repr=False)


def load_options(
    environ: Mapping[str, str] | None = None, *, authorize_secret_read: bool = False
) -> QQOptions:
    source = os.environ if environ is None else environ
    mode = source.get("WEIBIYE_QQ_MODE", "mock")
    if mode == "mock":
        return QQOptions()
    if mode not in {"official-webhook", "official-websocket"}:
        raise Rejected("QQ_MODE_NOT_SUPPORTED")
    # Deliberately before AppID/AppSecret lookup; this turn never grants this flag
    # against the real environment. Tests pass their own synthetic mapping.
    if not authorize_secret_read:
        raise Rejected("QQ_CREDENTIAL_ACCESS_NOT_AUTHORIZED")
    flags = [
        source.get(name, "0") for name in ("WEIBIYE_QQ_ALLOW_NETWORK", "WEIBIYE_QQ_ALLOW_SEND")
    ]
    if any(value not in {"0", "1"} for value in flags):
        raise Rejected("QQ_FLAG_INVALID")
    return QQOptions(
        mode,
        flags[0] == "1",
        flags[1] == "1",
        QQCredentials(
            source.get("WEIBIYE_QQ_APP_ID", ""),
            SecretStr(source.get("WEIBIYE_QQ_APP_SECRET", "")),
        ),
    )
