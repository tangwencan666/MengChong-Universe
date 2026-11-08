"""Local operator-only access to ignored Mock files. This module has no HTTP routes."""

import json
import re
from pathlib import Path


def read_mailbox(directory: Path) -> list[dict]:
    root = Path(__file__).resolve().parents[4] / ".verification"
    directory = directory.resolve()
    if not directory.is_relative_to(root.resolve()):
        raise ValueError("Mock mailbox must remain inside this checkout's verification directory")
    if not directory.is_dir():
        return []
    messages = []
    for path in directory.rglob("*.json"):
        if (
            path.is_symlink()
            or not path.resolve().is_relative_to(directory)
            or not re.fullmatch(r"[0-9a-f]{32}", path.stem)
        ):
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if (
            value.get("mock") is True
            and value.get("id") == path.stem
            and isinstance(value.get("created_at"), str)
        ):
            messages.append(value)
    return sorted(messages, key=lambda value: value["created_at"])
