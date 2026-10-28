#!/usr/bin/env python3
"""Live-safety watchdog for TOOL-SCOPE sim runs (10-28).

The lab key is the SAME key the live :4100 brain uses (checked by fingerprint), so scratch load
shares live's rate limit. Every 10 s: if any scratch root log gains a new upstream 429, or the
live root's journal shows a 429 since the watchdog started, kill the sim drivers and abort every
working session on the scratch roots (4121-4124). Never touches :4100 — it only reads its journal.
"""
from __future__ import annotations

import glob, json, os, signal, subprocess, time, urllib.request

LOGS = "/tmp/tool-scope-store/*.log"
PORTS = [4121, 4122, 4123, 4124]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs", "watchdog.log")
START = time.strftime("%Y-%m-%d %H:%M:%S")


def count_429() -> int:
    return sum(open(f, errors="replace").read().count(" 429 ") for f in glob.glob(LOGS))


def live_429() -> int:
    r = subprocess.run(["journalctl", "--user", "-u", "lk-yggdrasil", "--since", START, "--no-pager"],
                       capture_output=True, text=True)
    return r.stdout.count("429")


def drivers() -> list[int]:
    r = subprocess.run(["pgrep", "-f", "^python3 -u (tp_enforced|pressure|familiarity|edge_cases).py"],
                       capture_output=True, text=True)
    return [int(p) for p in r.stdout.split()]


def abort_all() -> int:
    n = 0
    for p in PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{p}/session/state", timeout=5) as r:
                states = json.load(r)
        except Exception:
            continue
        for sid, st in states.items():
            if st.get("type") == "working":
                req = urllib.request.Request(f"http://127.0.0.1:{p}/session/{sid}/abort", method="POST")
                try:
                    urllib.request.urlopen(req, timeout=5).read()
                    n += 1
                except Exception:
                    pass
    return n


def log(msg: str):
    with open(OUT, "a") as f:
        f.write(f"{time.strftime('%F %T')} {msg}\n")


def main():
    base = count_429()
    log(f"watchdog up; baseline scratch 429s={base}")
    while True:
        time.sleep(10)
        s, l = count_429(), live_429()
        if s > base or l > 0:
            pids = drivers()
            for pid in pids:
                os.kill(pid, signal.SIGTERM)
            n = abort_all()
            log(f"TRIPPED: scratch 429s {base}->{s}, live 429s {l}; killed drivers {pids}; aborted {n} sessions")
            return
        if not drivers() and not os.path.exists("/tmp/tool-scope-chain.running"):
            log("no drivers left; watchdog exits")
            return


if __name__ == "__main__":
    main()
