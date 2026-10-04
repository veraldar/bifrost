#!/usr/bin/env python3
"""Watchdog-of-the-watchdog: wake the W2W session (stellar-planet) only when judgment is needed.

Wakes when:
  1. night builder dead AND no DAWN-REPORT.md  -> builder crashed, relaunch decision
  2. DAWN-REPORT.md exists AND not delivered   -> deliver report to user, retire cron
  3. heartbeat due (>=60 min) AND build window -> quiet chain check, one-line report

No wake outside the window, after the report is delivered, or after MAX_BUILDER_RESTARTS
auto-relaunches (then it wakes once and stops). Log/state: ~/.local/state/watchdog-watchdog/
"""
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:4096"
W2W_SESSION = "ses_efc36f2e5ffegLFSSrkkIvo565"  # stellar-planet MAIN WATCHDOG WATCHDOG
LAB = pathlib.Path.home() / "Work/bifrost/lab/yggdrasil"
DAWN = LAB / "DAWN-REPORT.md"
STATE = pathlib.Path.home() / ".local/state/watchdog-watchdog"
LOG = STATE / "log"
DELIVERED = STATE / "delivered"
LAST_WAKE = STATE / "last_wake"
RESTARTS = STATE / "builder_restarts"
WINDOW = (0, 10)  # active 00:00-10:59 local
HEARTBEAT_SEC = 3600
MAX_BUILDER_RESTARTS = 1

BUILDER_PATTERN = "run/night/prompt.md"


def log(msg):
    STATE.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(f"{time.strftime('%m-%d %H:%M:%S')} {msg}\n")
    print(msg)


def post_wake(text):
    req = urllib.request.Request(
        f"{BASE}/session/{W2W_SESSION}/message",
        data=json.dumps({"parts": [{"type": "text", "text": text}]}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def builder_alive():
    return subprocess.run(
        ["pgrep", "-f", BUILDER_PATTERN], capture_output=True
    ).returncode == 0


def builder_dead_since():
    stamp = STATE / "builder_down_since"
    if builder_alive():
        stamp.unlink(missing_ok=True)
        return None
    if not stamp.exists():
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(str(time.time()))
    return time.time() - float(stamp.read_text().strip() or 0)


def builder_restarts():
    return int(RESTARTS.read_text().strip() or 0) if RESTARTS.exists() else 0


def restart_builder():
    if builder_restarts() >= MAX_BUILDER_RESTARTS:
        return False
    subprocess.Popen(
        [
            "setsid", "nohup", "claude", "-p",
            "Read run/night/prompt.md and execute it fully. NOTE: a previous builder died mid-run; read git log + PLAN-NIGHT.md, resume from known state, do not redo finished milestones.",
            "--model", "opus", "--dangerously-skip-permissions",
            "--add-dir", str(pathlib.Path.home() / "Work/bifrost/edge"),
        ],
        cwd=LAB,
        stdout=open(LAB / "run/night/night-build.log", "ab"),
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    STATE.mkdir(parents=True, exist_ok=True)
    RESTARTS.write_text(str(builder_restarts() + 1))
    log(f"AUTO-RELAUNCH #{builder_restarts()}")
    return True


def wake(reason, extra=""):
    text = (
        f"W2W check ({reason}). Chain check, bottom-up, SHORT: "
        "1) fleet-watchdog timer alive (systemctl --user list-timers), "
        "2) MAIN session alive (GET /session/ses_f28e2fdf4ffeWng5LZZnYbCpnm -> time.updated), "
        f"3) night builder: process + commits since last check, "
        f"4) DAWN-REPORT.md exists -> deliver to user via PWA artifacts link, then RETIRE: "
        "crontab -l | grep -v watchdog-watchdog | crontab - and mark delivered."
    ) + (f" {extra}" if extra else "")
    try:
        post_wake(text)
        LAST_WAKE.parent.mkdir(parents=True, exist_ok=True)
        LAST_WAKE.write_text(str(time.time()))
        log(f"WAKE sent ({reason})")
    except Exception as e:
        log(f"WAKE FAILED {e}")


def main():
    now = time.time()
    if not (WINDOW[0] <= time.localtime().tm_hour <= WINDOW[1]):
        log("outside window; skip")
        return 0
    if DELIVERED.exists():
        log("dawn report delivered; cron should be retired; skip")
        return 0

    reason = None
    extra = ""
    dead = builder_dead_since()
    if dead is not None and dead > 300 and not DAWN.exists():
        reason = "BUILDER DOWN"
        if restart_builder():
            reason = None  # relaunched, re-evaluate next cycle
        else:
            extra = f"BLOCKED: builder died {int(dead)//60}m ago, auto-restart budget spent — decide manually."
    if reason is None and DAWN.exists():
        reason = "DAWN REPORT READY"
    if reason is None:
        last = float(LAST_WAKE.read_text().strip() or 0) if LAST_WAKE.exists() else 0
        if now - last >= HEARTBEAT_SEC:
            reason = f"heartbeat, builder={'alive' if builder_alive() else 'DOWN'}"
    if reason:
        wake(reason, extra)
    else:
        log("quiet; no wake")
    return 0


if __name__ == "__main__":
    sys.exit(main())
