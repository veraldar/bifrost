#!/usr/bin/env python3
"""Fleet watchdog: detect dead turns (finish=None + stale) in opencode sessions and nudge them back to life.

Reads SESSIONS list below. Nudge = POST a short resume prompt. Anti-storm: min 15 min between nudges per session.
Log: ~/.local/state/fleet-watchdog/log
"""
import json
import pathlib
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:4096"
SESSIONS = ["ses_f28e2fdf4ffeWng5LZZnYbCpnm"]  # MAIN veraldar; add more session ids here
STALE_SEC = 600
MIN_NUDGE_GAP = 900
STATE = pathlib.Path.home() / ".local/state/fleet-watchdog"
LOG = STATE / "log"

NUDGE = (
    "Watchdog revive: your turn died (finish={fin}, {mins} min silent). "
    "Resume from known state - no re-sweeps, answer-first, short. "
    "Continue standing orders; report one line per lane done or blocked."
)


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def log(msg):
    STATE.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(f"{time.strftime('%m-%d %H:%M:%S')} {msg}\n")
    print(msg)


def main():
    now = time.time()
    for sid in SESSIONS:
        try:
            sess = get(f"{BASE}/session/{sid}")
            msgs = sorted(get(f"{BASE}/session/{sid}/message?limit=3"), key=lambda m: m["info"]["time"]["created"])
        except Exception as e:
            log(f"{sid} ERROR {e}")
            continue
        updated = sess.get("time", {}).get("updated", 0) / 1000
        stale = now - updated > STALE_SEC
        if not msgs:
            continue
        last = msgs[-1]["info"]
        role, fin = last["role"], last.get("finish")
        mid_turn = role == "assistant" and fin in (None, "unknown", "tool-calls")
        stuck_queue = role == "user" and not any(m["info"]["role"] == "assistant" and m["info"]["time"]["created"] > last["time"]["created"] for m in msgs)
        if not stale or not (mid_turn or stuck_queue):
            continue
        stamp = STATE / f"nudged_{sid}"
        if stamp.exists() and now - float(stamp.read_text().strip() or 0) < MIN_NUDGE_GAP:
            log(f"{sid} dead but nudged <{MIN_NUDGE_GAP // 60}m ago; skip")
            continue
        text = NUDGE.format(fin=fin, mins=int((now - last["time"]["created"]) / 60))
        try:
            post(f"{BASE}/session/{sid}/message", {"parts": [{"type": "text", "text": text}]})
            STATE.mkdir(parents=True, exist_ok=True)
            stamp.write_text(str(now))
            log(f"{sid} NUDGED role={role} fin={fin} stale={int(now - updated)}s")
        except Exception as e:
            log(f"{sid} NUDGE FAILED {e}")


if __name__ == "__main__":
    sys.exit(main())
