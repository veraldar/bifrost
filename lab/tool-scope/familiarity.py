#!/usr/bin/env python3
"""TOOL-SCOPE V4 — surface-familiarity probe, first data point for that [LAB].

One mutation: profile `renamed-shell` exposes `bash` as `shell` (same schema, same description,
same permissions). Five voice-shaped tasks that NEED a shell (a short spoken answer about this
machine), each run under `build` (control) and `renamed-shell`, REPS times, on scratch root :4124.

Per turn: shell calls made under the exposed name, calls to the canonical name the profile hid
(`bash` under renamed-shell = "unknown tool" = the familiarity miss), first-call-correct, answered
from real output (reply contains a fact only the tool can know), word cap, wall.
Usage: familiarity.py [reps]  -> runs/familiarity.jsonl + a summary table on stdout
"""
from __future__ import annotations

import json, os, re, socket, subprocess, sys, time, urllib.request

PORT = 4124
BASE = f"http://127.0.0.1:{PORT}"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "runs", "familiarity.jsonl")
REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 2

PROJ = "/tmp/tool-scope-proj/edge"
TASKS = [
    ("date", "Check this machine's current date and tell me the weekday. At most 12 words.", 12,
     lambda: time.strftime("%A")),
    ("count", "How many entries are in the current directory? Check, then answer in at most 10 words.", 10,
     lambda: str(len(os.listdir(PROJ)))),
    ("host", "What is this machine's hostname? Look it up and answer in at most 8 words.", 8,
     lambda: socket.gethostname()),
    ("python", "Which python3 version is installed here? Check, then answer in at most 12 words.", 12,
     lambda: subprocess.run(["python3", "--version"], capture_output=True, text=True).stdout.split()[-1]),
    ("kernel", "Which Linux kernel release is this machine running? Check; at most 12 words.", 12,
     lambda: os.uname().release.split("-")[0]),
]


def http(method, path, body=None, timeout=600):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def turn(profile, tid, prompt, cap, truth):
    sid = http("POST", "/session", {"title": f"[LAB] surface-familiarity {profile} {tid}", "profile": profile})["id"]
    t0 = time.time()
    msg = http("POST", f"/session/{sid}/message", {"parts": [{"type": "text", "text": prompt}]})
    wall = round((time.time() - t0) * 1000)
    http("DELETE", f"/session/{sid}")
    parts = msg.get("parts", [])
    calls = [p["tool"] for p in parts if p.get("type") == "tool"]
    exposed = "shell" if profile == "renamed-shell" else "bash"
    hidden = "bash" if profile == "renamed-shell" else None
    reply = "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
    words = len(re.findall(r"\S+", reply))
    fact = truth()
    return {"profile": profile, "task": tid, "wall_ms": wall, "calls": calls,
            "shell_calls": calls.count(exposed), "hidden_name_calls": calls.count(hidden) if hidden else 0,
            "first_call_correct": bool(calls) and calls[0] == exposed, "grounded": fact.lower() in reply.lower(),
            "words": words, "within_cap": words <= cap, "reply": reply[:300], "truth": fact}


def main():
    os.makedirs(os.path.join(HERE, "runs"), exist_ok=True)
    os.makedirs(PROJ, exist_ok=True)
    rows = []
    for rep in range(1, REPS + 1):
        for tid, prompt, cap, truth in TASKS:
            for profile in ("build", "renamed-shell"):  # interleaved: same minute, same provider load
                r = turn(profile, tid, prompt, cap, truth)
                r["rep"] = rep
                rows.append(r)
                with open(OUT, "a") as f:
                    f.write(json.dumps({"ts": time.strftime("%FT%T"), **r}) + "\n")
                print(f"{profile:14} {tid:7} r{rep}: calls={r['calls']} grounded={r['grounded']} words={r['words']} "
                      f"wall={r['wall_ms']}ms :: {r['reply'][:90]!r}", flush=True)
    print("\n| profile | n | first call = exposed shell name | calls to hidden `bash` | grounded answer | within word cap | median wall s |")
    print("|---|---|---|---|---|---|---|")
    for profile in ("build", "renamed-shell"):
        rs = [r for r in rows if r["profile"] == profile]
        w = sorted(r["wall_ms"] for r in rs)
        print(f"| {profile} | {len(rs)} | {sum(r['first_call_correct'] for r in rs)}/{len(rs)} | "
              f"{sum(r['hidden_name_calls'] for r in rs)} | {sum(r['grounded'] for r in rs)}/{len(rs)} | "
              f"{sum(r['within_cap'] for r in rs)}/{len(rs)} | {w[len(w) // 2] / 1000:.1f} |")


if __name__ == "__main__":
    main()
