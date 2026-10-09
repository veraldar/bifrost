# Plan — bifrost

Single source of truth for status and next work. Decisions & incidents: `journal.md`.
Checklist = board. A phase done = all boxes checked.

## Prime directive (spec.md — binds every decision below)

Best human UX + best code for AI. Practical consequences: golden/contract
tests land with connectors phase 1 (executable contracts agents can verify
against); AGENTS.md map must be updated whenever structure moves; new
features declare core-or-edge in their spec; UX gates (hands-free pass,
pairing zero-typing) are release gates, not nice-to-haves.

## Invariants (must always hold — regression here is a bug)

- [x] List sessions, select one, create, delete
- [x] Text message → agent reply lands in transcript
- [x] Busy state clears only when the run settles (not per-step); a wedged run
  (prompt never picked up) is auto-aborted after 30s with a visible hint
- [x] Voice: PTT + hands-free; keyboard mode releases the mic (OS-level)
- [x] Voice self-heals stale tokens; polls bounded, silent on failure
- [x] Attachments: one picker — images downscale, files become text parts
- [x] Chat scrolls only vertically inside the transcript; session list never
  caches empty; tool-only steps stay visible (⚙ line)
- [x] Phone talks only to the Next proxy; opencode stays tailnet/localhost-only
- [x] Context injection: a fresh phone session (text/PTT/hands-free) knows where
  it is (`~/Work` scope), what bifrost is, and where details live — layered
  `AGENTS.md` (stub at `~/Work`, full at `~/Work/bifrost`); meta questions cost
  ≤1 pointer read, e2e-enforced (`e2e/context.spec.ts`)

## Done (base)

- [x] LiveKit + speaches compose; ICE pinned to tailnet/LAN
- [x] Python agent: room slug ⇄ opencode session, STT→opencode→TTS (Mac MLX, speaches fallback)
- [x] PWA: sessions UI, transcript w/ markdown, attachments + sandboxed HTML, voice modes, notifications
- [x] Diagnostics: console/net/tap/voice events → `pwa/.diag/`; net-fail captures error bodies
- [x] systemd units: `lk-pwa`, `lk-agent`, `opencode-serve`, `lk-verify.timer` (reboots self-heal)
- [x] Repo: `veraldar/yggdrasil-bifrost`, private infra in gitignored `docs/local.md`
- [x] e2e: Playwright suite (10 specs) against the live stack; env/test record auto-generated

## Release ladder — SUPERSEDED 10-06 by docs/STABLE.md (user: "gated between deployed versions v0.6, v0.7, v0.8 … must all be stable")

The single ladder source is now `docs/STABLE.md` (one structural change per version,
each gated by `scripts/gate.py`, every version a frozen release one `--switch` away).
Where the 10-02 rows went:

| 10-02 row | now |
|---|---|
| pre-wave (rename, skill URL pinned to tag, SECURITY.md, brand) | done or carried as-is (no code) |
| v0.7.0 "the reliable voice" — wedge-fix, ux-mictap, **edge sherpa voice = default** | **v0.6.2 speech**: STT in-process in the voice agent (user 10-06: STT in bifrost/yggdrasil, never a separate service); voice fixes ride v0.6.x |
| — (absent in 10-02) | **v0.7 tree**: yggdrasil becomes the brain, light prompt |
| v0.9.0 "v0.8+v0.9 compressed" | split again (user 10-06): **v0.8** bridge + device tokens + Android app as first client · **v0.9** bridge-first, no tailnet |
| WAVE 1, v1.0, v1.1 | unchanged, after v0.9 |

Background (never gates a release): voice-lab remainder/P3, edge Termux arm64,
yggdrasil lab (per playbook lesson), hardwar lab.

Cut from the ladder: native no-WSL Windows, VoxCPM2 in v1.0, labs in release
tables.

## Current — harden to v1.0

(v0.4.0 = the enthusiast release, cut 09-30 — see Release ladder)

- [x] Phone e2e pass (user, on the phone) — PASSED 09-30 in session test-hf:
  hands-free "worked as good as it could" (user, after hf-restart +
  ptt-flush + ptt-mic-release + ptt-mode-switch + send-lost + TTS-watchdog
  fixes); PTT + scroll confirmed earlier; suite 30/30 same day
- [x] Vercel deploy validated in isolated container (clean `npm ci && build`, smoke)
- [x] Release v0.1.0 (tag + GitHub release) only after all boxes above — tagged
  and published 09-26 with the hands-free human pass explicitly waived
  (phase-log.md); box above stays open for the full pass

## Human-only checks (cannot be automated on the desktop — run on the phone)

- [ ] Mic capture: PTT hold → speak → agent hears you (STT correct); keyboard
  mode drops the OS mic indicator
- [ ] Hands-free: VAD turn-taking feels natural; no echo loop from speaker→mic
- [ ] TTS quality/latency acceptable on real speaker (Mac MLX path)
- [ ] Backgrounded reply → notification actually arrives (Android battery rules)
- [ ] PWA install: browser menu → install → standalone launch, icon, theme
- [ ] Perceived voice round-trip latency < ~2s
- [ ] Attachments from phone: camera shot + gallery image + a .md file

## Deferred

- [ ] LiveKit on €3 OVH VPS (only `LIVEKIT_URL` + DNS/TLS change)
- [ ] One-button onboarding: VPS `bootstrap.sh` + QR pairing — spec draft at
  `docs/spec-onboard.md` (under review)
- [ ] Connectors — multi-harness: DEMOTED to evidence-triggered (09-28) —
  `skills/delegate/SKILL.md` covers claude/codex as sub-tools today; native
  integration waits for demonstrated demand. Spec kept at
  `docs/spec-connectors.md`
- [ ] Multi-user / public mode, SIP, video
- [ ] Dreaming — nightly memory consolidation + self-organizing agents, spec only
  (`docs/spec-dream.md`), starts at roadmap D1 after v1.0

## MEMORY FEDERATION DECIDED (10-06, user): Option A
Per-root wells + one small grove-shared layer (preferences, people, ongoing
topics). Deep archives stay local (sovereign, offline-resilient). The grove
layer = the trunk's presence directory + the small shared facts. "One voice"
= the small hot memory shared, the deep wells fetched on demand.

## v1.0 SEQUENCING RULES (Part 17, 10-06)
1. "Your LLM, your key" surfaces at v0.7 (the brain lands with the user's
   model + key — never deferred to v1.0).
2. Inside v1.0: the grove directory ships BEFORE the memory layer — a
   memory problem must never block routing.
3. The inflection test for v1.0: "put it on the tv" — and a different
   machine acts. If that sentence works, v1.0 is felt.
