"""Run acceptance on the prepared isolated target and edit only named test fixtures.

No database resets, HTTP test backdoors or real model calls. Fault operations
require an owned synthetic browser account and exact session/generation IDs.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from p3_integration_database import CLUSTER, local_url, read_manifest, require, snapshot
from redis import Redis
from sqlalchemy import create_engine, select, text, update

from app.core.config import Settings
from app.modules.auth.models import AuthSession
from app.modules.companion.models import ChatGeneration, ChatGenerationEvent, ChatSession
from app.modules.users.models import User

ROOT = Path(__file__).resolve().parents[2]


def target():
    data = read_manifest()
    source = local_url(
        Settings.model_fields["database_url"].default.get_secret_value(), shared=True
    )
    url = source.set(database=data["database"])
    state = snapshot(url)
    require(state["revision"] == "0004" and state["business_tables"] == 21, "Target mismatch")
    with Redis(host="127.0.0.1", port=26380, db=15, socket_timeout=3) as cache:
        require(
            cache.info("server")["run_id"] == data["redis_run_id"]
            and cache.get(data["redis_lease_key"]) == data["run_id"].encode(),
            "Integration Redis ownership mismatch",
        )
    return data, url


def fixture(operation, payload):
    _, url = target()
    engine = create_engine(url)
    try:
        with engine.begin() as db:
            require(
                db.scalar(text("SELECT system_identifier::text FROM pg_control_system()"))
                == CLUSTER,
                "Cluster mismatch",
            )
            owner = UUID(payload["owner_id"])
            email = db.scalar(select(User.email).where(User.id == owner))
            require(
                email and email.startswith("browser-") and email.endswith("@example.com"),
                "Only synthetic browser accounts in the isolated test database are allowed",
            )
            if operation == "expire-session":
                identifier = UUID(payload["auth_session_id"])
                row = db.execute(
                    select(AuthSession.created_at, AuthSession.expires_at).where(
                        AuthSession.id == identifier, AuthSession.user_id == owner
                    )
                ).one()
                # Preserve the expiry constraint while simulating elapsed wall time.
                db.execute(
                    update(AuthSession)
                    .where(AuthSession.id == identifier, AuthSession.user_id == owner)
                    .values(
                        created_at=datetime.now(UTC) - timedelta(days=2),
                        expires_at=datetime.now(UTC) - timedelta(seconds=1),
                    )
                )
                return {"expired": True, "previously_valid": row.expires_at > datetime.now(UTC)}
            session_id, generation_id = UUID(payload["session_id"]), UUID(payload["generation_id"])
            gen = db.execute(
                select(ChatGeneration.finished_at, ChatGeneration.last_event_sequence)
                .join(ChatSession, ChatSession.id == ChatGeneration.session_id)
                .where(
                    ChatGeneration.id == generation_id,
                    ChatGeneration.session_id == session_id,
                    ChatGeneration.owner_id == owner,
                    ChatGeneration.state == "completed",
                    ChatSession.owner_id == owner,
                    ChatSession.deleted_at.is_(None),
                )
            ).one()
            event_scope = (
                ChatGenerationEvent.generation_id == generation_id,
                ChatGenerationEvent.session_id == session_id,
                ChatGenerationEvent.owner_id == owner,
                ChatGenerationEvent.event_type == "delta",
            )
            if operation == "journal-gap":
                event = db.execute(
                    select(ChatGenerationEvent.id).where(
                        *event_scope, ChatGenerationEvent.event_sequence == 2
                    )
                ).one()
                db.execute(
                    update(ChatGenerationEvent)
                    .where(ChatGenerationEvent.id == event.id, *event_scope)
                    .values(event_sequence=gen.last_event_sequence + 100)
                )
                return {"event_id": str(event.id), "original_sequence": 2}
            if operation == "restore-journal":
                result = db.execute(
                    update(ChatGenerationEvent)
                    .where(
                        ChatGenerationEvent.id == UUID(payload["event_id"]),
                        *event_scope,
                        ChatGenerationEvent.event_sequence == gen.last_event_sequence + 100,
                    )
                    .values(event_sequence=2)
                )
                require(result.rowcount == 1, "Fixture restoration target mismatch")
                return {"restored": True}
            if operation == "expire-replay":
                db.execute(
                    update(ChatGeneration)
                    .where(ChatGeneration.id == generation_id, ChatGeneration.owner_id == owner)
                    .values(finished_at=datetime.now(UTC) - timedelta(days=2))
                )
                return {"finished_at": gen.finished_at.isoformat()}
            if operation == "restore-replay":
                db.execute(
                    update(ChatGeneration)
                    .where(ChatGeneration.id == generation_id, ChatGeneration.owner_id == owner)
                    .values(finished_at=datetime.fromisoformat(payload["finished_at"]))
                )
                return {"restored": True}
            raise ValueError("Unknown isolated fixture operation")
    finally:
        engine.dispose()


def run(kind, extra):
    data, url = target()
    env = dict(os.environ)
    env.update(
        WEIBIYE_DATABASE_URL=url.render_as_string(hide_password=False),
        WEIBIYE_REDIS_URL="redis://127.0.0.1:26380/15",
        WEIBIYE_AUTH_TEST_REDIS_URL="redis://127.0.0.1:26380/15",
        WEIBIYE_CHAT_TEST_DATABASE_URL=url.render_as_string(hide_password=False),
        WEIBIYE_AUTH_TEST_DATABASE_URL=url.set(database=data["auth_database"]).render_as_string(
            hide_password=False
        ),
        WEIBIYE_AUTH_PG_TESTS="1",
        WEIBIYE_EXPECTED_PG_CLUSTER_ID=CLUSTER,
        WEIBIYE_P3_TEST_RUN_ID=data["run_id"],
        WEIBIYE_TEST_PYTHON=sys.executable,
        WEIBIYE_ENVIRONMENT="test",
        WEIBIYE_LLM_PROVIDER="mock",
        WEIBIYE_REAL_LLM_ENABLED="false",
        LANGSMITH_TRACING="false",
        LANGCHAIN_TRACING_V2="false",
        PYTHONUTF8="1",
    )
    # Existing opt-in shared-development infrastructure tests are never enabled here.
    env.pop("WEIBIYE_LOCAL_INFRA_TESTS", None)
    if kind == "browser":
        browser = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
        if not env.get("WEIBIYE_BROWSER_PATH") and browser.exists():
            env["WEIBIYE_BROWSER_PATH"] = str(browser)
        command = [
            shutil.which("node") or "node",
            str(ROOT / "frontend/node_modules/@playwright/test/cli.js"),
            "test",
            "--config=playwright.integration.config.ts",
            *extra,
        ]
        working = ROOT / "frontend"
    else:
        command = [sys.executable, "-B", "-m", "pytest", *extra]
        working = ROOT / "backend"
    # No shell interpolation of URLs, identifiers or test arguments.
    return subprocess.run(command, cwd=working, env=env, check=False).returncode


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("browser", "backend", "fixture"))
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.mode == "fixture":
        require(len(args.arguments) == 2, "Fixture operation and JSON payload are required")
        print(json.dumps(fixture(args.arguments[0], json.loads(args.arguments[1]))))
    else:
        raise SystemExit(run(args.mode, args.arguments))
