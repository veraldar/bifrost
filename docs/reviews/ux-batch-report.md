# UX-BATCH — report (10-23)

Tree `~/Work/bifrost-sandbox` (lab/sandbox), commits `b8142e7..6e74c7f`. Served on :8090 → :8443, build
`X8kys9FT7tGAxGlogva6n` (`/api/build` = `.next/BUILD_ID`, chunk 200). The live stack was not touched.
The agent was not touched either: all five fixes landed on the phone side, where the speaker, the mic and the cue are.

| # | report | verdict | commit | e2e (sandbox, real stack) |
|---|---|---|---|---|
| 1 | door has no text option | **fixed** | b8142e7 | `ux-batch-typed` "#1 or type it" ✓ |
| 2 | typed message stays | **found + fixed** (same root as 1) | b8142e7 | `ux-batch-typed` A ✓, B ✓ (B failed before the fix) |
| 3 | "bifrost" loses its attack | **the engine can't take a hotword** (documented). **The root cause is fixed.** | 214af11 | `ux-batch-hotword` ✓ |
| 4 | TTS echo → user turns | **fixed** (+ 4b, found on the way) | 806905f, 889be6e | `ux-batch-echo` A (bug reproduced) ✓, B (gate) ✓ |
| 5 | voice tests pollute MAIN | **fixed** | 6e74c7f | `ux-batch-voicetest` ✓ |

Final build: `playwright.ux-batch.config.ts` **7/7**.

## 1 + 2 — one root cause
Truth (e2e first): plain keyboard turns were fine (A: the composer clears, one message, the reply lands, busy clears).
The problem was the **first-turn card** in MAIN right after the door: it only moved on after a *voice* turn.
A typed message was sent and answered, but the card stayed on "hold the mic". That card was the message that
stayed (your 10-23 device diag shows "first-turn: card up" on every MAIN open).
Fix: the card now offers **"or type it ↓"** next to the mic in all three states (mic not asked yet, ready,
mic refused). A typed send *is* the first turn: sent → received (the server copy; the optimistic echo never
counts) → reply → "you are in". The reply is shown, not spoken. The spoken line now names both ways
("…hold the mic and say anything, or type it below."; en + fr re-rendered, referee score 1/1).

## 3 — hotword: the engine can't; the attack was lost on our side
- The Mac's `/v1/audio/transcriptions` takes `file` + `model` only. There is no prompt/context field, so no bias term can be passed.
- That isn't the problem anyway. Kokoro "Bifrost bridge voice test." sent to Qwen3-ASR, with the first N ms of onset cut:

| onset cut | af_heart | am_michael |
|---|---|---|
| none / 0.5 s lead / 150 ms fade-in | Bifrost Bridge Voice Test. | Bifrost Bridge Voice Test. |
| 40 ms | Bifrost Bridge Voice Test. | Bifrost Bridge Voice Test. |
| 80 ms | Bifrost Bridge Voice Test. | **Defrost** Bridge Voice Test. |
| 120 ms | **Defrost** Bridge Voice Test. | **The Frost** Bridge Voice Test. |
| 160–220 ms | **Frostbridge** Voice Test. | **Frost** Bridge Voice Test. |

- Where the onset went: a hold arms at 250 ms, then the device re-acquire + track unmute take more time.
  Meanwhile the hold UI **already said "heard · release to send"**.
- Fix: "opening the mic… talk at “heard”" (dim) until capture is live. Then "heard" + amber + one haptic tick:
  the documented "beat", built into the cue. Diag logs `ptt mic live <ms> after press` (desktop e2e: 318 ms).
- Possible next step (not done, it touches the shared prod speech box): a `prompt` → Qwen3-ASR context passthrough in the Mac wrapper.

## 4 — echo gate (phone side, no protocol change)
While a reply or door line is audible, the published mic track is **paused** (LiveKit `pub.mute()`: device stays
open, no renegotiation). It reopens 400 ms after the audio ends, and only if still wanted (hands-free listening
or a held mic). Every `mic(true)` inside that window waits for it. A PTT hold **barges in** (stops the reply).
`?echogate=0` turns the gate off; it exists only for the A/B.
**Replay test**: an init script wires every `<audio>` the page plays into the stream LiveKit publishes (speaker
straight into mic). The reply ends in "over", and tap-to-send follows it.
A (gate off): "The bridge is open, and the tree is listening" landed as **your** turn. B (gate on): **0 user turns**,
diag "mic paused while the phone speaks" → "mic back".
**4b** (found by B): tap-to-send with nothing buffered stranded hands-free on "working on it · mic paused"
indefinitely, because heartbeats kept re-arming the escape. Now, after 10 s with no turn and no run: "nothing heard", and the mic comes back.

## 5 — voice-test room
Settings → **voice tests → test room on** creates the `voice-test` session if it's missing. While on, MAIN (tree corner,
list, link) opens `voice-test` instead. Room = slug, so voice, transcript and the hands-free cycle stay in one session,
and MAIN is never joined as a room. The header chip **"test room ✕"** turns it off and goes back to MAIN.
e2e: the only token room requested was `voice-test`, the turn landed there, and MAIN's `X-Total-Count` didn't change.

## Regression (honest)
- Door suite (`playwright.tree-first.config.ts`): 8/8 after #1/#2. On the final build `voice-wait` "slow voice" flakes
  1 in 5 (`first(...)` undefined in its own mark recorder). The door code is untouched since d7a131e.
- General suite against :8090: **41 passed / 9 failed**. None of the failures are in code this batch changed. I
  have **not** A/B-verified them against a pre-batch build:
  - `context`, `wedge` ×2: `TypeError: fetch failed`. Node `fetch` dies under `--jitless`; this run was in the lk-yggdrasil cgroup.
  - `door-repro`, `stt-phone`: another lane's untracked specs with their own configs (fresh device, :8443).
  - `settings` (yggdrasil drops `variant: 'high'`), `subs` ×2, `base` home "new session": sandbox/brain differences.

## For you to verify (phone, :8443, ~3 min)
1. **#1/#2** Open MAIN. Your device still has the first-turn card, so it now shows **"or type it ↓"**. Tap it, type anything, send.
   The card goes received → reply → **"you are in"**. It doesn't come back.
2. **#3** Hold the mic. It says "opening the mic…", then **"heard"** (amber + a buzz). Then say "Bifrost bridge voice test". It lands as **Bifrost**.
3. **#5** Settings → voice tests → **on**. Tap the tree corner: you land in **voice-test** (chip "test room ✕"). Voice turns land there; MAIN doesn't move.
4. **#4** In voice-test, with the speaker loud: tap the mic (hands-free), say something + "over". The reply is spoken and
   **nothing comes back as your turn**. Tap "listen" on the reply while hands-free: same. Chip ✕ → back to MAIN.

## Notes
- The sandbox agent unit `lk-agent-ygg` runs from `~/Work/lane2-merge/agent`, not from this tree. This tree's
  `agent/agent.py` is 3 weeks stale (474 vs 629 lines). Nothing here needed the agent, so it was left alone.
- Built and tested inside the lk-yggdrasil cgroup: `node --jitless` + `scripts/jitless-wasm-shim.cjs`, Chromium `--js-flags=--jitless`.
