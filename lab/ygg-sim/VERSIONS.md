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
