# station-sim — tests the STATION, not the product

Every other sim feeds input to a component and checks its output. This one runs the chain that
runs them: `agi-run.sh` (lane + will + stub) → `watch-landings.sh` (ping / re-kick / escalate /
durable post) → brain → owner. Origin: `artifacts/silent-death-sim-gap.md` (opus autopsy 11-09).

    lab/station-sim/run.sh            # all 16 cases (~5 min; case 13 waits out the 120 s push cap)
    lab/station-sim/run.sh 4 8 12     # selected cases

**Rig law — all scratch.** `SIMDIR=/tmp/station-sim-r1/cNN` per case: own wills dir, status tsv
(+`.pending`), log dir, brain log. Mock brain on `127.0.0.1:140NN` (`mock/brain.py`: GET /session →
`[MAIN]`, POST logged with its HTTP code; `mode` file flips 503, the case stops/starts it for
"down"). Fake claude (`mock/claude`, via `AGI_BIN`; mode read from `$CD/mode.claude`:
sleep | write | fail). `AGI_SYSTEMD=0`, watcher run by hand with env overrides
(`BRAIN_URL/STATUS_FILE/WILL_DIR/POLL_SECS=2/WAKE_JSON`). The real `lane-watcher` unit, the real wills
dir, `/tmp/sub-status.tsv` and `/tmp/.lane-wake.json` are never touched. Every spawned process is a
`setsid` group recorded in `$CD/pids`; teardown TERM/KILLs the groups and asserts none survived.

**Invariant (every case, `lib.sh: assert_invariant`).** Exactly ONE owner-visible terminal signal
(a delivered 2xx `LANE LANDED` / `STATION PING` / `ESCALATION` post — duplicates count) within
2 polls (+ slack) of the fault; never zero; ≤ 1 re-kick per lane; afterwards no wills/markers and
no sim pids. Cases 5/6/9/12 count their own (multi-signal) expectations explicitly.

Cases: 1 dispatcher SIGKILL · 2 wrapper SIGTERM · 3 claude SIGKILL · 4 brain 503 on post ·
5 brain down 3 polls · 6 reboot sim · 7 two [MAIN] · 8 garbage status · 9 stale markers ·
10 relative `-a` · 11 unwritable artifact dir · 12 same-name lanes · 13 hung git push · 14 landing, MAIN idle (marker + one verdict event) · 15 landing, MAIN busy 40 s (one post; `WATCH_SCRIPT=` runs a pre-fix script) · 16 real yggdrasil binary: `[auto-verdict]` line.

Exit code ≠ 0 on any FAIL; the table lands in `$SIMDIR/rows.txt`. A case that cannot be
simulated is marked SKIP with the reason — never a faked PASS.
