# v0.7 gate — final (V07-GATE-FINAL, 2026-10-24)

**Verdict: the matrix is all green.** Sandbox build `dBAzIRkZMnA43odv0JWmO` (:8090 → :8443), yggdrasil `a683c22`.
Live (:8080 / :4096) was never restarted or written to. The churn suite proves this by pid at the end.

## The matrix

| # | gate item | referee | result |
|---|---|---|---|
| 1 | onboarding suite | `playwright.tree-first.config.ts` on :8090 | **8/8**. Real voice first turn: transcript 804 ms after release. voice-wait slow-voice ×15: 15/15 after the flake fix |
| 2 | general suite | default config on :8090 | **57 passed · 0 failed · 2 skipped.** The skips are catalog-conditional: the sandbox has one model and no think levels (OG-think) |
| 3 | churn receipt (Rule 10-09) | `scripts/stability_suite.py` on the sim stack | **PASS, 8/8 phases, wall 182 s.** Receipt: [v07-churn-receipt.json](/api/artifact/v07-churn-receipt.json) |
| 4 | real-upstream verify | `lab/yggdrasil/verify-real-upstream.sh` | **PASS-REAL** (glm-5.3-flash; chat, tool loop, roll-up, abort mid-SSE, transcript). Before the fix: FAIL-AUTH, exit 3 |
| 5a | herdr triad e2e | `herdr-folds.spec` (:8090) + `herdr-sim.spec` (sim) + yggdrasil `verify.sh` triad block | **6/6 + 2/2 + PASS** |
| 5b | identity pins e2e | `herdr-folds.spec`: namesake, replacement, queue | **3/3 green. RED on the pre-fold build** (all 3 failed) |
| 6 | voice-test room default OFF | `herdr-folds.spec` (fresh device) + `ux-batch-voicetest.spec` (fleet turns it on) | **green**. No code change needed: no key means off |
| + | watchdog-zombie (untracked stalled run aborted) | `playwright.watchdog.config.ts` on the sim, 20 s stall | **PASS** |
| + | yggdrasil mock suite | `lab/yggdrasil/verify.sh` (slices 1–7 + triad) | **PASS** on HEAD `a683c22` |

## Wave 1 — the 9 general-suite failures: env, not the batch

I ran an A/B with the **original** specs (clean checkout of `008d8b4`) against two builds, both on the same sandbox brain (:4100):

| build | passed | failed | the failures |
|---|---|---|---|
| pre-batch `d7a131e` | 35 | 4 | context · settings tiles · wedge ×2 |
| batch `008d8b4` | 42 | 4 | **the same 4, byte-identical errors** |

The 7 extra passes are the batch's own specs. Causes:
- `context` read the transcript from the **live** brain (:4096), giving `raw.flatMap is not a function`.
- `wedge` ×2 seeded prompts on :4096 for a sandbox session, so "turn 1 never started".
- `settings` asserted the live catalog (`zai-coding-plan`, variant `high`).

The other 5 of the 9:
- `subs` ×2 seed on :4096. The original spec writes test sessions **into the live brain**, so it was kept out of the A/B on purpose.
- `door-repro` and `stt-phone` are another lane's untracked specs with their own configs.
- `base` "new session" was a load flake under `--jitless`. It passed in both clean runs.

Fix (tests only, `dbf8579`):
- `e2e/brain.ts` means "the brain the served app talks to".
- `GET /api/brain-dialect` asks the brain itself: only yggdrasil serves `/session/state` as JSON.
- The settings spec derives everything from the served catalog.
- The context spec asserts the honest law for each brain. yggdrasil's missing context-file injection is filed as **OG-ctx**.

The inherited 10-23 weakening of `base.spec` ("room stays warm") was **reverted**: the strict version passed in every clean run.

## Wave 2 — the accelerated stability suite (24h-equivalent in 3 min)

It runs on a **sim stack** (`scripts/sim-stack.sh`). That's this exact build plus the yggdrasil release binary, each under a transient systemd unit with its production unit's restart policy (the brain also keeps its hardening), against the yggdrasil mock LLM. Every kill lands on a sim unit, and turn volume never meets the provider's rate limit.

The 10-23 attempt instead SIGKILLed the real sandbox brain from a session hosted *by that brain*. It killed itself mid-turn, and that's why that wave died uncommitted.

The budget is the measured life, rounded up. The live diag's peak day had 64 visibility flips and 155 voice-connect lines. `LIFE.md` measures about 64 user turns a day, each an agent loop.

| phase | load | receipt |
|---|---|---|
| 1 reconnects | 200 wakes (SSE re-subscribe + transcript + list), turns running underneath | 200/200 answered; 10/10 turns exactly once; long-lived stream saw 10/10 run ends; fds 31→33 |
| 2 rekeys | 100 fresh-token joins of one room, **real LiveKit** | 100/100, p50 132 ms, max 200 ms; one identity; 0 participants left |
| 3 brain SIGKILL mid-turn | ×10 | heal 2.1–2.3 s; 10/10 `blocked/interrupted`; transcript closed; phone never left on "working…"; next turn runs; event stream back 0.08–0.33 s after the brain |
| 4 LLM provider death mid-stream | ×5 | brain survives (same pid); 5/5 `blocked/error`; next turn runs |
| 5 proxy SIGKILL, 2 turns queued | ×10 | heal 6.0 s; **20/20 queued turns replayed exactly once**, all replied; disk queue empty |
| 6 memory soak | 300-turn marathon (754 messages) + 300 turns over 30 short sessions | proxy +12.3% / +3.5%; brain 42 MB for the day's marathon (it holds the transcript by design); **flat-data brain +0.0%: no leak**; fds flat |
| 7 end state | — | nothing working, busy map empty, no open step; the user's 4 units same pids; sandbox MAIN byte-identical |

How I separated leak from data in phase 6: brain RSS in the marathon tracks the transcript, at about 100× its 417 KB compact size. A fresh brain on the same store reaches 29 MB after 3 turns. With the same turn volume and bounded data (the flat soak), RSS stays flat (30.0 → 30.4 MB in a separate run). I tried a no-clone transcript read: no RSS effect (29.2 vs 29.0 MB), so I reverted it and claimed nothing.

**The suite found three real bugs on its first runs. All three are fixed:**
1. **A reply cut off mid-stream was stored as a complete answer** (yggdrasil, `a683c22`). A provider dying mid-reply closes the stream cleanly, and the relay took EOF for the end. Now both dialects require the end marker, so a cut reply becomes `blocked/error` with the partial kept. Proven on the mock (`cut …`) and still PASS-REAL on the real provider.
2. **Turns queued behind a run never forwarded after a proxy restart, forever** (PWA, `fe56f3c`). Pickup only ran at a run's end, and the run had ended while the proxy was down; a deploy restart strands them the same way. Also, the queue and live-run maps loaded asynchronously, so the first enqueue after boot could rewrite the file without the queued turns. The fix: synchronous loads, and the watchdog moves orphaned queues on `session.idle`, every scan, and stream connect.
3. **The proxy's brain event stream came back 0.5–5 s after a brain restart.** Events in that gap were lost (run-done nudges, list busts, the liveness stamp). The supervisor tick went from 2 s to 250 ms, with a guard against two connects in flight.

There was also a fourth, found by the sim triad e2e (`a0c1df7`). A list GET built across a cache bust was re-cached for a full minute: a 7 ms run's "working" row outlived it by 60 s. It's pre-existing and also affected the list dot. A bust generation fixes it.

## Wave 3 — verify-real-upstream FAIL-AUTH: the lie

The key the running brain uses lives in `lab/yggdrasil/yggdrasil.env`, the lk-yggdrasil unit's EnvironmentFile. The script only read the caller's environment, so every plain run said `FAIL-AUTH: YGG_UPSTREAM_BASE_URL not set` (exit 3) while :4100 served real turns on that same key.

The fix (`5621f4b`): with neither var given, the script reads **only** the four `YGG_UPSTREAM_*` lines from that file. The service's LISTEN, DATA_DIR, MAX_TOKENS and VOICE stay out of the throwaway, so the script's 4096 max_tokens default holds. Before: exit 3. After: PASS-REAL, 0 warnings. The `verify.sh` hook self-test still gives exit 3 for mock-429, mock-401 and an unset key.

## Wave 4 — the herdr folds

**§1.1 triad, harness-owned (yggdrasil `0438289`).** The run loop **declares** each session's state:
- `working` while a run is in flight;
- `blocked` + reason when a run stopped and needs the user (`error`, `step-cap`, or `interrupted`);
- `idle` otherwise.

The state is served on every session info, as `GET /session/state`, and as the `session.state` event. The binary busy map (`/session/status`) is now its projection. On boot, a run the dead process left open is closed and declared `blocked/interrupted` (the §1.5 handoff boundary).

Live receipt: the restarted sandbox brain closed exactly one corpse, `ses_d0884…`, which is the 10-23 "v07 gate waves" session.

On the PWA side (`93a528c`), the list's `state` / `stateReason` / `stateSource` follow herdr §1.2: the brain's declaration first, then the proxy's in-flight record, and the corpse detector only for a brain that declares nothing (opencode). A brain-declared run lights the list dot. The UI chips ride the next build.

**§1.4 identity-pinned waits.** The page pins the session **id** it opened: the list's `?id=`, else the first poll's `X-Session-Id`. It sends that id as `X-Session-Pin` on poll, send and abort, and the proxy resolves the pin over the slug. A gone session answers a typed 404 `session_gone`, and the page says "this session is gone". A queue dies with its session.

**RED before** (the same 3 specs on the batch build): the turn went to the **namesake** (two sessions with one name: the newer one wins the slug); the replacement of a deleted session **received the dead session's turn**; and the deleted session's queue stayed on disk.

The inherited 10-23 "incarnation" counter was dropped. Session ids are never reused, so its check could never fire, and its e2e passed with or without it.

## Wave 5 — voice-test room: default OFF

It's already off by construction: the device-local key is absent, so it's off. `herdr-folds` proves a fresh device reads off, and `ux-batch-voicetest` proves the fleet path (on → voice-test, ✕ → MAIN). If you turned it on during the UX-batch check, it stays on for **your** device until you turn it off.

## Commits
- sandbox `lab/sandbox`: `dbf8579` general suite · `93a528c` herdr folds · `a0c1df7` list cache · `fe56f3c` churn findings (proxy) · `6e54b4d` stability suite · `cd632ea` referees (voice-wait flake root-caused, watchdog-zombie onto the sim)
- bifrost `rebuild/cohesive-opus`: `5621f4b` verify-real-upstream · `0438289` yggdrasil triad · `88e4f59` OG-ctx + OG-think filed · `a683c22` cut-off replies

## Notes — what I changed outside code, and what is still open
- **Restarted** (sandbox only): `lk-yggdrasil` ×2 (new binary) and `bifrost-sandbox` ×3 (new builds). Live was never restarted, and nothing landed in it. My only live traffic was read-only GETs (session lists, one `/session/state` probe → 500), plus the two original-spec `wedge` POSTs in the A/B, which hit a 404 because the session ids were the sandbox's.
- **Deleted** 39 test-debris sessions from the sandbox brain (`e2e-*`, `repro-talk-*`, `probe-ab*`, `ctx-probe`; 0–4 messages each, from 10-19..10-24). Their cleanups pointed at the live port, the bug fixed in wave 1. Backups and an index are in `~/.local/share/yggdrasil/trash-v07-gate-20261024/`.
- **Live debris, not touched:** 41 `e2e-*` sessions (14 of them sub-sessions) sit in the **live** brain (:4096), from 10-04..10-23 runs of the old specs. Deleting them needs your go.
- Lab-rule fixes: the 10-23 pre-batch server listened on `*:8095`; I moved it to loopback and stopped it at the end. `playwright.watchdog.config.ts` ran a second `next start` on all interfaces in the served cwd; it now runs on the sim.
- Phase 2 used the shared LiveKit server (100 sequential joins of one sim room, dispatch name `sim-none`, so no worker took them).
- Still open:
  - The voice agent (`lane2-merge/agent`) still resolves a room to a session **by title**, once per job. The phone-side pin doesn't reach it.
  - OG-ctx (yggdrasil injects no AGENTS.md) and OG-think (one-model catalog) are filed in `docs/open-questions.md`.
  - The triad chips on the deck ride the next build.

## The 3-minute check (you, on the phone, :8443)
Everything above is proven in simulation. This is only your consent check.
1. **MAIN, keyboard.** Type `Reply with one word: ready`. The reply lands and "working…" clears. (~30 s)
2. **MAIN, voice.** Hold the mic, say a short question, release. The transcript appears and the reply is spoken. (~45 s)
3. **Another session.** Open any other session from the list and send `Reply with one word: here`. It lands in **that** session, and its list dot shows while it works, then clears. (~45 s)
4. **Settings → voice tests.** It reads off, unless you switched it on in the last check. On means the tree corner opens voice-test; ✕ goes back to MAIN. (~30 s)

All four behave as described: the gate is yours to consent to. Anything else: say what you saw, and it goes back to simulation first.
