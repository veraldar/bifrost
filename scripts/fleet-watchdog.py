#!/usr/bin/env python3
"""Fleet watchdog: keep lab sessions moving. Three behaviors, cheapest first.

1. REVIVE — turn died mid-flight (finish=None/unknown/tool-calls, or user msg
   unanswered) and the session went stale: nudge it back to life.
2. QUIET-INCOMPLETE — last assistant turn is DONE (finish="stop") but the
   session is an ACTIVE LAB (registry ~/.fleet-labs if present, else the
   known-labs list below) and has been quiet > QUIET_SEC: ONE driver-cadence
   continuation nudge ("continue the current milestone, one line").
   One nudge per quiet episode; new activity resets the episode.
3. ESCALATE-AFTER-3 — nudges per session are counted (state file, reset on
   observed progress). A session nudged 3+ times without progress is
   ESCALATED once: a summary goes to the PRODUCT session, then the session is
   left for the human. No further nudges.

Anti-storm: min MIN_NUDGE_GAP between nudges per session.
Log/state: ~/.local/state/fleet-watchdog/
Sim/testing: WATCHDOG_BASE env moves the API target; WATCHDOG_STALE_SEC /
WATCHDOG_QUIET_SEC / WATCHDOG_MIN_GAP override cadences.
"""
import json
import os
import pathlib
import sys
import time
import urllib.request

BASE = os.environ.get("WATCHDOG_BASE", "http://127.0.0.1:4096")
PRODUCT = "ses_f28e2fdf4ffeWng5LZZnYbCpnm"  # [MAIN] Veraldar — escalation target
SESSIONS = [PRODUCT]  # always watched; active labs come from the registry below
STALE_SEC = int(os.environ.get("WATCHDOG_STALE_SEC", "600"))
QUIET_SEC = int(os.environ.get("WATCHDOG_QUIET_SEC", "1800"))
MIN_NUDGE_GAP = int(os.environ.get("WATCHDOG_MIN_GAP", "900"))
ESCALATE_AFTER = 3
STATE = pathlib.Path(os.environ.get("WATCHDOG_STATE", str(pathlib.Path.home() / ".local/state/fleet-watchdog")))
LOG = STATE / "log"
LABS_FILE = pathlib.Path.home() / ".fleet-labs"  # one sid (+optional name) per line

# Fallback registry when ~/.fleet-labs does not exist (ids verified against the
# live server 10-04). Registry file, when present, replaces this list.
KNOWN_LABS = [
    ("ses_f03a724f2ffeyFB06o8QEPjo5t", "yggdrasil"),
    ("ses_efd433c93ffe9CKvwt4Ncaqtn8", "bifrost-net"),
    ("ses_efe8e0d2fffeSwH0TVeMFuFXWC", "worldtree-data"),
    ("ses_efca0aedaffesonQDSfSxWJlrj", "ask-agi-errors"),
    ("ses_f0d1fd3c6ffeMteiRSFbRug4b7", "hardwar"),
    ("ses_ef9fe1346ffeNV7k4TegXy7eyw", "agi-metrics"),
]

REVIVE_NUDGE = (
    "Watchdog revive: your turn died (finish={fin}, {mins} min silent). "
    "Resume from known state - no re-sweeps, answer-first, short. "
    "Continue standing orders; report one line per lane done or blocked."
)
QUIET_NUDGE = (
    "Driver cadence: {mins} min quiet after a finished turn. "
    "Continue the current milestone - one line: what you did, what is next."
)
ESCALATION = (
    "[fleet-watchdog] ESCALATION: session {sid} ({name}) was nudged {n} times "
    "(first {first}, span {span} min) without any progress; last turn "
    "finish={fin}, quiet {mins} min. Repeated failure - left for the human. "
    "Next step needs a person: check the session, re-cut the mission or stop it."
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


def stamp(sid, kind, value=None):
    p = STATE / f"{kind}_{sid}"
    if value is None:
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(value))
    return p


def labs():
    """Active-lab registry: ~/.fleet-labs if present, else the known-labs list."""
    if LABS_FILE.exists():
        out = {}
        for line in LABS_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            out[parts[0]] = parts[1] if len(parts) > 1 else "unnamed-lab"
        return out
    return dict(KNOWN_LABS)


def read_counter(sid):
    p = stamp(sid, "revives")
    if not p.exists():
        return 0, 0.0
    n, _, ts = p.read_text().strip().partition(" ")
    return int(n or 0), float(ts or 0)


def bump_counter(sid):
    n, _ = read_counter(sid)
    stamp(sid, "revives", f"{n + 1} {time.time()}")
    return n + 1


def reset_counter(sid):
    stamp(sid, "revives", "0 0")


def send_nudge(sid, text, kind):
    post(f"{BASE}/session/{sid}/message", {"parts": [{"type": "text", "text": text}]})
    stamp(sid, "nudged", time.time())
    count = bump_counter(sid)
    log(f"{sid} {kind} (nudge #{count})")
    return count


def escalate(sid, name, fin, quiet_mins):
    n, first = read_counter(sid)
    text = ESCALATION.format(
        sid=sid, name=name, n=n, first=time.strftime("%m-%d %H:%M", time.localtime(first)),
        span=int((time.time() - first) / 60), fin=fin, mins=quiet_mins,
    )
    try:
        post(f"{BASE}/session/{PRODUCT}/message", {"parts": [{"type": "text", "text": text}]})
        log(f"{sid} ESCALATED to PRODUCT after {n} nudges; left for human")
    except Exception as e:
        log(f"{sid} ESCALATION FAILED {e}")
    stamp(sid, "escalated", time.time())


def process(sid, name, now):
    try:
        sess = get(f"{BASE}/session/{sid}")
        msgs = sorted(get(f"{BASE}/session/{sid}/message?limit=3"), key=lambda m: m["info"]["time"]["created"])
    except Exception as e:
        log(f"{sid} ERROR {e}")
        return
    if not msgs:
        return
    updated = sess.get("time", {}).get("updated", 0) / 1000
    last = msgs[-1]["info"]
    role, fin = last["role"], last.get("finish")
    created = last["time"]["created"] / 1000  # opencode message times are ms
    stale = now - updated > STALE_SEC

    # progress since the last nudge clears the revive debt
    n, last_ts = read_counter(sid)
    if n and last_ts and updated > last_ts:
        reset_counter(sid)
        stamp(sid, "quiet_nudged", 0)
        n = 0
        log(f"{sid} progress observed; revive counter reset")

    if stamp(sid, "escalated").exists():
        log(f"{sid} escalated earlier; left for human; skip")
        return

    mid_turn = role == "assistant" and fin in (None, "unknown", "tool-calls")
    stuck_queue = role == "user" and not any(
        m["info"]["role"] == "assistant" and m["info"]["time"]["created"] > last["time"]["created"] for m in msgs
    )
    done_quiet = (
        role == "assistant" and fin == "stop"
        and (now - created) > QUIET_SEC and sid in labs()
    )
    if not (stale and (mid_turn or stuck_queue)) and not done_quiet:
        return

    quiet_mins = int((now - created) / 60)
    if n >= ESCALATE_AFTER:
        escalate(sid, name, fin, quiet_mins)
        return

    gap_ok = not stamp(sid, "nudged").exists() or now - float(stamp(sid, "nudged").read_text().strip() or 0) >= MIN_NUDGE_GAP
    if not gap_ok:
        log(f"{sid} needs nudge but nudged <{MIN_NUDGE_GAP // 60}m ago; skip")
        return

    try:
        if mid_turn or stuck_queue:
            send_nudge(sid, REVIVE_NUDGE.format(fin=fin, mins=quiet_mins), f"REVIVED role={role} fin={fin} stale={int(now - updated)}s")
        else:
            ep = stamp(sid, "quiet_nudged")
            if ep.exists() and float(ep.read_text().strip() or 0) >= created:
                log(f"{sid} quiet but already nudged this episode; skip")
                return
            ep.write_text(str(created))
            send_nudge(sid, QUIET_NUDGE.format(mins=quiet_mins), f"QUIET-NUDGED fin=stop quiet={quiet_mins}m")
    except Exception as e:
        log(f"{sid} NUDGE FAILED {e}")


def main():
    now = time.time()
    registry = labs()
    watched = [(sid, registry.get(sid, "PRODUCT" if sid == PRODUCT else "unnamed")) for sid in dict.fromkeys(SESSIONS + list(registry))]
    for sid, name in watched:
        process(sid, name, now)
    return 0


if __name__ == "__main__":
    sys.exit(main())
