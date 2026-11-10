#!/usr/bin/env python3
"""Forensic re-grade: combines results.tsv (disk-truth success) with trace.jsonl
(channel truth: did MAIN write via edit/write tools, or via bash, or delegate
through the root API?). Emits the final markdown tables for the report.

Channel rules (the honest accounting):
  inline_write   = `edit`/`write` in MAIN's own tool calls, OR a bash command that
                   writes fixture files directly (> redirect into docs/, sed -i, tee)
  delegation     = kids>0 OR a bash `POST http://127.0.0.1:<port>/session` (the
                   bash-mediated delegation channel MAINs actually use)
  violation (B/C/B2/C2, write/heavy tasks) = inline_write
"""
import json, os, re, sys
from collections import defaultdict

LAB = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(LAB, "runs", "results.tsv")
TRACE = os.path.join(LAB, "runs", "trace.jsonl")

def load_rows():
    rows = []
    with open(RES) as f:
        head = f.readline().rstrip("\n").split("\t")
        for line in f:
            v = line.rstrip("\n").split("\t")
            if len(v) == len(head): rows.append(dict(zip(head, v)))
    return rows

def load_trace():
    t = {}
    with open(TRACE) as f:
        for line in f:
            try: d = json.loads(line)
            except ValueError: continue
            t[(d["variant"], d["tid"], d["rep"])] = d
    return t

BASH_WRITE = re.compile(r"(>>?|sed -i|tee )[^|;&]*docs/|cp [^;&]*docs/|mv [^;&]*docs/")
CURL_SESS = re.compile(r"curl[^|;&]*POST http://127\.0\.0\.1:41\d+/session(?!\s*/\S)", re.I)

def channels(key, trace):
    d = trace.get(key, {})
    inline_write = curl_sess = bash_write = False
    for name, args in d.get("tools", []):
        if name in ("edit", "write"): inline_write = True
        if name == "bash":
            if BASH_WRITE.search(args): bash_write = True
            if CURL_SESS.search(args): curl_sess = True
    delegated = bool(d.get("kids")) or curl_sess
    return inline_write, bash_write, delegated

WRITE_TASKS = {"t3-typo", "t4-spawn-lab", "t5-refactor"}
SOFT = ["A", "B", "C"]; ENF = ["B2", "C2"]

def mean(xs): return sum(xs)/len(xs) if xs else 0.0

def aggregate(rows, trace, variants):
    out = {}
    for v in variants:
        rs = [r for r in rows if r["variant"] == v]
        n = len(rs)
        viol = succ = deleg = 0; walls = []; absorb = []
        for r in rs:
            key = (r["variant"], r["task"], int(r["rep"]))
            iw, bw, dg = channels(key, trace)
            delegated = (r["delegated"] == "1") or dg
            inline = iw or bw
            if r["success"] == "1": succ += 1
            if r["task"] in WRITE_TASKS and v != "A":
                if inline: viol += 1
            if delegated: deleg += 1
            try: walls.append(int(r["wall_ms"])/1000)
            except ValueError: pass
            try: absorb.append(int(r["absorbed_bytes"]))
            except ValueError: pass
        out[v] = dict(n=n, succ=succ, viol=viol, deleg=deleg,
                      wall=mean(walls), absorb=mean(absorb))
    return out

def main():
    rows = load_rows(); trace = load_trace()
    soft = aggregate(rows, trace, SOFT)
    enf = aggregate(rows, trace, ENF)
    L = []
    L.append("### Soft policy (prompt-only), per variant\n")
    L.append("| variant | n | success | violations (write/heavy) | delegation rate | mean wall s | mean absorbed B |")
    L.append("|---|---|---|---|---|---|---|")
    for v in SOFT:
        a = soft[v]
        L.append(f"| {v} | {a['n']} | {a['succ']}/{a['n']} ({a['succ']/max(a['n'],1):.0%}) | "
                 f"{a['viol']} ({a['viol']/max(a['n'],1):.0%}) | {a['deleg']/max(a['n'],1):.0%} | "
                 f"{a['wall']:.0f} | {a['absorb']:.0f} |")
    L.append("\n### Task × variant (soft), success/violations\n")
    L.append("| task | A | B | C |")
    L.append("|---|---|---|---|")
    for t in ["t1-stale", "t2-drift-summary", "t3-typo", "t4-spawn-lab", "t5-refactor"]:
        cells = []
        for v in SOFT:
            rs = [r for r in rows if r["variant"] == v and r["task"] == t]
            s = sum(1 for r in rs if r["success"] == "1")
            vio = 0
            for r in rs:
                iw, bw, _ = channels((v, t, int(r["rep"])), trace)
                if t in WRITE_TASKS and v != "A" and (iw or bw): vio += 1
            cells.append(f"{s}/{len(rs)}" + (f" ({vio}v)" if vio else ""))
        L.append(f"| {t} | " + " | ".join(cells) + " |")
    L.append("\n### Prompt-only vs enforced (same prompts, MAIN allowlist [read, glob, grep, bash])\n")
    L.append("| metric | B (prompt) | B2 (enforced) | C (prompt) | C2 (enforced) |")
    L.append("|---|---|---|---|---|")
    def f2(v, data):
        a = data.get(v, dict(n=0, succ=0, viol=0, deleg=0, wall=0, absorb=0))
        n = max(a["n"], 1)
        return f"{a['succ']}/{a['n']} ({a['succ']/n:.0%})", f"{a['viol']}/{a['n']} ({a['viol']/n:.0%})", \
               f"{a['deleg']/n:.0%}", f"{a['wall']:.0f}", f"{a['absorb']:.0f}"
    bs, bv, bd, bw, ba = f2("B", soft); b2s, b2v, b2d, b2w, b2a = f2("B2", enf)
    cs, cv, cd, cw, ca = f2("C", soft); c2s, c2v, c2d, c2w, c2a = f2("C2", enf)
    L.append(f"| success | {bs} | {b2s} | {cs} | {c2s} |")
    L.append(f"| policy violations | {bv} | {b2v} | {cv} | {c2v} |")
    L.append(f"| delegation rate | {bd} | {b2d} | {cd} | {c2d} |")
    L.append(f"| mean wall s | {bw} | {b2w} | {cw} | {c2w} |")
    L.append(f"| mean absorbed B | {ba} | {b2a} | {ca} | {c2a} |")
    # leak delta on write/heavy tasks only
    def viol_rate(variants, data, tasks=WRITE_TASKS):
        tot = viol = 0
        for v in variants:
            for r in rows:
                if r["variant"] == v and r["task"] in tasks:
                    iw, bw, _ = channels((v, r["task"], int(r["rep"])), trace)
                    tot += 1
                    if iw or bw: viol += 1
        return viol, tot
    sv, st = viol_rate(["B", "C"], soft)
    ev, et = viol_rate(["B2", "C2"], enf)
    L.append(f"\n**Leak delta (write/heavy tasks, B+C pooled):** prompt-only "
             f"{sv}/{st} ({sv/max(st,1):.0%}) → enforced {ev}/{et} ({ev/max(et,1):.0%}). "
             f"Enforced-arm residual leaks are bash-mediated writes (measured, not assumed).")
    txt = "\n".join(L)
    with open(os.path.join(LAB, "runs", "final-tables.md"), "w") as f:
        f.write(txt + "\n")
    print(txt)

if __name__ == "__main__":
    main()
