"""Guarded, transactional 0002 -> 0003; no existing table or data is removed."""

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
from scripts.upgrade_auth import require


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-cluster-id", required=True)
    args = parser.parse_args()
    url = make_url(Settings().database_url.get_secret_value())
    require(
        (url.drivername, url.host, url.port, url.database, url.username)
        == ("postgresql+psycopg", "127.0.0.1", 25433, "weibiye", "weibiye"),
        "Unexpected migration target",
    )
    backend = Path(__file__).resolve().parents[1]
    engine = create_engine(url, connect_args={"connect_timeout": 3})
    config = Config(str(backend / "alembic.ini"))
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
                db.scalar(text("SELECT version_num FROM alembic_version")) == "0002",
                "Unexpected migration version",
            )
            before_tables = set(inspect(db).get_table_names())
            require(
                before_tables
                == (set(Base.metadata.tables) - {"password_resets"}) | {"alembic_version"},
                "Unexpected existing table set",
            )

            def counts(names):
                return {
                    name: db.scalar(
                        text(
                            f"SELECT count(*) FROM {engine.dialect.identifier_preparer.quote(name)}"
                        )
                    )
                    for name in names
                    if name != "alembic_version"
                }

            before = counts(before_tables)
            config.attributes["connection"] = db
            command.upgrade(config, "0003")
            command.check(config)
            after_tables = set(inspect(db).get_table_names())
            require(
                after_tables == before_tables | {"password_resets"}, "Unexpected upgraded tables"
            )
            after = counts(after_tables)
            require(
                all(after[name] == value for name, value in before.items()),
                "Existing data count changed",
            )
            require(after["password_resets"] == 0, "Unexpected reset data")
            require(
                db.scalar(text("SELECT version_num FROM alembic_version")) == "0003",
                "Unexpected upgraded version",
            )
            result = {
                "clusterVerified": True,
                "fromRevision": "0002",
                "toRevision": "0003",
                "beforeRowCounts": before,
                "afterRowCounts": after,
                "preservedExistingRows": True,
                "addedTables": ["password_resets"],
                "removedTables": [],
                "metadataDrift": False,
                "downgradeExecuted": False,
            }
    finally:
        engine.dispose()
    output = backend.parent / ".verification/p25/migration.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
