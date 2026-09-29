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

## Release ladder (reconciled 09-27 after plan review)

- **v0.4.0 — enthusiast**: terminal users (omarchy/Arch/docker), with or
  without local models. Gates: hands-free human pass (after hf-restart claim
  closes), queue-e2e robustness (done), known-limits block in notes
  (include hf-restart if open), "what you need" list (1 box, docker,
  Node ≥22, LLM key, tailscale optional).
- **v1.0 — consumer** (the consumer release IS v1.0): gates = onboarding
  phase 2 (/pair QR, zero-typing; auth decision required), connectors
  phase 1–3 (process driver as real contract evidence), notification polish
  (Android battery docs).
- **bifrostd (Rust core port)**: NOT a roadmap item — an option triggered by
  evidence: contract survived connectors 1–3 unchanged + a concrete driver
  (bootstrap simplicity / small-VPS memory / onboarding pain). If TS stays
  adequate, defer indefinitely.

## Current — harden to v1.0

- [ ] Phone e2e pass (user, on the phone) — hands-free procedure (decided
  09-28, replaces "feels natural"): 5-min hands-free conversation at speaker
  volume 50% → (a) turn-taking commits within ~2.5s of each pause, (b) no
  echo/feedback loop, (c) TTS intelligible, (d) round-trip feels < 2s,
  (e) phase line shows sending→reply with no double-speak (hf-restart check),
  (f) keyboard mode drops the OS mic indicator. PTT + scroll already
  confirmed 09-26; waived for v0.1.0 (phase-log.md)
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
