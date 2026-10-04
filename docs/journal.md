# Journal — bifrost

Append-only log. One line per decision or incident; newest first. Open decisions belong in `open-questions.md` until resolved, then land here. Duplicates nothing: this is the *when & why*, `plan.md` is the *what's next*, `spec.md` is the *what it is*.

## 2026-09-24

- **GitHub**: repo `veraldar/yggdrasil-bifrost` (public). Fine-grained PAT gotcha: private org repos need explicit per-repo selection — public-only access 404s them.
- **Session-scope incident**: pointing `opencode-serve` at `~/Work/bifrost` orphaned all sessions (opencode scopes sessions per project) and the proxy **cached the empty list**. Fix: scope stays `~/Work` (agent context comes from root `AGENTS.md` + repo files), cache never pins empty results. Lesson: the base must degrade to retry, never lock in a wrong state.
- **Diag upgraded**: net-fail entries now include the response error body — a 500 is pinpointable from the log alone.
- **UX fixes**: single attach button (one picker, routing by type); keyboard mode fully disconnects the room (Android mic indicator was "hanging" on mute-only); chat shell clipped (`overflow-hidden` + `overscroll-contain`) so only the transcript scrolls; busy state clears on run-settle (`X-Run-State`), not per-step.

## 2026-09-23

- **Standing policy**: user grants autonomy — proceed without sign-off when confident; contact only if stuck, looping, or needing human input (tests, logins, passwords). Evidence-based verification still mandatory.

## Earlier (from open-questions ledger, resolved)

- **Speech stack on Mac (M3 Ultra)**: MLX wrapper `com.opencode.mlxvoice` on the Mac's LAN address, port 8001 (see `docs/local.md`) — Qwen3-ASR (~1.3s) + Qwen3-TTS (~1.2s). Fallback: speaches on omarchy `:8000` (CPU). No cloud APIs, no keys.
- **PWA serving**: Next.js node server on :8080 (token minting needs server runtime); Caddy dropped. Tailnet-only exposure is the security boundary.
- **STT/TTS local-only**: speaches (OpenAI-compatible) was the first answer; superseded by the Mac MLX wrapper above.

- **Same day, later**: (1) **Context injection** — root cause of "agent doesn't know bifrost": server scope is `~/Work` (sessions list invariant) so repo-root `AGENTS.md` never loaded. Fix: layered stub `~/Work/AGENTS.md` (always on, 6 lines) → `bifrost/AGENTS.md` (full). e2e enforces "meta question ⇒ ≤1 pointer read, no repo crawl". (2) **Wedge incident** ("bugs" session): a run hung without completing (assistant message stuck, `completed=null`) and every later prompt 200'd but queued forever. Fix: run-state now carries last-role; client auto-aborts when 30s busy with user-last state, then hints to resend. Manual abort verified the fix path. (3) **Tool transparency** — tool-only assistant steps were dropped by the proxy (phone showed "thinking then nothing" while the agent ran 12 tools). They now render as a one-line ⚙ summary. (4) **Traceability policy** (user request): each user request gets referenced in the commit that implements it; phone-sent instructions count.

## 09-26 — v0.1.0 decisions & fixes
- **OQ#2 answered (user)**: one-click Vercel deploy is for OTHERS cloning the repo
  (README button now a real clone link with env pre-listed); this box's own deployment
  stays tailnet-only per spec Security. Container validation satisfies the plan box.
- **PTT one-hold-one-message**: VAD endpointing auto-committed on mid-hold pauses →
  partial transcripts landed as 3 separate messages. Agent now flips to
  `turn_detection="manual"` on `ptt_begin` RPC, back to `"vad"` after the release
  commit; phone fires `ptt_begin` before the mic opens. Hold-duration timer added to
  the equalizer (user req).
- **Queue swallow fix**: opencode v1.18 occasionally no-ops a POST right after an
  abort (live: "20s" run resolved in ~200ms, no reply). forward() now verifies
  pickup (prompt in transcript + assistant reply after it) and re-fires ONCE,
  never for deliberate stops (markAborted). Queue spec went ~50% flaky → 3/3 green.
- **states.spec**: hands-free cancel ack held only in silent rooms; e2e fake mic is a
  loud tone, so the test now asserts the real invariant (cancel never sends, no new
  user message) instead of acoustics.
- **e2e**: 19/19 green against the live stack before tagging.
- **v0.1.1 (09-26)**: user asked for a self-hoster release + whether the
  container/VM path is tested. Honest gap: only PWA-from-zero was. Shipped
  `scripts/selfhost-check.sh` (clone→build→boot→probe), validated in a clean
  node:24 container vs fresh GitHub clone; release notes carry an explicit
  test matrix — full-stack-on-fresh-VPS stays "documented, not machine-validated"
  until the onboarding spec lands.

## 2026-09-27 (late)

- **Themes layer-1**: `veraldar-theme` repo now speaks W3C DTCG tokens; `build.sh all` renders ONE tokens.css (`:root` = aether default + `[data-theme=…]` blocks). PWA consumes it via `@import` in globals.css, switching via **next-themes** (`/theme` page: slide cards, live apply, reached by tapping the ⌁ brand mark). Light theme (`drift`) gets a dark tree variant + `color-scheme: light`. e2e 19/19 green. Reuse decisions: next-themes (standard), DTCG (future Style Dictionary path), Phaser+Tiled for realms later — no hand-rolled plumbing kept.
- **Backdrop generator**: forensics on ygg tree (angles {0,45,90}, ~20px bands, mirror symmetry) → `SPEC.md` + procedural generator + validator in veraldar-theme (pixelarticons/lucide pattern: spec + generator + validator, never tracing/AI-SVG). Three themed backdrops regenerated; validator caught real geometry bugs (illegal angles, band crossings, missing mirrors). Lesson: constraint-heavy styles need by-construction generation.
- **Onboarding phase 1 proven (09-27)**: two agent builds wedged → wrote the
  skill + bootstrap by hand. Cold container tests: (a) opencode harness,
  raw selfhost-check URL → PASS; (b) **Claude Code** (zai plan, non-root
  user), raw skills/install/SKILL.md URL + "set it up" → cloned, audited the
  script, ran bootstrap, verified, reported verdict READY with honest skips.
  Container limit: docker-dependent layers (LiveKit/speaches/agent) need a
  real VM/VPS trial — the second-machine test.

## 09-28 — open-question sweep (user directive: answer everything answerable, plan = solo-implementable)
- **Tool permissions (OQ#1, open since 09-17)**: deny-by-default via opencode's
  permission config + bifrost voice profile (reads allowed; write/edit/bash
  denied in voice unless pre-confirmed in text; whitelist via BIFROST_TOOL_POLICY).
- **Committed-turn chip**: answered by the hands-free phase line; re-open
  criterion = hands-free pass shows confusion.
- **Onboarding auth**: one-time token → signed HttpOnly cookie (90d); passkeys post-v1. Stage-B blocker cleared.
- **Connectors OQs**: CLI-format spikes in-phase; sandbox temp-dir attachments; namespaced model ids; switch confirm dialog.
- **Dreaming defaults**: ~/Work/memory, opencode-run dreamer, LLM-judged importance; build post-v1.
- **Hands-free pass**: procedure written into plan.md (echo test at 50% volume, ~2.5s commit, latency feel, hf-restart double-speak check, mic release).
- Remaining that only the USER can do: run the hands-free pass; provide LLM provider keys on new machines.

## 10-03 — Anthropic subscription lock-in (verified, recorded)

- **Fact**: Claude Pro/Max subscription auth is locked to first-party Claude Code — Anthropic ToS prohibits third-party clients, servers validate the client. opencode dropped its bundled plugin in v1.3.0 (1.18.30 source re-confirmed: no anthropic auth plugin, `/connect` → API key only). Community bypass plugins = ToS violation / ban risk. Contrast: OpenAI/Copilot/GitLab subscriptions allow third-party tools. Z.AI coding plan serves GLM only, never Claude. Full notes + revisit trigger: `docs/research/anthropic-lock-in.md`.
- **Decision**: no multi-agent harness layer under bifrost over this — opencode sessions can delegate to Claude Code when subscription Opus is needed. Revisit only if Anthropic tightens further or orchestration needs grow.
