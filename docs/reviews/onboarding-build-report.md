# Onboarding build report — one door, app + veraldar.org

*Session ONBOARD-BUILD, 2026-10-19 (08:24–09:50Z). Brief: `docs/reviews/onboarding-gap-analysis.md`
(ONBOARD-GAPS). Built in `~/Work/bifrost-sandbox` (branch `lab/sandbox`, served by `bifrost-sandbox` :8090 →
tailnet :8443) and `~/Work/veraldar-site` (`main`, deployed to veraldar.org). Live stack (`lk-pwa`,
`lk-agent`, live env) untouched. No `docs/urd/` edits: the user closes that row by re-testing.
Hostnames and IPs are left out on purpose (`docs/local.md`).*

## 0. Answer first

- **One door, start to finish.** veraldar.org's tree and the app's tree run the same script (one file),
  speak in the same pre-recorded voice (the app's own: af_heart EN / Elise FR), and ask the same
  questions (language · style · brain). The site's last step opens the app on your box with your
  answers in the link (`#door=v1.<lang>.<style>`), and the app's door picks up from there. The app's
  door ends in MAIN with **one real voice turn**: you hold the mic and talk, your words come back as
  your message (STT proven), the tree answers out loud, then **"you are in. talk to your tree."** with
  what to do next.
- **STT, the hard gate, works.** Both kills are removed and proven end to end. A spoken WAV played
  through Chrome's own capture path → LiveKit → `lk-agent-ygg` → Qwen3-ASR came back as
  "What is two plus two?" **0.86–0.96 s after release** (diag). Before: zero transcripts.
- **Speed (10-14 baseline → now):** greeting first audio **≈21 s → 61–117 ms** after the release.
  An answer's spoken confirmation takes **14–16 ms**. The tree is in the server HTML (first paint), and
  pressing turns it amber in the same frame. A parallel session's phone-class repro measured cold load
  2533 ms → 114–523 ms, tap feedback 7–23 ms (before: four taps in 3.2 s), greeting 9087 ms → 61–93 ms.
- **Not done here:** freezing the next slot as a release, wiring a real STT call into the gate, the v0.8
  pieces (one-time-code pairing, answers carried by the install line). See §6.

## 1. What I decided (full authority, defaults taken)

| question | decision | why |
|---|---|---|
| composition | the brief's **option C done right**, plus the A and B seams that cost little now: the site speaks the same pack and hands off to the app with the answers in the link | the user asked for one story across web and app; the pieces that need v0.8 (bridge pairing, installer) stay v0.8 |
| scripted vs LLM onboarding (Q1) | **scripted**, no brain call before MAIN; the brain's first turn is the real voice turn in MAIN | R2: the LLM-written greeting was most of the 21 s |
| canonical design (Q2) | one script `pwa/lib/onboard-script.json`, 21 lines × EN/FR; the site gets a copy of the lines tagged `on: site` | "same experience" needs one source |
| voice gender (Q3) | **cut** on both surfaces | nothing can apply it today (the TTS voice is fixed per env) |
| brain step (Q4) | **shown, not asked**: model + class from the box (`GET /api/onboard`), "set on the box" | a choice that changes nothing breaks the brand's honesty rule |
| hold vs tap (Q5) | **press = amber at once; any release opens the door** (deviation from the default "hold ≥ 400 ms") | veraldar.org's live door already opens on release; on a phone, audio may only start at release (that's when the browser counts the touch as a user gesture); a minimum hold would make "released — nothing sent" a dead end for people who tap. The amber on press fixes the "slow click" |
| answering during setup (Q6) | **chips** for the door's answers; voice is used for the real turn in MAIN (hold to talk, no "over") | the voice path that matters is proven where it's used |
| audio (Q7) | mp3 mono 24 kHz 48 kbps under `pwa/public/onboarding/<lang>/<id>.mp3` + `manifest.json` (the mission's path, not the brief's `voice/onboard/`) | the mission named the path |
| publishing renders (Q8) | **EN + FR on veraldar.org**: Kokoro-82M Apache-2.0; Elise-v2 Apache-2.0 on an Apache-2.0 base, Elise dataset MIT (HF API, 10-19) | the license check the brief asked for passed |
| site handoff (Q9/Q10) | **now** (not v0.8): "box running — open bifrost". The user types the box address once (kept in that browser only); the link carries `#door=v1.<lang>.<style>` | it's the cheapest real handoff: a fragment, never in any server log, no box ↔ site channel needed |
| pairing QR | desktop only: the app door shows a QR of the box's tailnet address + the answers; phones skip it | the sandbox is tailnet-gated (no device tokens); one-time-code pairing is lane2's v0.8 work |
| re-test target (Q12) | the sandbox as served (:8443), **no data clearing needed** | the door is versioned (`bifrost-door=v2`): every device sees it once, v1 leftovers are undone (below) |

**Brief vs feasibility, noted:** (a) The mission named the local speech server (127.0.0.1:8000) for the
pack. It has af_heart (ONNX build of the same Kokoro weights) but not Elise, so **FR renders on the Mac**
through the exact `/audio/speech_stream` call the app makes. A cold Elise load there took > 90 s
(two timeouts), then it rendered at 0.6–7 s per line. (b) The public `install.sh` installs **the brain
only**. The site's old copy ("paste it on the box and bifrost comes up speaking your language, in your
voice") overclaimed, so the site now says exactly what the line does, and `/start` lists brain · app +
voice · phone.

## 2. What I built

### Sandbox (`~/Work/bifrost-sandbox`, `lab/sandbox`)

| commit | slice |
|---|---|
| `d0b8d76` | kept 10-06 WIP (YGGDRASIL-LAB): `speech.ts` starts a reply that landed in one piece. The rest of that WIP (resume-into-setup) is **not** used: the scripted door has no setup session. It's parked as stash "YGGDRASIL-LAB 10-06 WIP…" |
| `9777ae6` | **C1**: the lab fake-mic needs a build flag + `?labmic=1`, and never reads storage. A pre-paint boot script clears a stuck `labmic` key on every page, so the user's phone heals on its next open |
| `c40bccf` | **voice pack**: script + generator `scripts/onboard-voice.mjs` + 42 files (EN af_heart, FR Elise), **every line transcribed back by Qwen3-ASR as a referee** (min score 0.91; "main" heard as "Maine") |
| `7276bc9` | `site_install` line made honest + `scripts/onboard-voice-site.sh` (copies the site's lines into veraldar-site) |
| `6f12842` | **the door v2**: the tree in the server HTML (static `/`), press = amber in the same frame, release = greeting from memory; language · style · brain shown · desktop QR → MAIN seeded with the answers at the style pick (the brain's ack is done before the first turn); the first-turn card in MAIN (ask the mic by its own step → hold, talk, let go → transcript → spoken reply → "you are in" + what next); a tap during the first turn says "released — nothing sent" instead of flipping hands-free; v1 leftovers undone (`oz-mode=free` would have opened MAIN without the hold-to-talk mic); `qrcode` 1.5.4 (trunk's version) |
| `14a351b` | **e2e**: `tree-first.spec.ts` rewritten for v2 + `first-turn-voice.spec.ts` (**real STT**, Chrome capture path, throwaway session, MAIN untouched) + `PW_BASE_URL`/`PW_JITLESS` + `scripts/jitless-wasm-shim.cjs` (§5) |
| `3703171` | the general suite runs as a returning device (the door spec stays fresh) + suite results / A-B |

### Sandbox agent (systemd drop-in, not a repo file)

`~/.config/systemd/user/lk-agent-ygg.service.d/stt.conf` (comments say why, and how to revert):
- `STT_MODEL=mlx-community/Qwen3-ASR-1.7B-8bit`. Before: `Systran/faster-whisper-small`, which the
  Mac can't load (HTTP 500 on every call: 19 on 10-06, 4 on 10-14, 15 on 10-19 before the fix).
- `VOICE_MODEL=yggdrasil/glm-5.3-flash`. The agent seeds this on any session without a model; the
  default `opencode/ling-3.0-flash-fin-free` made yggdrasil answer 400, so the agent's streaming path
  died on every fresh session (its fallback still answered).
- `TTS_MODEL` deliberately left as is. See §6.

### veraldar.org (`~/Work/veraldar-site`, deployed)

| commit | slice |
|---|---|
| `7407f5d` | the door speaks the app's pack (`speechSynthesis` only if a file is missing), steps = the app's, voice-gender step cut, style schema = the app's (`short\|detail`, old answers migrate), **"box running — open bifrost"** handoff link, honest install copy, `/start` fixed (it showed the docker command as "direct"), sw v8 precaches the manifest + greeting, a pick no longer re-speaks the question over its own confirmation |
| `ff5f33c` | the re-rendered `site_install` line |

Deployed 09:26Z with backups on the host (`index.pre-door2.bak.html`, `start.pre-door2.bak.html`,
`sw.pre-door2.bak.js`; restoring those three and removing `onboarding/` = rollback). It also shipped
`ee4eaac` (10-06, never deployed: the bifrost card says v0.6.1, the road to v0.9, Node 24+). That's true
of live, so it went along.

## 3. Evidence

| brief §5 criterion | 10-14 baseline | now | how measured |
|---|---|---|---|
| 1 open → tree visible | blank until hydration, `load 3396ms` | tree in the **server HTML** (first paint); cold load 114–523 ms (ONBOARD-V2 phone-class) | raw `GET /` contains the tree + caption; spec step 0 |
| 2 press → reaction | 4 taps in 3.2 s | amber **in the same frame** (class set in the handler); 7–23 ms (phone-class) | spec checks the class synchronously after `mouse.down` |
| 3 release → greeting audio | ≈ 21.3 s | **61–117 ms** (sandbox), 47–70 ms (veraldar.org) | diag `prerender greet en first audio Nms` |
| 4 answer → spoken confirmation | n/a | **14–16 ms** | diag `prerender lang_set …` |
| 5 STT round trip | no transcript ever | **0.86–0.96 s** release → transcript in MAIN's place (throwaway session), 0 `failed to recognize` in the agent journal for the runs, 0 `user-agi.wav` | `first-turn-voice.spec.ts`, agent journal. ONBOARD-V2/stt2 reproduced RED (faster-whisper → 150 s of talk, 0 transcripts) and GREEN independently |
| 6 whole onboarding | not finished (cancel at 83 s) | door → MAIN ≈ 5 s by taps (spec) | spec timing |
| 7 first brain turn, by voice | — | reply landed and spoken **6.1–9.1 s** after release (brain ≈ 4.7 s for "what is two plus two" + up to ~3 s settle) | spec + diag `first-turn: reply Nms` |
| 8 flow clarity | FAIL | **your call**: re-test below | — |

**Sandbox e2e (build `hJ5qEHP69VDd7euDSiHBl`):**
- **Door specs:** `tree-first` 2/2 + `first-turn-voice` 1/1, green four times.
- **General suite:** 22 passed / 10 failed / 3 skipped in one run, sharing the store with a concurrent repro.
- **A/B against the pre-change build** (same unit, brain and store): `context:8`, `settings:32`, `subs:24`,
  `subs:71`, `wedge:16`, `wedge:58` fail on **both**. They're opencode semantics yggdrasil doesn't have
  (no in-progress `|0|assistant` step, no THINK variant, no sub-sessions, message shape).
- `base:6`, `base:73`, `states:16`, `states:37` pass when rerun on this build. Their earlier failures were
  shared-store and concurrent-run flakes.
- **Regressions from this work: 0.**

## 4. Re-test (your phone)

Exact addresses: the sandbox is your box's tailnet name on **:8443** (`docs/local.md`), and veraldar.org.
No data clearing needed: every device sees the v2 door once, and the stuck lab-mic flag and abandoned v1
hands-free mode are undone on open.

1. **The site:** on the phone, open **veraldar.org**, scroll to the tree and hold it. It should speak at
   once in the app's voice. Pick english, short, a brain. On the last step, type your box address
   (`<box>.<tailnet>.ts.net:8443`) under "box running — open bifrost" and tap it.
2. **The app picks up:** the same tree. Hold it: "this is bifrost. your answers came with you." It skips
   straight to the brain step (`glm-5.3-flash · set on the box`). Tap **continue**.
3. **MAIN:** "planted. this is main." Tap **allow the mic** (the browser asks once). **Hold the mic**,
   say anything, let go. You should see `heard "…your words…"`, hear the tree answer, then
   **"you are in. talk to your tree."** with the four next moves.
4. **Cold app run (optional):** open `:8443` directly in a private tab. The full door runs: greeting ·
   english/français · short/more detail · brain · MAIN.
5. **French run:** pick français at the door. Lines play in Elise. The first turn works in French too
   (Qwen3-ASR does FR), but the e2e only proves EN.
6. **Desktop → phone:** open `:8443` on the laptop. At the brain step there's a QR. Scan it with the phone;
   the phone's door skips to the brain step with your answers.

Things to watch, and where they're logged: `pwa/.diag/diag-<date>.log` in the sandbox, lines
`prerender … first audio Nms`, `first-turn: transcript Nms after release — STT alive`,
`first-turn: reply Nms`, `door: → MAIN after Nms`.

## 5. Two things that shaped the session

- **This session runs inside the brain's hardening.** It was launched by the yggdrasil brain's bash tool,
  so it lives in `lk-yggdrasil.service`'s cgroup: `MemoryDenyWriteExecute`, `RestrictNamespaces`,
  seccomp. No JIT, so node runs `--jitless`, which has no WebAssembly, which means no `next build` and
  no node `fetch`. I **did not escape the hardening** (no `systemd-run` around it). I worked inside it:
  - `scripts/jitless-wasm-shim.cjs` stands in for webpack's WASM hashes with a native sha256 instance on
    the same ABI, and leaves undici's eager WASM load pending forever.
  - The generator uses curl; Chromium runs with `--js-flags=--jitless`.

  Builds take ~2–4 min this way. Recipe: `NODE_OPTIONS="--jitless --require scripts/jitless-wasm-shim.cjs" npm run build`.
- **Collision with ONBOARD-V2 ([FIX] onb2) and [FIX] stt2.** They were dispatched from the phone to the
  same worktree. onb2 stashed my uncommitted door work for its reproduce-first phase, re-applied it
  byte-identical, built and served it, and ran its phone-class repro on it. The coordination ran on
  `docs/claims.md`: a pen handshake plus two diagnoses I posted there.
  - Its 4b "RED" was a 900 ms hold, not STT.
  - Its chunk 400s were `.next` swapped under the running server by our concurrent builds.

  stt2 reached the same STT fix independently. Every commit above is ONBOARD-BUILD's code; the messages
  credit onb2's part. Their uncommitted files stay theirs: `door-repro.spec.ts`, `stt-phone.spec.ts`,
  `playwright.{door-repro,stt}.config.ts`, the edits to `agent/agent.py`, `agent/.env.example` and
  `scripts/sandbox-up.sh`, plus a comment tweak in `tree-first.spec.ts`.

## 6. Still open

1. **Freeze the next slot.** The sandbox still serves the worktree (`STABLE.md`: the v0.7 ladder's first
   step). `promote.sh` has no `--slot next` yet. The agent fix lives in a systemd drop-in until a
   next-slot release env carries it.
2. **Gate STT probe** (brief C2, second half). `gate.py` proves dispatch, not transcription. The real
   probe now exists as `e2e/first-turn-voice.spec.ts`; wiring a one-shot version into the gate is open.
3. **First reply latency.** 6–9 s after release vs the brief's ≤ 6 s *first audio*. Most of it is the brain
   (≈ 4.7 s on z.ai). The card waits for the run to settle (up to ~3 s). It could speak the completed
   reply sooner, at a small risk on multi-step runs. Left as is, measured.
4. **Agent-side TTS (lead for the stutter lane, unverified on live).** The lane2 agent never publishes
   audio (`audio_enabled=False`) but still synthesizes. In the sandbox its TTS id doesn't exist on the
   Mac, so it fails fast (500), and I left it that way. A valid id would put a discarded generation on
   the Mac's one-generation lock for every reply, colliding with the phone's own reply voice. Whether
   the live agent (`TTS_MODEL` = a Mac model) does exactly that is worth one look by the stutter lane.
5. **v0.8 per the brief:** one-time-code pairing (lane2) instead of an address QR; the install line
   carrying the answers (B1); per-device voice (brings the voice-gender question back); the Android shell.
6. **French first turn** is untested by e2e (EN fixture only). The FR door lines are refereed.
7. **6 general-suite tests** fail on both builds (yggdrasil vs opencode semantics). They need a
   yggdrasil-aware rewrite or a skip list for the sandbox.
8. **Stashes:** "door-v2-wip (ONBOARD-V2…)" is now committed (`6f12842`) and can be dropped.
   "YGGDRASIL-LAB 10-06 WIP" is kept for its owner.
