"""Print fictional configuration-based capacity arithmetic. No network or DB."""

import argparse
import json
from pathlib import Path

from app.modules.qq_p87.capacity import forecast


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    path = args.config or Path(__file__).parents[1] / "app/modules/qq_p87/capacity_example.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    print(json.dumps(forecast(config), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
