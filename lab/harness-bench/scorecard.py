#!/usr/bin/env python3
"""harness-bench scorecard — runs/*.jsonl (or ledger files) -> markdown tables.

  scorecard.py                          score every run file in runs/
  scorecard.py runs/x.jsonl             score one file
  scorecard.py --trend code             sparkline of code quality across ledger history
  scorecard.py --trend all              sparkline per category

Composite = mean of per-category means (equal weights v1; voice-brevity half-caps
already punish verbosity inside its score).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
LEDGER = Path.home() / ".local/share/bifrost/bench"


def load_rows(paths: list[Path]) -> list[dict]:
    rows = []
    for p in paths:
        for line in p.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    return rows


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    k = max(0, min(len(s) - 1, round(q * (len(s) - 1))))
    return s[k]


def fmt_ms(v) -> str:
    return "—" if v in (None, -1, 0) else f"{v:,.0f}"


def score_run(rows: list[dict], title: str) -> str:
    by_task = defaultdict(list)
    ttfb, wall, errs = [], [], 0
    for r in rows:
        if r["category"] == "multi-turn" and r.get("turn") != 3:
            continue  # grade lives on the final turn
        by_task[r["category"]].append(r["score"])
        if r.get("ttfb_ms") not in (None, -1):
            ttfb.append(r["ttfb_ms"])
        if r.get("wall_ms"):
            wall.append(r["wall_ms"])
        errs += 0 if r.get("ok") else 1
    turns = len(rows)
    lines = [f"### {title}\n", f"`{turns} turns · error rate {errs}/{turns}`\n",
             "| metric | value |", "|---|---|",
             f"| p50 ttfb | {fmt_ms(pct(ttfb, .5))} ms |",
             f"| p95 ttfb | {fmt_ms(pct(ttfb, .95))} ms |",
             f"| p50 wall | {fmt_ms(pct(wall, .5))} ms |",
             f"| p95 wall | {fmt_ms(pct(wall, .95))} ms |", "",
             "| category | mean score | n |", "|---|---|---|"]
    comps = []
    for cat in ("code", "extraction", "voice-brevity", "multi-turn"):
        if by_task.get(cat):
            m = statistics.mean(by_task[cat])
            comps.append(m)
            lines.append(f"| {cat} | {m:.2f} | {len(by_task[cat])} |")
    comp = statistics.mean(comps) if comps else 0.0
    lines += ["", f"**composite: {comp:.2f}**\n"]
    # per-task detail
    task_scores = defaultdict(list)
    for r in rows:
        if r["category"] == "multi-turn" and r.get("turn") != 3:
            continue
        task_scores[r["task_id"]].append(r["score"])
    lines += ["| task | mean | n |", "|---|---|---|"]
    for tid in sorted(task_scores):
        lines.append(f"| {tid} | {statistics.mean(task_scores[tid]):.2f} | "
                     f"{len(task_scores[tid])} |")
    return "\n".join(lines) + "\n"


def spark(vals: list[float]) -> str:
    """Plain-text sparkline, 8 levels; values already sorted by time."""
    blocks = "▁▂▃▄▅▆▇█"
    if not vals:
        return "(no data)"
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return blocks[3] * len(vals)
    return "".join(blocks[min(7, int((v - lo) / (hi - lo) * 7.999))] for v in vals)


def trend(category: str) -> str:
    """Per category across the append-only ledger, chronological."""
    out = [f"## trend — {category} quality across ledger history\n",
           "| ledger file | spark | first→last | mean |", "|---|---|---|---|"]
    files = sorted(LEDGER.glob("*.jsonl")) if LEDGER.is_dir() else []
    if not files:
        return "(ledger empty — run runner.py first)\n"
    any_rows = False
    for p in files:
        rows = []
        for line in p.read_text().splitlines():
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("category") == category and not (
                    category == "multi-turn" and r.get("turn") != 3):
                rows.append(r)
        if not rows:
            continue
        any_rows = True
        vals = [r["score"] for r in rows]
        out.append(f"| `{p.name}` | {spark(vals)} | {vals[0]:.2f}→{vals[-1]:.2f} | "
                   f"{statistics.mean(vals):.2f} |")
    if not any_rows:
        out.append(f"| (no rows for {category}) | — | — | — |")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="run jsonl files (default: runs/*.jsonl)")
    ap.add_argument("--trend", default=None, help="category or 'all'")
    args = ap.parse_args()

    if args.trend:
        cats = ("code", "extraction", "voice-brevity", "multi-turn") \
            if args.trend == "all" else [args.trend]
        print("\n".join(trend(c) for c in cats))
        return 0

    paths = [Path(f) for f in args.files] or sorted(HERE.glob("runs/*.jsonl"))
    rows = load_rows(paths)
    if not rows:
        print("no rows found — run runner.py first", file=sys.stderr)
        return 1
    # one card per (harness, model); all files merged
    groups = defaultdict(list)
    for r in rows:
        groups[(r["harness"], r["model"])].append(r)
    cards = []
    for (h, m), rs in sorted(groups.items()):
        cards.append(score_run(rs, f"{h} × {m}"))
    print("\n---\n".join(cards))
    return 0


if __name__ == "__main__":
    sys.exit(main())
