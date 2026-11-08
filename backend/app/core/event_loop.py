"""Explicit loop factory for Psycopg async support on Windows.

Use with TestClient backend_options or Uvicorn --loop app.core.event_loop:new_event_loop.
Does not change the process-wide event-loop policy during application import.
"""

import asyncio
import selectors
import sys


def new_event_loop() -> asyncio.AbstractEventLoop:
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop(selectors.SelectSelector())
    return asyncio.new_event_loop()
