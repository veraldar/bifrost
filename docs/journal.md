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
