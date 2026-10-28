#!/usr/bin/env python3
"""TOOL-SCOPE V2 table: prompt-only arm (lab/tool-policy/runs, binary 412a9c4, 28 Oct 13:40-16:33,
partial: C/t5 never ran) vs enforced arm (runs/tp-enforced-{B,C}.tsv), both judged by the lab's
own grader AND the attributed detector from tp_enforced.py.

Prompt-only has no profile, so nothing is denied there: attempted == effective. Its orphan
delegations (a sub-session created without parentID) are reconstructed from MAIN's own bash
calls (a POST to /session with no parentID in the body) — an approximation, flagged as such.
Usage: reconstruct.py  -> prints the markdown tables, writes runs/v2-table.json
"""
from __future__ import annotations

import csv, json, os, re, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tp_enforced import is_write  # noqa: E402

TP = "/home/dweeb_xyz/Work/bifrost/lab/tool-policy/runs"
TASKS = ["t1-stale", "t2-drift-summary", "t3-typo", "t4-spawn-lab", "t5-refactor"]
CREATE = re.compile(r"-X\s*POST\s+\S*/session['\"]?(\s|$)")


def prompt_only():
    rows = {}
    for r in csv.DictReader(open(f"{TP}/results.tsv"), delimiter="\t"):
        rows[(r["variant"], r["task"], int(r["rep"]))] = r
    out = []
    for line in open(f"{TP}/trace.jsonl"):
        t = json.loads(line)
        if t["variant"] not in ("B", "C"):
            continue
        key = (t["variant"], t["tid"], t["rep"])
        r = rows.get(key, {})
        calls = [{"tool": n, "input": json.loads(a) if a else {}} for n, a in t.get("tools", [])]
        attempted = sum(1 for c in calls if is_write(c["tool"], c["input"]))
        orphan = any(c["tool"] == "bash" and CREATE.search(c["input"].get("command", "")) and "parentID" not in c["input"].get("command", "")
                     for c in calls)
        out.append({"arm": "prompt-only", "variant": t["variant"], "task": t["tid"], "rep": t["rep"],
                    "exc": bool(t.get("exception")), "success": int(r.get("success", 0) or 0),
                    "violations": int(r.get("violations", 0) or 0), "attempted": attempted, "effective": attempted,
                    "denied": 0, "delegated": int(bool(t.get("kids")) or orphan), "orphan": int(orphan),
                    "wall_ms": int(r.get("wall_ms", -1) or -1)})
    return out


def enforced():
    out = []
    for v in ("B", "C"):
        p = os.path.join(HERE, "runs", f"tp-enforced-{v}.tsv")
        if not os.path.exists(p):
            continue
        for r in csv.DictReader(open(p), delimiter="\t"):
            out.append({"arm": "enforced", "variant": v, "task": r["task"], "rep": int(r["rep"]),
                        "exc": r["note"].startswith("EXC"), "success": int(r["success"]), "violations": int(r["violations"]),
                        "attempted": int(r["attempted"]), "effective": int(r["effective"]), "denied": int(r["denied"]),
                        "delegated": int(r["delegated"]), "orphan": int(int(r["orphans"]) > 0), "wall_ms": int(r["wall_ms"])})
    return out


def table(rows):
    agg = defaultdict(lambda: defaultdict(int))
    walls = defaultdict(list)
    for r in rows:
        for k in (r["arm"], r["variant"], r["task"]), (r["arm"], r["variant"], "ALL"):
            a = agg[k]
            a["n"] += 1
            a["exc"] += r["exc"]
            for f in ("success", "violations", "attempted", "effective", "denied", "delegated", "orphan"):
                a[f] += r[f]
            a["turns_with_attempt"] += int(r["attempted"] > 0)
            a["turns_with_effective"] += int(r["effective"] > 0)
            if r["wall_ms"] > 0:
                walls[k].append(r["wall_ms"])
    lines = ["| variant | task | arm | n (exc) | success | lab-grader violations | turns w/ write attempt | turns w/ effective inline write | denials | delegated (orphans) | wall median s |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for v in ("B", "C"):
        for task in TASKS + ["ALL"]:
            for arm in ("prompt-only", "enforced"):
                a = agg.get((arm, v, task))
                if not a:
                    lines.append(f"| {v} | {task} | {arm} | 0 | — | — | — | — | — | — | — |")
                    continue
                w = sorted(walls[(arm, v, task)])
                med = f"{w[len(w) // 2] / 1000:.0f}" if w else "—"
                lines.append(f"| {v} | {task} | {arm} | {a['n']} ({a['exc']}) | {a['success']}/{a['n']} | {a['violations']} | "
                             f"{a['turns_with_attempt']} | {a['turns_with_effective']} | {a['denied']} | {a['delegated']} ({a['orphan']}) | {med} |")
    return "\n".join(lines), {f"{k[0]}|{k[1]}|{k[2]}": dict(v) for k, v in agg.items()}


if __name__ == "__main__":
    rows = prompt_only() + enforced()
    md, data = table(rows)
    print(md)
    json.dump({"rows": rows, "agg": data}, open(os.path.join(HERE, "runs", "v2-table.json"), "w"), indent=1)
