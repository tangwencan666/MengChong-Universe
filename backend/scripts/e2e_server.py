"""Run the browser suite against a new, isolated, forward-migrated SQLite database.

Never connects to the existing PostgreSQL or resets an existing database.
Test files remain under this checkout's ignored .verification directory.
"""

import os
from pathlib import Path
from uuid import uuid4

import uvicorn
from alembic import command
from alembic.config import Config

from app.core.config import get_settings


def configured_port(name: str, default: int) -> int:
    value = os.environ.get(name, str(default))
    if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 65535:
        raise ValueError(f"{name} must be a decimal port from 1 to 65535")
    return int(value)


def main():
    api_port = configured_port("WEIBIYE_E2E_API_PORT", 28101)
    ui_port = configured_port("WEIBIYE_E2E_UI_PORT", 25174)
    backend = Path(__file__).resolve().parents[1]
    directory = backend.parent / ".verification" / "auth" / "browser"
    directory.mkdir(parents=True, exist_ok=True)
    database = directory / f"e2e-{uuid4().hex}.db"
    assert not database.exists() and database.resolve().is_relative_to(directory.resolve())
    os.environ["WEIBIYE_DATABASE_URL"] = f"sqlite:///{database.as_posix()}"
    get_settings.cache_clear()
    command.upgrade(Config(str(backend / "alembic.ini")), "head")
    os.environ["WEIBIYE_DATABASE_URL"] = f"sqlite+aiosqlite:///{database.as_posix()}"
    os.environ["WEIBIYE_MOCK_MAIL_DIR"] = str(backend.parent / ".verification/p25/browser-mail")
    os.environ["WEIBIYE_FRONTEND_ORIGIN"] = f"http://127.0.0.1:{ui_port}"
    get_settings.cache_clear()
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=api_port,
        access_log=False,
        proxy_headers=False,
        loop="app.core.event_loop:new_event_loop",
    )


if __name__ == "__main__":
    main()
