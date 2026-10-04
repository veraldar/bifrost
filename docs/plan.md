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

## Release ladder — ADOPTED 10-02 (AGI review, user "adopt")

Source: docs/reviews/agi-roadmap-review.md. Security debts S1–S3 defined there.

| release | theme | contents |
|---|---|---|
| **pre-wave** (2-3d, blocks launch, no code) | unblock | repo rename `veraldar/bifrost` + skill URL pinned to tag; launch/comms docs rewritten against v0.6/v0.7 reality; plan.md = single ladder source; SECURITY.md + threat model; brand rework lands (freezes lift); funding links delivered via artifacts when accounts exist |
| **v0.7.0** (3-5d) | "the reliable voice" (earned) | wedge-fix, ux-mictap, streaming_interval knob, **edge sherpa voice = Linux default (no docker)**, known-limits refresh incl. iOS line, S3 fix (BIFROST_AUTH=tailnet) |
| **WAVE 1** (1 week, user fires) | techie preview | Show HN day 0 (hook-first title + timed cold-start video, CPU path, cheap box); X passive same day; r/LocalLLaMA +2d; r/selfhosted +4d; r/omarchy loose; 5-10 seeded cold testers before day 0 |
| **v0.9.0** (USER: v0.8+v0.9 compressed — one arc, one release, done when tested on this machine) | no-tailscale direct pairing | device tokens (S1 full semantics) + WebRTC transport (P2P first, bifrost-net relay fallback) + /pair QR + iPhone auto-setup — tokens built FIRST inside the arc (transport security depends on them); no separate v0.8 release |
| **v1.0** (1-2 weeks) | the promise kept | consumer decision tree wired (Tier 1 cloud / Tier 2 sovereign), veraldar.org one-pager + video #1, wave 3 launch — **layman validation: the girlfriend-iPhone test passed** |
| **v1.1** (evidence-triggered) | many trees | federation/peering deepen (TV/media skill, per-bridge identity) — v0.8 federation is the base |

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
