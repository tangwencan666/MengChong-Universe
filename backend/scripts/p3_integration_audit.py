"""Read-only P3 integration safety audit; only ignored evidence files are written.

The capture is a takeover-time baseline, not a reconstruction of the earlier
integration run. Never read Docker environment variables or credential files.
"""

import argparse
import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from p3_integration_database import CLUSTER, ROOT, local_url, read_manifest, require
from redis import Redis
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core.config import Settings

EVIDENCE = ROOT / ".verification"
BEFORE = EVIDENCE / "p3-safety-before.json"
AFTER = EVIDENCE / "p3-safety-after.json"
WORKTREES = {
    "main": (
        Path("D:/AIProjects/WeiBiYe"),
        "codex/p25-auth-recovery",
        "e62d3864ee094404a995a79b1ea10429ac9966ff",
    ),
    "backend": (
        Path("D:/AIProjects/WeiBiYe-worktrees/p3-backend"),
        "codex/p3-chat-backend",
        "122fa85945af87e72cbe4d9e1d18cb98e4b1ec65",
    ),
    "frontend": (
        Path("D:/AIProjects/WeiBiYe-worktrees/p3-frontend"),
        "codex/p3-chat-frontend",
        "4ce426241cb7df9ccd6433dd2f407a495cc16c7a",
    ),
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def run(args, *, cwd=ROOT, binary=False):
    result = subprocess.run(
        args, cwd=cwd, check=True, capture_output=True, timeout=60, text=not binary
    )
    return result.stdout


def worktree_snapshots():
    result = {}
    for label, (root, expected_branch, expected_head) in WORKTREES.items():
        branch = run(["git", "branch", "--show-current"], cwd=root).strip()
        head = run(["git", "rev-parse", "HEAD"], cwd=root).strip()
        status = run(
            ["git", "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=root,
        )
        require((branch, head) == (expected_branch, expected_head), "Feature branch drift")
        require(not status.strip(), "An original worktree is no longer clean")
        paths = run(["git", "ls-files", "-z"], cwd=root, binary=True).split(b"\0")
        hashes = {}
        for raw in paths:
            if not raw:
                continue
            relative = raw.decode("utf-8")
            path = root / relative
            require(path.resolve().is_relative_to(root.resolve()), "Tracked path escapes worktree")
            name = path.name.lower()
            require(
                (not name.startswith(".env") or name == ".env.example")
                and path.suffix.lower() not in {".key", ".pem", ".pfx", ".p12"}
                and name not in {"credentials.json", "id_rsa", "id_ed25519"},
                "Refusing to hash a credential-like tracked file",
            )
            hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        result[label] = {
            "path": str(root),
            "branch": branch,
            "head": head,
            "status": status,
            "tracked_sha256": hashes,
            "aggregate_sha256": digest(hashes),
        }
    return result


def docker_snapshot():
    ids = sorted(run(["docker", "ps", "-aq", "--no-trunc"]).split())
    # These named fields exclude Config.Env, logs, commands and health output.
    template = (
        '{"id":{{json .Id}},"name":{{json .Name}},'
        '"status":{{json .State.Status}},"started_at":{{json .State.StartedAt}},'
        '"restart_count":{{json .RestartCount}},'
        '"health":{{with index .State "Health"}}{{json (index . "Status")}}'
        "{{else}}null{{end}},"
        '"image_id":{{json .Image}},"image":{{json .Config.Image}},'
        '"networks":{{json .NetworkSettings.Networks}},'
        '"port_bindings":{{json .HostConfig.PortBindings}},'
        '"ports":{{json .NetworkSettings.Ports}},'
        '"restart_policy":{{json .HostConfig.RestartPolicy}}}'
    )
    containers = []
    for offset in range(0, len(ids), 40):
        output = run(["docker", "inspect", "--format", template, *ids[offset : offset + 40]])
        for line in output.splitlines():
            entry = json.loads(line)
            entry["networks"] = {
                name: {
                    key: network.get(key)
                    for key in ("NetworkID", "EndpointID", "IPAddress", "GlobalIPv6Address")
                }
                for name, network in sorted((entry["networks"] or {}).items())
            }
            containers.append(entry)
    return sorted(containers, key=lambda item: item["id"])


def database_snapshot(url):
    engine = create_engine(
        url.update_query_dict({"options": "-c default_transaction_read_only=on"}),
        connect_args={"connect_timeout": 3},
    )
    try:
        with engine.connect() as db:
            identity = db.execute(
                text(
                    "SELECT current_database(), current_user, "
                    "(SELECT system_identifier::text FROM pg_control_system()), "
                    "current_setting('transaction_read_only')"
                )
            ).one()
            require(tuple(identity) == (url.database, "weibiye", CLUSTER, "on"), "DB identity")
            tables = sorted(inspect(db).get_table_names(schema="public"))
            counts = {
                name: db.exec_driver_sql(
                    "SELECT count(*) FROM public."
                    + db.dialect.identifier_preparer.quote_identifier(name)
                ).scalar_one()
                for name in tables
                if name != "alembic_version"
            }
            columns = db.execute(
                text(
                    "SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod),"
                    "a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated "
                    "FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid "
                    "JOIN pg_namespace n ON n.oid=c.relnamespace "
                    "LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum "
                    "WHERE n.nspname='public' AND c.relkind IN ('r','p') "
                    "AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum"
                )
            ).all()
            constraints = db.execute(
                text(
                    "SELECT c.relname,x.conname,x.contype,pg_get_constraintdef(x.oid,true),"
                    "x.convalidated FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid "
                    "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' "
                    "ORDER BY c.relname,x.conname"
                )
            ).all()
            indexes = db.execute(
                text(
                    "SELECT t.relname,i.relname,pg_get_indexdef(i.oid),x.indisvalid,"
                    "x.indisready,x.indisunique FROM pg_index x JOIN pg_class i "
                    "ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid "
                    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' "
                    "ORDER BY t.relname,i.relname"
                )
            ).all()
            standalone_indexes = db.scalar(
                text(
                    "SELECT count(*) FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid "
                    "JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' "
                    "AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=x.indexrelid)"
                )
            )
            shape = {
                "tables": tables,
                "columns": [list(row) for row in columns],
                "constraints": [list(row) for row in constraints],
                "indexes": [list(row) for row in indexes],
            }
            return {
                "database": url.database,
                "cluster": CLUSTER,
                "read_only": True,
                "revision": db.scalar(text("SELECT version_num FROM alembic_version")),
                "business_tables": len(counts),
                "counts": counts,
                "schema": shape,
                "schema_sha256": digest(shape),
                "counts_sha256": digest(counts),
                "foreign_keys": sum(row[2] == "f" for row in constraints),
                "unique_constraints": sum(row[2] == "u" for row in constraints),
                "check_constraints": sum(row[2] == "c" for row in constraints),
                "indexes_total_including_constraint_indexes": len(indexes),
                "standalone_indexes": standalone_indexes,
                "invalid_indexes": sum(not row[3] or not row[4] for row in indexes),
                "unvalidated_constraints": sum(not row[4] for row in constraints),
            }
    finally:
        engine.dispose()


def collect():
    manifest = read_manifest()
    settings = Settings(_env_file=None)
    source = make_url(settings.database_url.get_secret_value()).set(database="weibiye")
    source = local_url(source.render_as_string(hide_password=False), shared=True)
    development = database_snapshot(source)
    expected = manifest["shared_before"]
    for field in ("database", "cluster", "revision", "business_tables", "counts", "read_only"):
        require(development[field] == expected[field], "Shared development snapshot changed")
    require(development["revision"] == "0003", "Development database revision changed")
    require(not any(development["counts"].values()), "Unexpected development database records")
    integration = database_snapshot(source.set(database=manifest["database"]))
    require(
        integration["revision"] == "0004"
        and integration["business_tables"] == 21
        and integration["invalid_indexes"] == integration["unvalidated_constraints"] == 0,
        "Integration schema is not a valid 21-table 0004 schema",
    )
    with Redis(host="127.0.0.1", port=26380, db=15, socket_timeout=3) as cache:
        server = cache.info("server")
        require(
            server["run_id"] == manifest["redis_run_id"]
            and cache.get(manifest["redis_lease_key"]) == manifest["run_id"].encode(),
            "Redis instance or integration ownership changed",
        )
        redis = {
            "host": "127.0.0.1",
            "port": 26380,
            "db": 15,
            "run_id": server["run_id"],
            "lease_verified": True,
            "keys": cache.dbsize(),
        }
    return {
        "captured_at": datetime.now(UTC).isoformat(),
        "baseline_scope": "takeover-time; not the original pre-test baseline",
        "original_pre_test_database_evidence": "manifest revision/table counts/record counts only",
        "run_id": manifest["run_id"],
        "worktrees": worktree_snapshots(),
        "development": development,
        "integration": integration,
        "redis": redis,
        "docker": docker_snapshot(),
    }


def compare(before, after):
    differences = {
        "worktrees_unchanged": before["worktrees"] == after["worktrees"],
        "development_schema_and_counts_unchanged": before["development"] == after["development"],
        "integration_schema_unchanged": (
            before["integration"]["schema_sha256"] == after["integration"]["schema_sha256"]
        ),
        "container_changes": [],
        "unexpected_container_changes": [],
        "sentinel_automatic_restart_changes": [],
    }
    old = {item["id"]: item for item in before["docker"]}
    new = {item["id"]: item for item in after["docker"]}
    differences["container_ids_unchanged"] = set(old) == set(new)
    volatile = {"status", "started_at", "restart_count", "health", "networks", "ports"}
    for container_id in sorted(set(old) | set(new)):
        first, last = old.get(container_id), new.get(container_id)
        if first == last:
            continue
        name = (last or first)["name"]
        fields = (
            sorted(key for key in first if first[key] != last[key])
            if first and last
            else ["container_added_or_removed"]
        )
        change = {"id": container_id, "name": name, "changed_fields": fields}
        differences["container_changes"].append(change)
        automatic_restart = (
            first
            and last
            and name.startswith("/project-sentinel-")
            and set(fields).issubset(volatile)
            and last["restart_count"] >= first["restart_count"]
            and (
                set(fields).issubset({"status", "health"})
                or last["restart_count"] > first["restart_count"]
            )
            and first["restart_policy"]["Name"] in {"always", "unless-stopped", "on-failure"}
        )
        category = (
            "sentinel_automatic_restart_changes"
            if automatic_restart
            else "unexpected_container_changes"
        )
        differences[category].append(change)
    differences["necessary_safety_checks_passed"] = (
        differences["worktrees_unchanged"]
        and differences["development_schema_and_counts_unchanged"]
        and differences["integration_schema_unchanged"]
        and differences["container_ids_unchanged"]
        and not differences["unexpected_container_changes"]
    )
    return differences


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("capture", "verify"))
    operation = parser.parse_args().operation
    if operation == "capture":
        require(not BEFORE.exists(), "Takeover baseline already exists; refusing replacement")
        result = collect()
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        BEFORE.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        print(
            json.dumps(
                {
                    "operation": operation,
                    "baseline_scope": result["baseline_scope"],
                    "containers": len(result["docker"]),
                    "original_worktrees": len(result["worktrees"]),
                    "development_revision": result["development"]["revision"],
                    "development_business_tables": result["development"]["business_tables"],
                    "integration_revision": result["integration"]["revision"],
                    "integration_schema": {
                        field: result["integration"][field]
                        for field in (
                            "business_tables",
                            "foreign_keys",
                            "unique_constraints",
                            "check_constraints",
                            "standalone_indexes",
                            "invalid_indexes",
                        )
                    },
                    "redis_ownership_verified": True,
                }
            )
        )
    else:
        require(BEFORE.exists(), "No takeover baseline exists")
        before = json.loads(BEFORE.read_text(encoding="utf-8"))
        result = collect()
        result["comparison"] = compare(before, result)
        AFTER.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
        print(json.dumps(result["comparison"]))
        require(result["comparison"]["necessary_safety_checks_passed"], "Safety audit differs")


if __name__ == "__main__":
    main()
