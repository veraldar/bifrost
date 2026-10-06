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

---

## v4 — dialects, tool aborts, and the paced A/B (landed 10-06, commit 0def4c5)

**Proposal (mined from v3)**: paced-reference A/B for the bandwidth law;
anthropic dialect; abort-mid-tool; metric-drift watch in the cycle. (App.*
flip stayed pending — the wrap APK has not landed; app stays 0.6.0.)

**Delivered** (all four):
- `bridge.paced-uplink-starved` PASS — the A/B that closes the bandwidth-law
  analysis: same-class 64 kbps pipe, capped UPLINK, where the client paces at
  20ms/frame → the turn completes and the bridge HEARS the sentence (STT
  ground truth). Paired with v2's `bandwidth-starved` (35% unpaced burst):
  **the pipe fits paced audio; only the bridge's unpaced burst fails** — write
  pattern, not capacity. (Note: starved uplink stretches the turn to ~50s —
  the drip is real; recorded as the law's cost.)
- `rest.abort-mid-tool` PASS — a REAL slow tool (bash sleep 6) executing when
  abort lands: abort 4ms, busy map clears within ~2s (not the sleep's
  duration), session survives (post-abort turn echoes).
- `rest.anthropic-dialect` PASS — yggdrasil spawned with
  YGG_UPSTREAM_STYLE=anthropic against the mock's /v1/messages: block-SSE
  turns, exact echoes, a forced roll-up crossing IN the dialect
  (MOCK-SUMMARY landed), and a dialect counter proving the upstream really
  spoke anthropic (≥5 calls). Mock maps anthropic→OpenAI shape and reuses the
  same reply logic (the proven mock_upstream.py move) — equal histories, equal
  replies, two dialects.
- Metric-drift watch — cycle digest now flags same-scenario headline numbers
  moving >2× across cycles; first catch immediately: link-flap recovery
  1148ms → 136ms (one congested cycle-4 run; a signal to watch, not a bug).

**Cycle evidence** (`report/cycles/cycle-5.json`):

```
MATRIX: 27 ran · 20 pass · 2 break-as-expected · 1 known-issue · 4 skip · 0 FAIL
CYCLE 5 VALID — green-except-documented
```

**Delta vs v3**: 24 → **27 scenarios** (+3), +1 profile
(congested-uplink), +1 cycle digest (drift watch), 0 FAIL. One in-build fix:
the dialect marathon needed the roll-up threshold set (v3's marathon lesson,
re-applied).

app-version pairing: app 0.6.0 ↔ sim 0.4.0

**Mined for v5**:
1. Wrap lane lands → flip app.* live (standing order; only the APK is
   missing — adb host + booted AVD already found).
2. Tool loop over the BRIDGE data channel (prompt op + transcript polling +
   tool parts over WebRTC) — the two covered surfaces combined.
3. SLO budgets on the board: explicit per-scenario latency budgets (turn ≤ Ns,
   ping ≤ Nms) so "green" means "within budget", not just "finished".
4. Bifrost-net's lane (not sim): the run.done starvation KNOWN and the no-BWE
   law both have fixes queued upstream — the sim flips their verdicts the
   moment those land.

> Ledger repair (v5): this v4 section was written to a stray untracked
> `~/Work/bifrost/VERSIONS.md` instead of this file, so the evolution rule
> kept reading the v3 pairing (`sim 0.3.0`). Restored here verbatim; the
> stray copy is left for its owner to delete.


---

## v5 — the app lands, the mic question answered, budgets, STT in-process (landed 10-06)

**Proposal (mined from v4 + the 10-06 order "evolution of simulations + an
Android app with more control on bifrost-net")**, in priority order:
1. `app.chrome-mic-origin`: does Android Chrome open the mic on
   https :8443 (the user's "a port kills the mic" claim)?
2. The wrap APK lands, so the 4 `app.*` scenarios flip from SKIP to live.
3. Tool loop over the bridge data channel, plus SLO budgets per scenario.
4. STT in-process (inside the voice edge, not a service): a lane that
   anticipates the decision.

**Delivered** (all four):
- **Toolchain without root**: `pwa/android/setup-sdk.sh` installs JDK 21,
  the SDK, the android-36 google_apis x86_64 image and the AVD `ygg-sim`,
  all in user space. This box has /dev/kvm, so the sim boots its OWN
  headless AVD as a child (cold boot about 60 s) and shuts it down with
  `adb emu kill` at the end of the matrix. The Mac's sshd refused
  connections this cycle, so the local host replaced the ssh-mac lane.
- **`app.chrome-mic-origin` PASS**: Chrome 133 / Android 16, real prompt
  tapped through uiautomator, no fake-UI flag. A https:443 and B
  https:8443 are both secure contexts, and gUM returns a live track. The
  prompt reads "<host>:8443 wants to use your microphone". C (plain http
  on a non-loopback address) has `navigator.mediaDevices` undefined and no
  prompt. D (http://localhost) is a secure context. B's permission started
  at `prompt` after A was granted: per origin, port included. Verdict: **a
  port does not kill the mic on Android Chrome; plain http does.**
- **The wrap APK**: `pwa/android`, a WebView shell hand-built with no
  Gradle (aapt2/javac/d8/apksigner, 21 KB). It holds RECORD_AUDIO, grants
  the paired origin only, pairs via deep link (native verify against the
  bridge `/offer`), uses the PWA's localStorage token contract, and adds
  `BifrostNative.notify`. All 4 `app.*` scenarios now run live:
  install-pair PASS, hot-reload PASS, push-notification BREAK-OK (WebView
  has no Web Push), background-audio BREAK-OK (the OS silences the mic at
  screen-off, and the page cannot see it). The FGS + native bifrost-net
  design note is in `pwa/android/README.md`.
- **`bridge.tool-loop` KNOWN (new law)**: the agent tool loop runs entirely
  over the data channel (prompt op → real bash tools → 3 tool parts with
  real outputs + finals through the transcript op). But the bridge's
  2-worker op pool stalls every op while 2 tool runs are in flight (ping
  151 ms → 4313 ms). The fix belongs to bifrost-net (async prompt op).
- **SLO budgets** (`src/slo.rs`): every latency gets a budget (≈2× the
  worst value seen in cycles 1–5) and, where a product goal exists, a
  target. A PASS over budget, or with a budgeted metric missing, becomes a
  FAIL. Targets never fail a run but show "over target" on the board. The
  digest records budgets held and over-target counts. Unit-tested.
- **`voice.stt-inprocess` KNOWN (v0.6.2 gate rehearsal)**: the `SttEngine`
  seam (`src/stt.rs`) with a service (speaches) and an in-process engine
  (`voice/stt_edge.py`: onnx-asr + Parakeet Redux resident in the edge
  process), on the same Opus-decoded phone audio. English is at parity
  (WER 0/0), 10× faster per utterance (≈0.5 s vs ≈5 s), **10 s utterance
  ≈1.3 s, inside the ≤ 2 s gate**. French misses parity (37% vs 18%;
  multilingual Parakeet v3 int8 tried: 31%). The scenario flips to PASS
  when an in-process model matches on French.

**Cycle evidence** (`report/cycles/cycle-6.json`, seed 0xc0ffee, wall 423 s;
the sim booted its own AVD in 35 s and shut it down at the end):

```
MATRIX: 30 ran · 23 pass · 4 break-as-expected · 3 known-issue · 0 skip · 0 FAIL
SLO: 44/45 budgets held · 4 over product target
CYCLE 6 VALID — green-except-documented (23 pass / 4 break / 3 known / 0 skip)
```

Digest: 4 verdict shifts (app.install-pair and app.hot-reload SKIP → PASS;
app.push-notification and app.background-audio SKIP → BREAK-OK), +3
scenarios, one drift flag (paced-uplink-starved 50.7 s → 19.5 s, 0.4×: the
starved uplink drip varies a lot run to run; worth watching, no verdict
change). How to read the SLO tally: the single budget miss is
`bridge.prompt-run-done` (KNOWN, 20 s through the 120 s-timeout path).
Budgets only bite PASS verdicts, so it is reported, not failed. The 4
over-target metrics are the three voice turns (13–18 s against a proposed
8–10 s; CPU speaches) and the bridge HOL ping (4.3 s against 0.5 s).

**Delta vs v4**: 27 → **30 scenarios** (+3), 4 SKIPs → 0 (the app family is
live), +1 family (`voice.*`), +1 quality gate (SLO budgets/targets on 45
metrics), +2 laws (bridge op HOL; WebView silent mic loss), the item-1
answer, 0 FAIL. Unit tests 11 → 14. One ledger repair (the v4 section
restored, see above).

app-version pairing: app 0.6.0 ↔ sim 0.5.0

**Mined for v6**:
1. The real phone lane: run `chrome-mic-origin` and `background-audio`
   against the owner's S22 over adb (wireless debugging on the tailnet).
   That covers what the emulator cannot: the real mic, One UI battery and
   Doze, the owner's saved per-origin permissions, current Chrome.
2. Native shell rung (v0.8 "bridge + app"): a microphone foreground
   service in `pwa/android`, which should flip `app.background-audio` to
   PASS, then `app.bridge-native` (the Rust bifrost-net client over JNI
   holding the data channel with the screen off).
3. The in-process French gate: ≥ 10 FR fixtures, including real human
   audio from the voice-lab corpus, not one TTS voice; candidates
   multilingual Parakeet v3 (fp32 vs int8), Canary, whisper-ort. Also
   concurrency (two speakers at once) and RSS under load. Then the Rust
   in-process engine (sherpa-onnx) behind the same `SttEngine` seam.
4. Track bifrost-net's fix queue: prompt-op HOL (async prompt), the
   run.done baseline, and pacing/BWE. Each flips a KNOWN or BREAK-OK the
   moment it lands, and is held to budget from that cycle on.
