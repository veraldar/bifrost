#!/usr/bin/env python3
"""Aggregate runs/results.tsv into the per-variant tables for the report."""
import json, os, sys
from collections import defaultdict

LAB = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(LAB, "runs", "results.tsv")
TRACE = os.path.join(LAB, "runs", "trace.jsonl")

rows = []
with open(RES) as f:
    header = f.readline().rstrip("\n").split("\t")
    for line in f:
        vals = line.rstrip("\n").split("\t")
        if len(vals) != len(header): continue
        rows.append(dict(zip(header, vals)))

VARIANTS = ["A", "B", "C"]
TASKS = ["t1-stale", "t2-drift-summary", "t3-typo", "t4-spawn-lab", "t5-refactor"]

def num(r, k): 
    try: return float(r[k])
    except (ValueError, KeyError): return 0.0

agg = defaultdict(lambda: defaultdict(list))
for r in rows:
    v = r["variant"]
    for k, cast in [("success", int), ("violations", int), ("wall_ms", int),
                    ("absorbed_bytes", int), ("steps", int), ("delegated", int)]:
        agg[v][k].append(cast(r[k]) if cast is int else num(r, k))
    agg[v]["rows"].append(r)

def mean(xs): return sum(xs) / len(xs) if xs else 0.0

print("== PER-VARIANT AGGREGATE (n=%d/variant) ==" % (len(rows) // 3))
print(f"{'variant':<8}{'success':>9}{'violations':>12}{'wall_ms':>10}{'absorbed_B':>12}{'steps':>7}{'deleg%':>8}")
for v in VARIANTS:
    a = agg[v]
    n = len(a.get("rows", []))
    if not n: continue
    print(f"{v:<8}{mean(a['success']):>8.0%}{int(sum(a['violations'])):>11} "
          f"{mean(a['wall_ms']):>9.0f}{mean(a['absorbed_bytes']):>11.0f}{mean(a['steps']):>7.1f}"
          f"{mean(a['delegated']):>7.0%}")

print("\n== TASK x VARIANT (success/violations, mean wall_ms, mean absorbed_B, deleg) ==")
for t in TASKS:
    line = [t.ljust(18)]
    for v in VARIANTS:
        rs = [r for r in agg[v].get("rows", []) if r["task"] == t]
        if not rs: line.append(f"{v}: -"); continue
        s = mean([int(r["success"]) for r in rs])
        viol = sum(int(r["violations"]) for r in rs)
        w = mean([int(r["wall_ms"]) for r in rs])
        ab = mean([int(r["absorbed_bytes"]) for r in rs])
        dg = mean([int(r["delegated"]) for r in rs])
        line.append(f"{v}: {s:.0%}/{viol}v {w:.0f}ms {ab:.0f}B d={dg:.0%}")
    print("  ".join(line))

print("\n== NOTES (verbatim) ==")
for r in rows:
    flag = " *" if (r["violations"] != "0" or r["success"] == "0") else ""
    print(f"{r['variant']} {r['task']} r{r['rep']}{flag}: {r['note']}")

# context growth per variant on the heavy task, from trace
try:
    heavy = defaultdict(list)
    with open(TRACE) as f:
        for line in f:
            d = json.loads(line)
            if d["tid"] == "t5-refactor":
                heavy[d["variant"]].append((sum(len(t[1]) for t in d.get("tools", [])),
                                            sum(len(o) for o in d.get("outputs_head", [])),
                                            len(d.get("reply", ""))))
    print("\n== T5 tool-arg/output bytes (context-bloat view) ==")
    for v in VARIANTS:
        if heavy[v]:
            print(f"{v}: turns={len(heavy[v])} tool_args_B≈{mean([x[0] for x in heavy[v]]):.0f} "
                  f"outputs_B(300-capped)≈{mean([x[1] for x in heavy[v]]):.0f} reply_B={mean([x[2] for x in heavy[v]]):.0f}")
except FileNotFoundError:
    pass
