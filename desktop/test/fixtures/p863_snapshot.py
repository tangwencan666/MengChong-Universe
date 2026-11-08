"""Read only this new summon fixture; retain hashes, never synthetic chat bodies."""

import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
run = Path(sys.argv[1]).resolve()
if run.parent != ROOT / ".verification" / "p86" or not re.fullmatch(
    r"p863-immersive-[a-f0-9-]{36}", run.name
):
    raise RuntimeError("Owned summon fixture required")
phase = sys.argv[2]
if phase not in {"before", "after", "before-duplicates", "after-duplicates"}:
    raise RuntimeError("Known snapshot phase required")
target = json.loads((run / "target.json").read_text(encoding="utf-8"))
database = run / "p85-offline.sqlite3"
if Path(target["database"]).resolve() != database or database.is_symlink():
    raise RuntimeError("Fixture identity mismatch")
tables = {}
with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    names = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    for (name,) in names:
        if not re.fullmatch(r"[a-z_]+", name) or not re.search(r"pet|chat|memory|companion", name):
            continue
        fields = connection.execute(f'PRAGMA table_info("{name}")').fetchall()
        primary = [row[1] for row in sorted(fields, key=lambda row: row[5]) if row[5]]
        rows = connection.execute(f'SELECT * FROM "{name}"').fetchall()
        columns = [row[1] for row in fields]
        values = {}
        for row in rows:
            record = dict(zip(columns, row, strict=True))
            key = json.dumps([record[field] for field in primary], sort_keys=True, default=str)
            digest = hashlib.sha256(
                json.dumps(record, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()
            values[key] = digest
        tables[name] = values
with (run / ("database-" + phase + ".json")).open("x", encoding="utf-8") as output:
    json.dump(tables, output, indent=2)
print(json.dumps({"tables": len(tables), "rows": sum(map(len, tables.values()))}))
