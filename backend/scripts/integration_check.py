"""Read-only PostgreSQL/Redis verification for the isolated WeiBiYe database.

No resets, drops, application writes, or external model requests.
Run after alembic upgrade head, with explicit WEIBIYE_* environment variables.
"""

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.core.event_loop import new_event_loop
from app.db import models  # noqa: F401
from app.db.base import Base
from app.main import create_app


def main():
    settings = get_settings()
    settings = settings.model_copy(update={"chat_runner_enabled": False})
    url = settings.database_url.get_secret_value()
    parsed = make_url(url)
    if parsed.get_backend_name() != "postgresql" or not (parsed.database or "").startswith(
        "weibiye"
    ):
        raise SystemExit("Use an explicitly configured isolated WeiBiYe PostgreSQL database")
    engine = create_engine(url)
    try:
        assert set(Base.metadata.tables) <= set(inspect(engine).get_table_names())
    finally:
        engine.dispose()
    with TestClient(
        create_app(settings), backend_options={"loop_factory": new_event_loop}
    ) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").status_code == 200
    print("PostgreSQL table registry, live health, and real DB/Redis readiness passed")


if __name__ == "__main__":
    main()
