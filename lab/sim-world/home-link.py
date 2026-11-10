#!/usr/bin/env python3
"""home-link.py — sim-world's single-home law link to [LAB] Veraldar (opencode :4096).

The owner's addendum (10-30): the sim's long-running home is the EXISTING session
ses_f28e2fdf4ffeWng5LZZnYbCpnm — proxy it, never copy or rebuild. The relay
(ygg-relay, proxy-sessions plan §3) is NOT built yet (build gate = its 8-flow
kill-test), so today's link is a REGISTRATION message: one write to the home root
that records where this lab's live state lives. No backfill, no history copy.

When the relay lands, this script is the only thing that changes: it mints the
proxy handle on the new root (info.proxy shape, plan §2b) instead of writing the
registration message. The home stays :4096 either way.
"""
import json
import pathlib
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:4096"
HOME_SID = "ses_f28e2fdf4ffeWng5LZZnYbCpnm"  # [LAB] Veraldar
REPORT = pathlib.Path.home() / ("Work/bifrost-sandbox/pwa/artifacts/sim-world-report.md")
LEDGER = "~/.local/share/bifrost/bench/sim-world.jsonl"

MSG = f"""[sim-world home-link @ {time.strftime('%Y-%m-%d %H:%M')}] (lab SIM-WORLD, req MAIN async mission)

[LAB] sim-world registered — tier-3 simulation as standing infrastructure (canon: bifrost/docs/TESTING.md, 10-30).

- lab home: `{HOME_SID}` on :4096 (this session; single-home law — no copy was made, no twin exists)
- world spine REUSED: sim-stack.sh (sim-pwa :8096, sim-ygg :4111, sim-mock :18190) — not rebuilt, per owner addendum
- personas extracted from: retrospective-1019 §5 (fake friend), tool-policy prompts (pushing user, engineer), harness-bench (batteries), gate.py (dispatch probe)
- scenarios: cold-visitor-onboarding@2, friend-deploys-trunk@1, quota-outage-during-use@1, proxy-session-tour@1, profiles-lifecycle@1
- runner/verdicts: lab/sim-world/runner.py — PASS / FINDINGS(n) / FAIL; ledger {LEDGER}
- report: bifrost-sandbox/pwa/artifacts/sim-world-report.md

NOTE: ygg-relay not built yet (proxy-sessions build gate pending); this message is the
link until then. When the relay lands, a proxy handle pointing HERE gets minted on the
new root and this registration becomes stale history, not a second home."""


def main():
    body = json.dumps({"parts": [{"type": "text", "text": MSG}]}).encode()
    req = urllib.request.Request(f"{BASE}/session/{HOME_SID}/message", data=body,
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            ok = r.status == 200
            raw = r.read()
    except urllib.error.HTTPError as e:
        ok, raw = False, str(e).encode()
    if not ok:
        print("home-link FAILED:", raw[:300]); sys.exit(1)
    # one cheap turn: the registration is the text, the reply is ack noise. Poke the
    # session so the message is persisted as a turn, then stop — no long generation.
    print(f"home-link OK: registration message persisted to {HOME_SID} on :4096")
    print("first 200 of reply:", raw[:200])


if __name__ == "__main__":
    main()
