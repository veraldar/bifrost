# VERSIONS — the self-improving loop

The cycle (per version): **(1)** run the matrix (`ygg-sim cycle`) → **(2)**
validate (green, or green-except-documented) → **(3)** mine findings + failures
+ honest-limits into the next version's scope → **(4)** build vX+1 → **(5)**
commit + append here (`vX → findings → vX+1`) → **(6)** loop.

Rule: every vX+1 must measurably add coverage or fixes vs vX (new scenarios,
new profiles, new quality gates, or caught/fixed defects — counted, not vibes).
The matrix stays green (or green-except-documented) across cycles; a red matrix
stops the loop for a fix first.

---

## v1 — baseline (landed 10-04, commits 4625e53 + 8e0e8cf)

**State**: shaped wire (latency/jitter/loss/dup/reorder/bw-cap/blackout/rebind,
seeded, SDP-stripped — no bypass), SimClient (signaling + `app` channel + Opus
mic from real TTS), in-binary deterministic upstream mock (openai SSE+JSON,
roll-up, exact/slow/sleep/essay, failure injection), world spawning the REAL
yggdrasil + REAL bifrost-net bridge, runner board + reports.

**Matrix**: 17 scenarios · 15 pass · 1 break-as-documented (nat-rebind) ·
1 known-issue (bridge run.done starvation) · 0 FAIL · two full runs green
back-to-back · unit tests 8/8.

**Findings mined for v2** (from FINDINGS.md honest limits + v1 evidence):
1. The mock never calls tools → yggdrasil's **agent tool loop** (the core
   slice-6a surface: tool_calls over the wire, bash execution, tool parts in
   the transcript) has ZERO scenario coverage.
2. `FlowProfile.bps` exists but no scenario uses it → **bandwidth-starved
   links** (congested cell downlink) untested; the TTS burst under a capped
   pipe is exactly the fleet's worst network.
3. Voice quality gate is peak-amplitude only → weak; a real **STT∘TTS keyword
   gate** (transcribe what the client received) is what the fleet's own V9.3
   contract uses.
4. No **concurrency** scenario: yggdrasil's per-session run serialization and
   the busy map under parallel sessions are uncovered.
5. Cycle mechanics were manual: no command that runs + validates + diffs
   against the previous version's snapshot.

## v2 — proposal (mined from v1)

- NEW `rest.tool-loop`: mock gains streaming `delta.tool_calls` (index
  reassembly shape yggdrasil parses) + `tool:echo X` / `tool:twice X`
  directives → real bash tool executed by the real agent loop; assert the
  opencode-shaped tool part + `TOOL-FINAL` echo. **Coverage: +1 scenario,
  first tool-loop coverage.**
- NEW `rest.parallel-sessions`: 4 concurrent sessions/turns, distinct ids,
  all echo correctly, busy map drains. **Coverage: +1 scenario, concurrency.**
- NEW `bridge.bandwidth-starved`: congested-cell profile (64 kbps downlink
  cap + 5% loss) through a full hands-free round; data channel and lifecycle
  notices must survive the burst; delivery floor documented. **Coverage: +1
  scenario, first use of the bandwidth shaper.**
- QUALITY: voice rounds gain an STT∘TTS keyword gate (client transcribes its
  RECEIVED audio via speaches; handsfree gates ≥2 keywords, others record).
  **Fixes v1 finding 3.**
- LOOP: `ygg-sim cycle` — matrix + validate + diff vs the previous cycle
  snapshot (`report/cycle-N.json`). **Fixes v1 finding 5.**

Expected: matrix 17 → **20** scenarios, 0 FAIL, all v1 findings 1/3/5 closed
(2/4 stay: live mode stays out by design; anthropic dialect deferred).

## v2 — landed (10-04, this cycle)

**Cycle evidence** (`report/cycles/cycle-1.json`, seed 0xc0ffee):

```
MATRIX: 20 ran · 17 pass · 2 break-as-expected · 1 known-issue · 0 skip · 0 FAIL
CYCLE 1 VALID — green-except-documented
```

**Delivered vs proposal** — all five items:
- `rest.tool-loop` PASS — mock streams `delta.tool_calls` (args split across
  chunks, forcing reassembly); the real agent loop executed real bash;
  transcript carries 3 opencode-shaped tool parts with real outputs
  (`ygg-sim-v2`, `deep-1`, `deep-2`, state completed). One caught-in-build
  fix: the mock's loop-state detection had to be positional (a user message
  after the last tool message = fresh directive) — history from EARLIER tool
  loops poisoned the naive existence check.
- `rest.parallel-sessions` PASS — 4 concurrent sessions, distinct ids, all
  echoes correct, busy map drained, session list complete.
- `bridge.bandwidth-starved` BREAK-OK (documented) — first exercise of the
  bandwidth shaper: 64 kbps downlink + 5% loss → TTS burst delivers ~35%
  (unspaced burst misses the window even though paced opus would fit), but
  channel, lifecycle notices and post-burst recovery (ping < 5s) all hold.
  New capacity law on record: **the bridge has no pacing/BWE** — a candidate
  v3+ item for bifrost-net's lane, monitored here.
- STT∘TTS quality gate LIVE — handsfree transcribes its received audio and
  gates ≥2 keywords (**3/3 survived the full round trip**); poor-network
  recorded 2/3 on a lossy link. Fixes v1 finding 3.
- `ygg-sim cycle` — matrix + validate + diff vs previous snapshot; this file
  is the loop's ledger. Fixes v1 finding 5.

**Delta vs v1**: 17 → **20 scenarios** (+3), +1 profile (congested-cell), +1
quality gate (STT keywords), +1 loop command, 0 FAIL. v1 findings closed: 1, 3, 5.

**Mined for v3** (next cycle, in flight):
1. The bridge has no bandwidth adaptation (this cycle's BREAK-OK) — a pacing
   pass is bifrost-net's lane; until then, sim-side: a *paced-reference*
   scenario proving the SAME burst over the same pipe paced at 20ms delivers
   ~100% (isolates the bridge's write pattern as the cause, quantifies the
   gap).
2. anthropic upstream dialect still unsimulated (v1 finding 2, deferred).
3. Aborts during the tool loop (abort mid-tool-execution) — the fleet's
   "abort mid-stream" scar applied to the newly covered surface.
4. Determinism drift watch: cycle command could diff headline metrics
   (latencies) across cycles, not just verdicts — alarm on >2× drift.

---

## v3 — the sim contains the app (landed 10-04, this cycle)

**Order**: the simulation must CONTAIN the android app and EVOLVE WITH IT.

**Proposal (mined from v2 + the evolution order)**:
1. The Capacitor-wrapped app becomes a simulated client: an adb-backed
   `AppDriver` (local KVM host + the android-lab ssh-mac host), APK discovery
   (YGG_SIM_APK / the Capacitor output path), pairing per the real contract
   (raw token in the deep link / QR, bridge /offer as the gate), tunnel +
   `adb reverse` reachability, screencap/notification receipts.
2. Four native-shell scenarios: `app.install-pair` (install → deep-link pair →
   bridge accepts), `app.push-notification` (dumpsys notification),
   `app.background-audio` (screen off, TTS keeps flowing — needs a LOCAL
   emulator; ssh tunnels are TCP-only and cannot carry UDP media),
   `app.hot-reload` (remote-URL update reaching the installed shell).
   Until the wrap build lands (parallel lane), all four SKIP loudly, naming
   the exact missing piece — never fake.
3. THE EVOLUTION RULE, enforced in `cycle`: the ledger's latest
   `app-version pairing` line is checked BEFORE the matrix burns time; an app
   bump without a sim bump fails the cycle instantly. Cycle snapshots record
   app+sim versions.

**Delivered**:
- `src/app.rs` — AppDriver with both hosts probed live: local (this box,
  /dev/kvm → media-capable emulator possible) and ssh-mac (Mac Studio SDK,
  android-lab AVD found BOOTED); install / reverse / shell / deep-link /
  screencap / notification primitives per the android-lab topology.
- `scenarios/app.rs` — the 4 scenarios + the gate reporting precisely what is
  missing. Current run: 4 SKIP, each reading "wrap not built (parallel lane):
  no APK at pwa/android/.../app-debug.apk" — the ONLY missing piece; adb host
  and booted emulator are already live. Landing the wrap flips them without
  scenario rewrites.
- Evolution rule in `runner.rs::check_evolution_rule` — parses the pairing
  line below, fails the cycle on app-bump-without-sim-bump, stamps app+sim
  versions into every cycle snapshot.
- Sim version 0.1.0 → **0.3.0** (ledger version = cycle number).
- One self-caught fix during the cycle: `bridge.tts-paragraphs` went FAIL when
  STT heard TTS("essay please") as "F.A. please" — a homophone trap in MY
  fixture. Fixed properly: the spoken directive is now "long story please"
  (whisper-stable), the mock treats "long story"/"essay" as the same
  directive. The cycle's verdict-shift diff is what surfaced it.

**First pairing** (the ledger rule starts here):

app-version pairing: app 0.6.0 ↔ sim 0.3.0

**Mined for v4**: the wrap lane lands → flip app.* live on the booted AVD
(install+pair first, then push + hot-reload over the tunnel, background-audio
on a local emulator — UDP media needs it); plus v2 carryovers
(paced-reference, anthropic dialect, abort-mid-tool, metric-drift watch).
