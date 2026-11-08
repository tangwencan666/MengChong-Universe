"""Guarded, transactional, forward-only 0001 -> 0002 on the dedicated local database."""

import argparse
import json
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.db import models  # noqa: F401
from app.db.base import Base


def require(condition: bool, message: str):
    # Runtime safety checks must also remain enabled with Python optimization.
    if not condition:
        raise SystemExit(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-cluster-id", required=True)
    args = parser.parse_args()
    url = make_url(Settings().database_url.get_secret_value())
    if (url.drivername, url.host, url.port, url.database, url.username) != (
        "postgresql+psycopg",
        "127.0.0.1",
        25433,
        "weibiye",
        "weibiye",
    ):
        raise SystemExit("Unexpected migration target; stopped")
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini"))
    engine = create_engine(url, connect_args={"connect_timeout": 3})
    result = {}
    try:
        with engine.begin() as db:
            db.execute(text("SET LOCAL lock_timeout = '5s'"))
            db.execute(text("SET LOCAL statement_timeout = '60s'"))
            require(
                db.scalar(text("SELECT pg_try_advisory_xact_lock(774203620002)")),
                "Migration already in progress",
            )
            identity = db.execute(
                text(
                    "SELECT current_database(),current_user,"
                    "(SELECT system_identifier::text FROM pg_control_system())"
                )
            ).one()
            require(
                tuple(identity) == ("weibiye", "weibiye", args.expected_cluster_id),
                "Unexpected cluster identity",
            )
            require(
                db.scalar(text("SELECT version_num FROM alembic_version")) == "0001",
                "Unexpected migration version",
            )
            before_tables = set(inspect(db).get_table_names())
            expected_tables = (
                set(Base.metadata.tables) - {"auth_sessions", "email_verifications"}
            ) | {"alembic_version"}
            require(before_tables == expected_tables, "Unexpected existing table set")
            before = {
                name: db.scalar(
                    text(f"SELECT count(*) FROM {engine.dialect.identifier_preparer.quote(name)}")
                )
                for name in before_tables
                if name != "alembic_version"
            }
            require(
                all(value == 0 for value in before.values()),
                "Unexpected existing business data; stopped",
            )
            config.attributes["connection"] = db
            command.upgrade(config, "0002")
            command.check(config)
            after_tables = set(inspect(db).get_table_names())
            require(
                before_tables <= after_tables and len(after_tables) == 18,
                "Unexpected upgraded table set",
            )
            after = {
                name: db.scalar(
                    text(f"SELECT count(*) FROM {engine.dialect.identifier_preparer.quote(name)}")
                )
                for name in after_tables
                if name != "alembic_version"
            }
            require(all(value == 0 for value in after.values()), "Unexpected data after upgrade")
            require(
                db.scalar(text("SELECT version_num FROM alembic_version")) == "0002",
                "Unexpected upgraded version",
            )
            result = {
                "clusterVerified": True,
                "database": identity[0],
                "fromRevision": "0001",
                "toRevision": "0002",
                "transactional": True,
                "metadataDrift": False,
                "beforeRowCounts": before,
                "afterRowCounts": after,
                "removedTables": [],
                "downgradeExecuted": False,
            }
    finally:
        engine.dispose()
    output = backend.parent / ".verification/auth/migration.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
