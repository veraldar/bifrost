#!/usr/bin/env python3
"""ledger.py — append-only sim-world rows, harness-bench shape + sim fields.

Row: {ts, lab: "sim-world", kind, scenario, verdict, findings[], wall_ms, extra...}
Lands in ~/.local/share/bifrost/bench/sim-world.jsonl (append-only, never overwrite
— LABS.md draft rule 2). Trends read this file; scorecards are dated artifacts.
"""
import json
import pathlib
import time

LEDGER = pathlib.Path.home() / ".local/share/bifrost/bench/sim-world.jsonl"


def row(**d):
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    r = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "lab": "sim-world", **d}
    with open(LEDGER, "a") as f:
        f.write(json.dumps(r) + "\n")
    return r


def tail(n=20):
    if not LEDGER.exists():
        return []
    lines = LEDGER.read_text().strip().splitlines()
    return [json.loads(x) for x in lines[-n:]]


if __name__ == "__main__":
    for r in tail(int(__import__("sys").argv[1]) if len(__import__("sys").argv) > 1 else 20):
        print(json.dumps(r))
