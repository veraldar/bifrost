# Sim gap — v0.7: what "simulate-tested" actually tested vs what shipped

*Decision doc, 2026-10-19. Docs only — no product code, services or env touched.
Dispatch 3 of 3 from the open URD row (`docs/urd/tests.md:27-29`; siblings: onboarding-flow →
`docs/reviews/onboarding-gap-analysis.md`, voice-stt-sandbox → answered there §0.1/§1, sim-gap → this doc).
Session SIM-GAP. Territory: this file + the Rule 10-08 amendment in `docs/lab-playbook.md`.*

---

## 0. Answer first

1. **The labs' GREEN was real — and it certified a different artifact.** Sim cycles 6/7 ran
   `app_version 0.6.0` (the **mainline** PWA, `lab/ygg-sim/report/cycles/cycle-7.json`) in a
   hermetic world: real `yggdrasil` + `bifrost-net` binaries spawned on **ephemeral ports**,
   the upstream LLM mocked in-binary, voice via an in-sim pipeline against local speaches,
   device = **Android 16 AVD emulator** fed a **looping lab WAV** as the microphone
   (`lab/ygg-sim/README.md`, `FINDINGS.md`, `src/app.rs` adb-reverse origin).
2. **v0.7 shipped none of that surface.** The tested artifact was the **sandbox tree-door
   build** — `~/Work/bifrost-sandbox`, branch `lab/sandbox` (ab00e73 → d0b8d76) — served on
   tailnet `:8443` → `:8090` (`bifrost-sandbox` + `lk-agent-ygg`, agent `bifrost-ygg`)
   (`docs/STABLE.md:51,158-163`). Voice rode **LiveKit rooms**, STT was a **remote service
   call to the Mac MLX speech server**, and the mic was the **user's real phone**. No sim
   scenario has ever touched that stack: the matrix has `rest.* bridge.* voice.* app.*` —
   zero `onboard.*`, zero LiveKit, zero real-mic lanes.
3. **Two of the three v0.7 kills are parity failures by construction.** (a) The lab's own
   fake-mic scaffolding (`?labmic=1` → `lib/labmic.ts` looping WAV) shipped **on for every
   device that tapped the tree** — the phone recorded into the lab's test fixture, not the
   room. (b) The sandbox voice agent requested `STT_MODEL=Systran/faster-whisper-small`
   from the Mac MLX server → HTTP 500 on every call. Both root-caused with log evidence in
   `docs/reviews/onboarding-gap-analysis.md` §1. A hermetic sim cannot see either: it
   spawns its own binaries with its own env, and in the lab the fake mic *is the feature*.
4. **The lab receipts and the phone experience differ by 17×.** Loop receipts 10-06
   (`~/Work/bifrost-sandbox/LOOP-RECEIPTS.md`): "agent streaming first-sound 1248–1285 ms",
   "emulator APK renders the tree door + live onboarding", "installer **PASS-SIM** 9/9".
   The same night, on the phone: tree tap → first sound **21.3 s**, STT dead
   (`docs/urd/tests.md:29`, onboarding-gap §1 timeline). Even the receipts' own vocabulary
   ("PASS-**SIM**") said what they certified; nothing downstream asked.
5. **Fix, as law — Rule 10-08.5 ARTIFACT PARITY** (§7): *the simulation tests the shipping
   binary on the shipping device class* — repro-first. A GREEN attaches to the exact
   binary + build + config + topology + device class it ran on; "simulate-tested" attaches
   to a release only when the sim (or e2e gate) ran **that** artifact on **that** device
   class, and whatever the lab genuinely cannot reach (a real phone) is a **named SKIP**
   in the release notes — never silently carried GREEN. Lab scaffolding is build-gated so
   no shipping link can activate it.

---

## 1. What shipped as v0.7 (the artifact the user tested)

| component | shipped identity | source |
|---|---|---|
| front | sandbox tree-door PWA — worktree `~/Work/bifrost-sandbox`, branch `lab/sandbox` @ ab00e73, tree-first landed `ce40a1a`, last `d0b8d76` (uncommitted WIP = ONBOARD-BUILD session) | `docs/claims.md` yggdrasil-sandbox / onboard-build; sandbox git log |
| brain | `lk-yggdrasil` :4100 (Rust yggdrasil, **real** zai upstream) | `docs/STABLE.md:158-163` |
| voice transport | **LiveKit room**, agent `bifrost-ygg` via `lk-agent-ygg` dispatch (`AGENT_NAME` env-routing, `e440d08`) | sandbox git log; STABLE.md:51 |
| STT/TTS | remote service: `openai.STT(base_url=SPEACHES_URL)` → Mac MLX wrapper; sandbox agent pinned `STT_MODEL=Systran/faster-whisper-small` → **500** | onboarding-gap §1 R1b, `lane2-merge/agent/agent.py:326` |
| path | phone → tailnet **:8443** (HTTPS, secure context) → `:8090` loopback | `docs/STABLE.md:51` |
| ledger name | "the rust PWA + yggdrasil :4100" (`docs/urd/tests.md:29`) — shorthand for the Next.js PWA fronted by the Rust-brain sandbox stack (cf. `scripts/test-stack.sh:22`) | |

## 2. What the labs actually tested (artifact + mocks inventory)

**ygg-sim 0.5.0/0.6.0 — the "simulate-tested" engine** (`lab/ygg-sim/README.md`):

- **World**: spawns the *real* `yggdrasil` + `bifrost-net bridge` binaries as children on
  **ephemeral ports** over a seeded in-binary netem wire. The **only** mocked server-side
  component is the upstream LLM (in-binary, OpenAI dialect). "When speaches is absent,
  voice scenarios SKIP loudly instead of pretending."
- **Device**: `app.*` family = Android 16 AVD (Chrome 133) on the Mac Studio; the shell APK
  reaches its app via **`adb reverse`** — "the origin as the DEVICE sees it"
  (`src/app.rs:407`). The device never dialed `:8090` or `:8443` at all.
- **Mic**: `?labmic` injection — a looping WAV replaces `getUserMedia` (built for headless
  emulator loops, sandbox commit `b496703`). Finding 7 (screen-off mic silence) is measured
  *on the injected fixture track*. "Voice stretch impossible (Mac Studio has no mic)"
  (`docs/claims.md` android-lab) — **a real microphone has never flown through any lab
  lane.** The emulator's RTC blocker was surfaced, not resolved (`7657f92`).
- **Voice/STT**: in-sim pipeline, Parakeet-ONNX vs local speaches whisper-small, on
  Opus-decoded **fixture** audio (EN; FR openly failing, FINDINGS #10). Not the livekit
  agent, not the Mac MLX service, not `agent.py`.
- **Pairing**: cycle-6/7 snapshots record `app_version 0.6.0`, `sim_version 0.5.0` — the
  *mainline* PWA. The tree-door build exists only on `lab/sandbox`, never loaded by the sim.
  (The VERSIONS.md digest line "sim 0.6.0" vs snapshot `sim_version: 0.5.0` is itself a
  stale-prose pairing — see §7 on hashes vs prose.)
- **Coverage**: 30 scenarios — `rest.*`(9) `bridge.*`(15) `voice.*`(1) `app.*`(5).
  **No onboarding scenario family. No LiveKit. No first-run/cold-start. No real network
  origin** (the shaped wire shapes the bridge, which is *v0.8/v0.9 material* — the bridge
  had **0 devices** in production, STABLE.md:160-163).

**The sandbox's own "verification"** (what the shipping lane relied on): desktop
Playwright tree-first screenshots (`ce40a1a`), the emulator APK render (`b496703`,
LOOP-RECEIPTS), the night-cycle receipts (first-sound 1248–1285 ms — warm, local,
streaming agent), installer "**PASS-SIM** 9/9". All true — all inside the lab world.

## 3. The parity table

| dimension | labs tested | v0.7 shipped | parity |
|---|---|---|---|
| app artifact | mainline PWA **0.6.0** + shell APK (`cycle-7.json`) | `lab/sandbox` tree-door build (ab00e73→d0b8d76) | **NO** |
| brain | real yggdrasil binary, mock upstream, ephemeral ports | `lk-yggdrasil` :4100, real zai, live greeting path `/api/onboard` → brain → `/api/tts/stream` | partial (binary yes; env/topology no) |
| voice transport | str0m datachannel + in-sim `voice_pipeline` (bridge world) | **LiveKit** room + `lk-agent-ygg` (livekit-agents) | **NO** |
| STT | in-process Parakeet / local speaches, fixture WAV, EN | remote Mac MLX service call → wrong model → **HTTP 500** | **NO** |
| device | AVD emulator, Mac Studio, `adb reverse` origin | user's real phone, real mic, real Chrome, cellular/wifi | **NO** |
| mic | `?labmic` looping WAV (scaffolding) | same scaffolding **shipped enabled** on every tree tap (R1a) | **inverted** |
| network origin | loopback ephemeral / adb-reverse | tailnet serve :8443 → :8090, cold Next.js (502 KiB, DCL 2533 ms) | **NO** |
| onboarding UX | no scenario family exists | the entire v0.7 test surface | **NO** |
| what "CYCLE VALID" meant | the hermetic world is green, seed 0xc0ffee | — (nothing about the :8443 slot) | — |

## 4. How GREEN became "simulate-tested" (the claim chain)

1. `docs/claims.md` ygg-sim: "CYCLE 6 VALID: 30 ran · 23 pass · 0 FAIL" + "app.chrome-mic-origin
   answers the port question ON ANDROID" — **true**, about the sim world.
2. `docs/STABLE.md:56` carries it into the next-slot verification: "Verified on desktop
   Chrome and on **Android Chrome 133** (sim cycle 6, `app.chrome-mic-origin`)" — true for
   the mic-origin question (and it *held*: the phone's :8443 mic permission was not the
   failure), but it became the slot's evidence blanket. STABLE.md:60 even says the limit
   out loud: "Not provable on an emulator: your phone's Chrome version…" — stated, not gated.
3. LOOP-RECEIPTS (10-06): first-sound 1248–1285 ms, emulator tree-door render, PASS-SIM 9/9 —
   read as ship-readiness for the phone.
4. The missing step was structural: **no rule required anyone to state the artifact
   identity chain** (which build × which device class × which topology each GREEN ran on).
   Rule 10-07 already voids carried GREEN on *environment* drift — but the sim's
   ENVIRONMENT.md hashes providers/transports/models, not *which app build the sim drove*.
   The artifact boundary was invisible, so the GREEN crossed it silently.

## 5. Symptom → missing scenario (why the FAIL was structurally guaranteed)

| URD symptom | measured on the phone | sim coverage | root class |
|---|---|---|---|
| onboarding slow to load | DCL 2533 ms, 502 KiB raw JS, nothing renders pre-hydration (onboarding-gap §1) | none — no first-run/cold-origin scenario | artifact parity |
| slow tree click | tap → next paint sluggish on phone CPU | AVD on a Mac Studio; no device-class timing | device class |
| greeting voice slow | **21.3 s** tap→first sound; TTS step alone 9.1 s | `bridge.handsfree-round` measures warm, local, fixture TTS; receipt said 1248 ms | artifact+topology parity |
| **STT dead** | spoke → nothing (R1a fake mic; R1b 500) | voice lanes certify engine latency on fixtures; cannot see config drift (sim owns its env) or scaffolding leaks (the fake mic is the feature) | **mock shipped** |
| flow unclear | 4-question verdict | no scenario can measure clarity; desktop screenshots only | no lane exists |

The deepest finding is R1a: **the mock became the product.** The lab built `labmic` to make
headless loops possible; the shipping onboarding link minted it for everyone. That is the
exact inversion this law exists to forbid.

## 6. What genuinely carried over (fairness to the sim)

The sim is good at its job — it caught 10 real defects in the *actual binaries* (token
camelCase wire contract, `run.done` starvation, op-pool head-of-line, NAT-rebind law,
screen-off mic silence, no Web Push in WebView…) and answered the :8443 secure-context
question in a way that *did* hold on the phone. Its ≤2 s STT latency gate is the right
budget — the phone test then measured 21.3 s against it and failed loudly. Nothing here
argues the sim was wrong; it argues its GREENs were **carried across an artifact boundary
no rule forced anyone to declare**.

## 7. Rule 10-08.5 — ARTIFACT PARITY (the law, repro-first)

> **A simulation certifies the artifact it runs on — the shipping binary on the shipping
> device class — and nothing else.**
>
> 1. Every GREEN carries an artifact identity: binary/build/commit, config/env, topology
>    (ports, units, upstreams), device class. Cycle snapshots record **hashes**, not prose
>    versions (the "app 0.6.0 ↔ sim 0.6.0" digest line vs snapshot `sim_version: 0.5.0`
>    is the failure shape).
> 2. **Repro-first**: "simulate-tested" may attach to a release only when the sim or e2e
>    gate can be *re-run against the shipping artifact* — same build hash, same device
>    class, same topology. If the shipping device class is unreachable in the lab (a real
>    phone), the gap is a **named SKIP in the release notes** — loud, carried forward as
>    an obligation, never silently absorbed into GREEN.
> 3. **Mocks never ship**: test scaffolding (fake mics, lab tokens, mock upstreams) is
>    gated so that no shipping build or user-facing link can activate it; minting a
>    scaffolding flag outside a lab context must FAIL the matrix.
> 4. Simulating a *future* artifact (the bridge for v0.8, the next slot) is encouraged —
>    its GREENs attach to **that** future artifact and certify nothing about today's.
>
> *Evidence*: v0.7 root test FAIL (`docs/urd/tests.md:27-29`) — cycles 6/7 CYCLE VALID on
> app 0.6.0 + bridge world (AVD, lab-mic, in-sim STT) while the shipped :8443 slot was the
> `lab/sandbox` tree-door PWA + LiveKit `lk-agent-ygg` + Mac MLX STT; two of three kills
> are parity failures by construction (lab-mic shipped on; STT model the speech server
> can't load). This doc + `docs/reviews/onboarding-gap-analysis.md` §1.
> *Scope*: every lab with an app/endpoint lane (ygg-sim, android-lab, ios-lab, e2e
> suites) and every release gate (`scripts/promote.sh`, `scripts/gate.py`).
> *Counterfactual*: hermetic determinism still wins for regression hunting (seeded wires,
> chaos profiles) — parity is required for **certification claims**, not for exploratory
> runs; and where the device class is genuinely unreachable, the law demands the SKIP be
> loud, not that labs stop.

## 8. Obligations (routed, per territory)

1. **YGG-SIM session** (owns `lab/ygg-sim/**` — not edited here):
   add the incident to `INCIDENTS.md` (proposal:
   `- [v07-root-fail] 10-06 — v0.7 root FAIL on the shipping slot the sim never drove: tree-door build, livekit voice, real phone (urd 10-06, sim-gap review) | covered-by: none | class: artifact-parity | since: 7`);
   an `app.onboard-*` scenario family that boots the **shipping sandbox build** (pinned
   hash) and mints real onboarding links — a `labmic`-style scaffolding flag present in a
   shipping link = FAIL; snapshot hashes replace prose pairing.
2. **ONBOARD-BUILD session** (owns the fixes): R1a/R1b removals land with a regression in
   the shipping artifact's own suite — tree-first e2e runs with scaffolding FORBIDDEN on
   non-lab links (onboarding-gap §5 re-test already defines the numbers).
3. **Release gates**: `promote.sh`/`gate.py` print the live artifact identity (build hash),
   so any "simulate-tested" claim must name the same hash (Rule 10-08.5.2 made mechanical).
4. **S22 real-phone lane**: already mined as a v7 obligation in VERSIONS.md — this incident
   makes it non-optional; until it runs, every phone-class claim ships with the named SKIP.

## 9. Sources

`docs/urd/tests.md:23-29` · `docs/reviews/onboarding-gap-analysis.md` (§0, §1, §5) ·
`docs/STABLE.md:45-63,111,158-163` · `docs/claims.md` (ygg-sim, yggdrasil-sandbox,
onboard-build, android-lab) · `lab/ygg-sim/README.md` · `lab/ygg-sim/ENVIRONMENT.md` ·
`lab/ygg-sim/FINDINGS.md` (incl. Honest limits) · `lab/ygg-sim/INCIDENTS.md` ·
`lab/ygg-sim/report/cycles/cycle-{6,7}.json` · `lab/ygg-sim/src/app.rs` ·
`~/Work/bifrost-sandbox` git log (`ce40a1a, b496703, 7657f92, e440d08, d0b8d76`) +
`LOOP-RECEIPTS.md` · `docs/lab-playbook.md` Rules 10-05/10-07/10-08 · `VERSIONS.md` v5/v6.
