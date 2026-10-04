# Open Questions

Unresolved decisions land here the moment they appear, and move to `journal.md` once decided. Nothing is dropped silently. If this table is empty, nothing is pending.

| # | Question | Impact | Raised |
|---|----------|--------|--------|
| 3 | On-device voice tier in the PWA: ship Moonshine-js (en STT) + kokoro-js (fr TTS) + silero-vad as an offline/fallback tier behind a flag? Browser WebGPU is live on iOS Safari 27+/Android Chrome; ~45-150MB packs, iOS cache-eviction + background-throttle caveats. Research: `artifacts/on-device-voice-research.md` + lower-layer addendum `artifacts/going-lower-voice-stack.md` (native app / NPU / satellite-device options). Decide after the 1-day RTF spike (ios+android) | Adds offline resilience + zero-server voice; scope guard for v1 vs post-v1 | 09-30 |
| 4 | Radical local-first: bifrost ON a raw device (spare Android via Termux, postmarketOS, kiosk ROM, or cheap box) with local STT/TTS defaults; Mac/opencode/cloud become optional quality upgrades. Design note: `artifacts/bifrost-on-raw-device.md`. SPIKE HALF-DONE 09-30 (a2051fc): `edge/` server speaks the agent's exact API shapes locally, round-trip 7/7 on x86 (STT rtf 0.29 / TTS rtf 0.26-0.37, CPU-only); remaining: Termux run on the spare phone (RTF + battery on real arm64) then fr-STT pick | Inverts dependency model; changes positioning ("runs on what you have"); mostly an env/tier change, not a rewrite. PRIORITY CALL 09-30 (user): NOT OS-first — LLMs still need real hardware (20-70B class for agentic work), so the software+onboarding track leads and "bring your box" (validated-boxes guidance) is the hardware story; Bifrost OS stays parked as research until small models carry the full loop; near-term shape = hybrid (voice on-device when server's gone, brain on hardware) | 09-30 |
| 2 | Dreaming spec (`spec-dream.md`) open decisions: memory storage location (`~/Work/memory/` vs per-repo), dreamer runtime (non-interactive `opencode run` vs standalone script), clustering method (LLM judgment vs embeddings vs both — decided via strategy experiments at D1, not upfront), and what "importance" actually means. Defaults chosen 09-28: memory in `~/Work/memory/` (global — bifrost is a multi-repo remote), dreamer = non-interactive `opencode run`, importance = LLM judgment, clustering via strategy experiments at D1. Build post-v1; only the experiments themselves are open | Defines the first implementable increment | 09-26 |

> 09-27 plan review: onboarding auth (spec-onboard OQ1, cookie vs passkeys) PROMOTED — it is the only unresolved decision gating the consumer release (v1.0) and carries security weight. Decide before onboarding phase 2 starts.

> 09-28 sweep — answered, moved to journal (veto window: just say so):
> **Tool permissions** → deny-by-default via opencode's own permission config, mapped by a bifrost voice profile: safe reads auto-allowed (read/grep/glob/ls), write/edit/bash denied in voice mode unless confirmed in a text session first; whitelist lives in agent/.env (BIFROST_TOOL_POLICY). **Committed-turn chip** → solved by the hands-free phase line ("sending…" state + cancel); re-open only if the hands-free pass shows real confusion.

## 10-01 — delete safety: is undo+metrics enough, or archive-before-delete?
Swipes commit through a 3s undo toast (10s for ≥10-msg sessions) that shows the msg count. Rejected for now: "are you sure" modals (friction on every delete), keyword extraction (flaky), live agent review (async — verdict lands after the delete). Stronger option if a fat session ever gets lost: have the DELETE proxy route archive the transcript to disk (e.g. `pwa/.trash/<id>.json`) with a 24h auto-purge before deleting in opencode — deterministic, no UX cost. Awaiting a real loss event or user call.

## 10-01 — comms: YouTube channel name/handle; merch production gate
| # | Question | Impact | Raised |
|---|----------|--------|--------|
| 5 | YouTube channel name/handle: `bifrost` (product channel, "a Veraldar product" subline) vs `veraldar` (brand channel) — handle availability unknown | Channel identity locked at account creation; all `docs/comms/` drafts reference it | 10-01 |
| 6 | Merch production gate threshold: what counts as "an audience exists" (star count, clone count, or day-90 retro verdict) — until then `docs/comms/channels.md` merch section stays CONCEPTS ONLY | Gates any print file becoming an order | 10-01 |
| 7 | SWISS MADE on veraldar.org: research done (criteria per MSchG art. 48–48d + swissmadesoftware.org — 60% CH production costs, most-significant-part of dev in CH, CH entity in commercial register; label needs Level 1 membership CHF 120/yr + approval; misuse punishable). veraldar today: dev in CH plausible ✓, 60% undocumented, no registered entity ✗. Recommendation: hold the claim; use factual "the maintainer builds in Switzerland" until entity registered + 60% documented + membership approved. Comms research in `docs/comms/channels.md` § swiss made | Legal/trust signal on the site; ORG session owns the decision + Verein timing | 10-02 |

## 10-02 — artifact categories + call-back (pre-build review, spec: artifacts/artifact-cats-callback-report.html)
1. hf pending-attach: agent commits hf turns, phone can't intercept — rec: reference lands as its own tiny line on leaving the artifact (ptt/hf); question follows by voice — DEFAULT TAKEN unless vetoed
2. categoriser model pin + ≥60s cooldown; back-catalog bootstrap ≈ 1 run / 10 files — USER: which model (default: cheapest available from /api/models)
3. watcher vs e2e: specs write the real artifacts dir — rec: watcher off under test env, e2e seeds .meta.json — USER: confirm
4. write-settle ~2s before force-set (progressive big writes) — default taken
5. parallel-session attribution: null over wrong → p3 chooser — default taken
6. author frozen at first attribution; re-cat never changes ses — default taken
7. ses id → slug reverse mapping — verify in oc lib before slice 2 (blocking detail)
8. gallery sessionStorage cache: list response carries meta version, client refetches on change — default taken
9. .meta.json git hygiene — RESOLVED: /artifacts/* already gitignored (whitelist rule)
10. deleted source session → ask falls to p3 chooser, never 404 — default taken
