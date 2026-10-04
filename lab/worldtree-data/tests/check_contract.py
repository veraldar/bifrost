#!/usr/bin/env python3
"""Page contract checker (plan.md step 7): mirrors world-tree.html's fetch handler + the realm contract.
Usage: python3 tests/check_contract.py <realms.json>  → prints CONTRACT OK or the first violation (exit 1)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wt.contract import check  # noqa: E402


def main(path):
    try:
        j = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:
        print(f"CONTRACT FAIL: unreadable JSON: {e}")
        return 1
    v = check(j)
    if v:
        print(f"CONTRACT FAIL: {v}")
        return 1
    print("CONTRACT OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
