"""Reuse the existing isolated Mock API with fresh P7 evidence and Redis keys."""

import json
import re
from pathlib import Path

import desktop_mvp_server

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / ".verification/p7"


def main():
    original = json.loads((ROOT / ".verification/p6/target.json").read_text(encoding="utf-8"))
    target = json.loads((OUTPUT / "target.json").read_text(encoding="utf-8"))
    assert target["databaseName"] == original["databaseName"]
    assert target["runId"] == original["runId"]
    assert re.fullmatch(r"[0-9a-f]{32}", target["p7RunId"])
    assert target["redisPrefix"] == "weibiye:p7:" + target["p7RunId"] + ":"
    assert target["accounts"] == original["accounts"]
    # The existing launcher rechecks cluster, schema, active jobs and Mock mode.
    # Override only this process's output root; never append to P6 evidence.
    desktop_mvp_server.OUT = OUTPUT
    desktop_mvp_server.main()


if __name__ == "__main__":
    main()
