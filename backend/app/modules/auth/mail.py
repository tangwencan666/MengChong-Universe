import json
import os
import re
import subprocess
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from anyio import to_thread


class MailSender(Protocol):
    """A real provider must implement this interface; no network sender is configured."""

    async def send_verification(self, *, recipient: str, token: str) -> None: ...
    async def send_password_reset(self, *, recipient: str, token: str) -> None: ...
    async def send_password_changed(self, *, recipient: str) -> None: ...


@dataclass(repr=False)
class VerificationMail:
    recipient: str = field(repr=False)
    token: str = field(repr=False)
    purpose: str = "verification"
    link: str | None = field(default=None, repr=False)


class MockMailSender:
    """Process-local outbox, accessible to tests/operator code only. Never logs tokens."""

    def __init__(self, *, origin="http://127.0.0.1:35174", outbox_dir: Path | None = None):
        self.messages: deque[VerificationMail] = deque(maxlen=1000)
        self.origin = origin
        self.outbox: Path | None = None
        if outbox_dir is not None:
            verification = Path(__file__).resolve().parents[4] / ".verification"
            if not outbox_dir.resolve().is_relative_to(verification.resolve()):
                raise ValueError("Mock outbox must remain inside the local verification directory")
            self.outbox = outbox_dir / uuid4().hex
            self.outbox.mkdir(mode=0o700, parents=True, exist_ok=False)
            if os.name == "nt":
                # Restrict only the newly created directory; never change a parent's ACL.
                identity = subprocess.check_output(
                    ["whoami", "/user", "/fo", "csv", "/nh"],
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                sid = re.search(rb"S-\d-(?:\d+-)*\d+", identity)
                if sid is None:
                    raise OSError("Cannot identify the local Mock mailbox owner")
                subprocess.run(
                    [
                        "icacls",
                        str(self.outbox),
                        "/inheritance:r",
                        "/grant:r",
                        f"*{sid.group().decode('ascii')}:(OI)(CI)F",
                    ],
                    check=True,
                    capture_output=True,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )

    async def emit(self, recipient: str, token: str, purpose: str, path: str | None):
        link = f"{self.origin}/{path}#token={token}" if path else None
        self.messages.append(VerificationMail(recipient, token, purpose, link))
        if self.outbox is not None:
            message_id = uuid4().hex
            payload = {
                "id": message_id,
                "recipient": recipient,
                "purpose": purpose,
                "link": link,
                "created_at": datetime.now(UTC).isoformat(),
                "mock": True,
            }

            def write():
                descriptor = os.open(
                    self.outbox / f"{message_id}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
                )
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                    json.dump(payload, stream, ensure_ascii=False)

            await to_thread.run_sync(write)

    async def send_verification(self, *, recipient: str, token: str) -> None:
        await self.emit(recipient, token, "verification", "verify-email")

    async def send_password_reset(self, *, recipient: str, token: str) -> None:
        await self.emit(recipient, token, "password_reset", "reset-password")

    async def send_password_changed(self, *, recipient: str) -> None:
        await self.emit(recipient, "", "password_changed", None)
