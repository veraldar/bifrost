#!/usr/bin/env python3
"""harness-bench runner — N reps of the task battery per (harness × model-config).

One JSONL row per turn:
  {ts, harness, model, task_id, category, turn, ttfb_ms, wall_ms, ok, score, notes}

Rows land in BOTH:
  runs/<label>.jsonl            — the working copy this repo scores from
  ~/.local/share/bifrost/bench/<date>-<harness>-<model>.jsonl — the append-only ledger

Usage:
  python3 runner.py --harness yggdrasil --reps 2 [--tasks code-fizzbuzz,voice-status]
  python3 runner.py --harness opencode --reps 2
  python3 runner.py --harness yggdrasil --model glm-5.3-flash --label nightly
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import yaml
from adapters import REGISTRY
import grader

HERE = Path(__file__).resolve().parent
LEDGER = Path.home() / ".local/share/bifrost/bench"


def load_tasks(picks: list[str] | None) -> list[dict]:
    tasks = yaml.safe_load((HERE / "tasks.yaml").read_text())["tasks"]
    if picks:
        want = set(picks)
        tasks = [t for t in tasks if t["id"] in want]
    return tasks


def prompt_for(task: dict) -> str:
    """Seed doc (extraction) rides INSIDE the prompt — a task without its doc is broken."""
    if task.get("seed_doc"):
        return f"{task['prompt']}\n\n<doc>\n{task['seed_doc'].strip()}\n</doc>"
    return task["prompt"]


def run_task(harness, task: dict, model: str) -> list[dict]:
    """One task = one session. Returns one row per turn."""
    rows = []
    sid = harness.create_session()
    turns = [("1", prompt_for(task))]
    if task["category"] == "multi-turn":
        turns = [("1", prompt_for(task)), ("2", task["turn2"]), ("3", task["turn3"])]
    replies = []
    try:
        for turn_no, text in turns:
            t0 = time.perf_counter()
            try:
                reply = harness.send(sid, text)
                ok = True
                note = ""
            except Exception as e:
                reply, ok, note = "", False, f"send failed: {type(e).__name__}: {e}"
            wall = round((time.perf_counter() - t0) * 1000)
            replies.append(reply)
            if task["category"] == "multi-turn":
                score, gnote = (0.0, "") if turn_no != "3" else grader.grade(task, reply)
            elif turn_no != turns[-1][0]:
                score, gnote = 0.0, ""  # only the final turn carries a grade
            else:
                score, gnote = grader.grade(task, reply)
            rows.append({
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "harness": harness.NAME, "model": model, "task_id": task["id"],
                "category": task["category"], "turn": int(turn_no),
                "ttfb_ms": None, "wall_ms": wall, "ok": ok,
                "score": score, "notes": "; ".join(x for x in (note, gnote) if x),
            })
            print(f"  {task['id']} t{turn_no}: ok={ok} score={score} {wall}ms", flush=True)
    finally:
        # code tasks: the reply's fenced block is graded from the transcript we already
        # captured; try to clean the session either way (both harnesses support DELETE).
        pass
    return rows


def measure_ttfb(harness, tasks: list[dict], rep: int) -> dict:
    """One streaming probe per rep — first reply byte on a fresh session."""
    probe = tasks[rep % len(tasks)]["prompt"][:120]
    try:
        return {"ttfb_ms": harness.stream_first_byte_ms(probe)}
    except Exception as e:
        return {"ttfb_ms": -1, "ttfb_err": f"{type(e).__name__}: {e}"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--harness", required=True, choices=sorted(REGISTRY))
    ap.add_argument("--model", default="glm-5.3-flash", help="model-config label for the ledger")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--tasks", default=None, help="comma-separated task ids (default: all)")
    ap.add_argument("--label", default=None, help="runs/<label>.jsonl (default: auto)")
    args = ap.parse_args()

    harness = REGISTRY[args.harness]()
    tasks = load_tasks(args.tasks.split(",") if args.tasks else None)
    label = args.label or f"{datetime.now().strftime('%Y%m%dT%H%M%S')}-{args.harness}-{args.model}"
    out = HERE / "runs" / f"{label}.jsonl"
    out.parent.mkdir(exist_ok=True)
    LEDGER.mkdir(parents=True, exist_ok=True)
    date = datetime.now().strftime("%Y-%m-%d")
    ledger = LEDGER / f"{date}-{args.harness}-{args.model}.jsonl"

    print(f"harness-bench: {args.reps} reps × {len(tasks)} tasks on {args.harness} ({args.model})")
    print(f"  rows  -> {out}\n  ledger-> {ledger}")
    n = 0
    with out.open("a") as f, ledger.open("a") as lg:  # append-only: working copy + ledger
        for rep in range(args.reps):
            print(f"-- rep {rep + 1}/{args.reps}")
            ttfb_probe = measure_ttfb(harness, tasks, rep)
            for task in tasks:
                rows = run_task(harness, task, args.model)
                # attach the rep's streaming TTFB to the task's final turn
                if rows:
                    rows[-1]["ttfb_ms"] = ttfb_probe["ttfb_ms"]
                    if "ttfb_err" in ttfb_probe:
                        rows[-1]["notes"] = (rows[-1]["notes"] +
                                             f"; ttfb: {ttfb_probe['ttfb_err']}").strip("; ")
                for r in rows:
                    line = json.dumps(r) + "\n"
                    f.write(line)
                    lg.write(line)  # the ledger row IS the row — one format, two homes
                f.flush()
                lg.flush()
                n += len(rows)
    print(f"done: {n} rows -> {out.name} (ledger appended)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
