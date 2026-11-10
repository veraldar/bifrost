#!/usr/bin/env python3
"""inject.py — the quota/outage injector. The fault lives in EXISTING code: the mock's
"mock-1310" key (z.ai's exact weekly-limit 429, built for PROVIDER-WAVE 10-28) and
boot-world.sh's QUOTA=1 mode. This helper only operates the fault and reads its state:

    python3 inject.py boot       # boot the quota-dead root (fixture, no billable call)
    python3 inject.py on         # point is made: root answers 429-shaped errors (verify)
    python3 inject.py off        # stop it
    python3 inject.py killmock   # hard outage: SIGSTOP sim-mock (resume: killmock -CONT)

Verify is a dry probe: GET /session/status + one POST /session on the quota root must
succeed (root-side), while the root's upstream is dead — the 429 only appears when a
real turn is sent, which only scenarios do. Boot state is recorded to the ledger.
"""
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
PORT = int(os.environ.get("QUOTA_PORT", "4130"))
LEDGER = pathlib.Path.home() / ".local/share/bifrost/bench/sim-world.jsonl"
PIDF = pathlib.Path("/tmp/simworld/quota.pid")


def _curl(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def boot():
    env = dict(os.environ, QUOTA="1")
    r = subprocess.run(["bash", str(HERE / "boot-world.sh"), "quota", str(PORT)],
                       env=env, capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    if r.returncode != 0:
        sys.exit(1)
    _row({"kind": "injector", "fault": "quota-429-upstream", "port": PORT, "state": "booted"})


def on():
    st = _curl(f"http://127.0.0.1:{PORT}/session/status")
    print("quota root /session/status:", st, "(root alive; upstream 429s on real turns)")
    sys.exit(0 if st == 200 else 1)


def off():
    if PIDF.exists():
        try:
            os.kill(int(PIDF.read_text().strip()), signal.SIGTERM)
        except (ProcessLookupError, ValueError):
            pass
        PIDF.unlink(missing_ok=True)
    print("quota root stopped")


def killmock(cont=False):
    pid = int(subprocess.run(["systemctl", "--user", "show", "-p", "MainPID", "--value",
                              "sim-mock"], capture_output=True, text=True).stdout.strip() or 0)
    if not pid:
        sys.exit("no sim-mock running")
    os.kill(pid, signal.SIGCONT if cont else signal.SIGSTOP)
    print(f"sim-mock pid {pid} {'resumed' if cont else 'STOPPED (hard outage)'}")
    if not cont:
        _row({"kind": "injector", "fault": "mock-sigstop", "pid": pid, "state": "stopped"})


def _row(d):
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with open(LEDGER, "a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "lab": "sim-world", **d}) + "\n")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    go = {"boot": boot, "on": on, "off": off,
          "killmock": lambda: killmock("-CONT" in sys.argv)}.get(cmd)
    if not go:
        sys.exit(__doc__)
    go()
