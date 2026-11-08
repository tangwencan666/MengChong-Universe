"""Revalidate existing P6 fixtures read-only and create a fresh, immutable P81 target.

No migrations, Redis writes, model credentials, service startup or model requests.
Run as: python -B -m scripts.p81_prepare_target
"""

import hashlib
import json
import os
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from redis import Redis
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from scripts.p81_live_acceptance import PrivateParser

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".verification/p81"


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def validate_source(source, baseline):
    require(bool(re.fullmatch(r"[a-f0-9]{32}", baseline["runId"])), "P81_INVALID_BASELINE")
    require(
        source["runId"] == baseline["runId"]
        and source["databaseName"]
        == baseline["databaseName"]
        == "weibiye_p6_desktop_test_" + baseline["runId"],
        "P81_DATABASE_BINDING_MISMATCH",
    )
    require(source["cluster"] == baseline["cluster"], "P81_CLUSTER_BINDING_MISMATCH")
    require(source["schemaVersion"] == baseline["schemaVersion"] == "0006", "P81_INVALID_SCHEMA")
    require(source["accounts"] == baseline["accounts"], "P81_ACCOUNT_BINDING_MISMATCH")
    accounts = source["accounts"]
    require(set(accounts) == {"a", "b"}, "P81_INVALID_ACCOUNTS")
    require(accounts["a"]["user_id"] != accounts["b"]["user_id"], "P81_INVALID_ACCOUNTS")
    for label, count in [("a", 3), ("b", 1)]:
        UUID(accounts[label]["user_id"])
        require(len(accounts[label]["pets"]) == count, "P81_INVALID_PETS")
        for pet in accounts[label]["pets"]:
            UUID(pet["pet_id"])
    require(
        source["moonOwnerId"] == accounts["a"]["user_id"]
        and source["moonPetId"] in {pet["pet_id"] for pet in accounts["a"]["pets"]},
        "P81_MOON_BINDING_MISMATCH",
    )


def check_database(target):
    # Read only the database variable. Do not instantiate global Settings or read model keys.
    default_url = Settings.model_fields["database_url"].default.get_secret_value()
    source = make_url(os.environ.get("WEIBIYE_DATABASE_URL", default_url))
    require(
        (source.drivername, source.host, source.port, source.username, source.database)
        == ("postgresql+psycopg", "127.0.0.1", 25433, "weibiye", "weibiye")
        and not source.query,
        "P81_DATABASE_ENDPOINT_MISMATCH",
    )
    # Connect directly to the baseline's isolated database, never the shared database.
    engine = create_engine(
        source.set(database=target["databaseName"]),
        connect_args={
            "connect_timeout": 5,
            "options": "-c default_transaction_read_only=on -c statement_timeout=5000 "
            "-c lock_timeout=2000",
        },
    )
    try:
        with engine.begin() as db:
            require(db.scalar(text("SHOW transaction_read_only")) == "on", "P81_NOT_READ_ONLY")
            require(
                db.scalar(text("SELECT current_database()")) == target["databaseName"],
                "P81_DATABASE_BINDING_MISMATCH",
            )
            require(
                db.scalar(text("SELECT system_identifier::text FROM pg_control_system()"))
                == target["cluster"],
                "P81_POSTGRES_CLUSTER_MISMATCH",
            )
            require(
                db.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
                and len(set(inspect(db).get_table_names()) - {"alembic_version"}) == 34,
                "P81_DATABASE_SCHEMA_MISMATCH",
            )
            require(
                db.scalar(
                    text(
                        "SELECT count(*) FROM chat_generations WHERE state IN "
                        "('queued','running','cancel_requested')"
                    )
                )
                == 0,
                "P81_ACTIVE_GENERATIONS",
            )
            for account in target["accounts"].values():
                require(
                    db.scalar(
                        text(
                            "SELECT count(*) FROM users WHERE id=:id AND email=:email "
                            "AND status='active'"
                        ),
                        {"id": account["user_id"], "email": account["email"]},
                    )
                    == 1,
                    "P81_ACCOUNT_BINDING_MISMATCH",
                )
                for pet in account["pets"]:
                    require(
                        db.scalar(
                            text(
                                "SELECT count(*) FROM pets WHERE id=:id AND owner_id=:owner "
                                "AND name=:name AND role_type=:role AND status='active'"
                            ),
                            {
                                "id": pet["pet_id"],
                                "owner": account["user_id"],
                                "name": pet["name"],
                                "role": pet["role_type"],
                            },
                        )
                        == 1,
                        "P81_PET_BINDING_MISMATCH",
                    )
    finally:
        engine.dispose()


def docker_output(arguments):
    result = subprocess.run(
        ["docker", *arguments],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    require(result.returncode == 0, "P81_DOCKER_IDENTITY_UNAVAILABLE")
    return result.stdout


def check_redis():
    # Request selected metadata only: Docker's environment is never inspected.
    template = (
        '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},'
        '"startedAt":{{json .State.StartedAt}},"labels":{{json .Config.Labels}},'
        '"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}'
    )
    container = json.loads(docker_output(["inspect", "--format", template, "weibiye-redis-1"]))
    require(
        container["name"] == "/weibiye-redis-1"
        and container["running"] is True
        and container["labels"].get("com.docker.compose.project") == "weibiye"
        and container["labels"].get("com.docker.compose.service") == "redis"
        and container["ports"].get("6379/tcp") == [{"HostIp": "127.0.0.1", "HostPort": "26380"}]
        and any(
            mount.get("Type") == "volume"
            and mount.get("Destination") == "/data"
            and mount.get("Name") == "weibiye_weibiye_redisdata"
            for mount in container["mounts"]
        ),
        "P81_REDIS_CONTAINER_MISMATCH",
    )
    info = docker_output(["exec", "weibiye-redis-1", "redis-cli", "INFO", "server"])
    run_ids = re.findall(r"^run_id:([a-f0-9]{40})\r?$", info, re.MULTILINE)
    require(len(run_ids) == 1, "P81_REDIS_IDENTITY_UNAVAILABLE")
    with Redis.from_url(
        "redis://127.0.0.1:26380/0", socket_connect_timeout=3, socket_timeout=3
    ) as cache:
        require(cache.ping(), "P81_REDIS_UNAVAILABLE")
        require(cache.info("server")["run_id"] == run_ids[0], "P81_REDIS_ENDPOINT_MISMATCH")
    return {
        "runId": run_ids[0],
        "containerId": container["id"],
        "startedAt": container["startedAt"],
        "volume": "weibiye_weibiye_redisdata",
    }


def prepare(source_path):
    source_path = source_path.resolve()
    require(source_path.is_relative_to(OUT.resolve()), "P81_FOREIGN_TARGET")
    source_bytes = source_path.read_bytes()
    baseline_bytes = (ROOT / ".verification/p6/target.json").read_bytes()
    source, baseline = json.loads(source_bytes), json.loads(baseline_bytes)
    validate_source(source, baseline)
    check_database(source)
    redis = check_redis()
    run = uuid4().hex
    target = {
        name: source[name]
        for name in (
            "runId",
            "databaseName",
            "schemaVersion",
            "cluster",
            "accounts",
            "moonOwnerId",
            "moonPetId",
        )
    }
    target.update(
        p81RunId=run,
        redisRunId=redis["runId"],
        redisPrefix="weibiye:p81:" + run + ":",
        backendOrigin="http://127.0.0.1:38319",
        uiPort=35319,
        modelTransport="httpx-mock-only",
        createdAt=datetime.now(UTC).isoformat(),
    )
    folder = OUT / ("prepared-" + run)
    folder.mkdir(exist_ok=False)
    target_path = folder / "target.json"
    with target_path.open("x", encoding="utf-8") as file:
        json.dump(target, file, ensure_ascii=False, indent=2)
    evidence = {
        "status": "P81_ISOLATED_TARGET_PREPARED",
        "target": str(target_path),
        "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "baseline_sha256": hashlib.sha256(baseline_bytes).hexdigest(),
        "target_sha256": hashlib.sha256(target_path.read_bytes()).hexdigest(),
        "cluster": target["cluster"],
        "database": target["databaseName"],
        "schema_version": "0006",
        "tables": 34,
        "accounts_verified": 2,
        "pets_verified": 4,
        "previous_redis_run_id": source["redisRunId"],
        "verified_redis": redis,
        "database_read_only": True,
        "model_requests": 0,
    }
    with (folder / "preparation.json").open("x", encoding="utf-8") as file:
        json.dump(evidence, file, ensure_ascii=False, indent=2)
    return evidence


def main(argv=None):
    parser = PrivateParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=OUT / "target.json")
    args = parser.parse_args(argv)
    try:
        result = prepare(args.source)
    except Exception:
        print(json.dumps({"status": "P81_TARGET_PREPARATION_BLOCKED", "model_requests": 0}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
