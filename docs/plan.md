# Plan — bifrost

Single source of truth for status and next work. Decisions & incidents: `journal.md`.
Checklist = board. A phase done = all boxes checked.

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

## Current — harden to v1.0

- [ ] Phone e2e pass (user, on the phone): voice round-trip, busy→notify, mic
  release, scroll feel, ⚙ tool lines visible — PTT + scroll confirmed by user
  09-26; hands-free human pass still pending (suite 19/19 green covers it
  automatically; waived for v0.1.0, see phase-log.md)
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
- [ ] Connectors — multi-harness: per-session/global harness choice
  (opencode | claude-code | copilot), spec at `docs/spec-connectors.md`
  (phased: interface refactor → global+per-session UI → claude-code →
  copilot → voice)
- [ ] Multi-user / public mode, SIP, video
- [ ] Dreaming — nightly memory consolidation + self-organizing agents, spec only
  (`docs/spec-dream.md`), starts at roadmap D1 after v1.0
