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

## THE CONSENT EVOLUTION (10-06, user-discovered in production)
Two independent stacks (live vX / sandbox vY), each with its own brain.
When one fails the other stands. The new version proves itself in the
sandbox while the old serves; the USER consents when to move; the flip is
one restart. Proven 10-06: live brain down -> user's [MAIN] session ran on
the root (:4100) via :8443 -> worked. Deploy law: never all-at-once; the
sandbox is the rehearsal, the consent is the gate.

## v0.7 GATE — what must pass before v0.8 (10-07)
OWNER: the sim lab implements + validates (Rule 10-08: the shipping binary,
the phone device class). The user tests LAST — the 2-min confirmation only.
1. onboarding v3: load fast, tap fast, prerecorded greeting <300ms, clean
   flow into the deck (e2e running now: e2e-base/voiceui/wedge)
2. voice round-trip: hotword fix verified ("Bifrost" clean at utterance start)
3. echo bleed fixed: the mic no longer transcribes the TTS playback
4. stability: **ACCELERATED churn proof in simulation (user law 10-07:
   only simulation is proof; if sim can't prove it, sim improves — never
   the user's burden).** Compress the 24h-equivalent into minutes: N
   reconnects, N rekeys, upstream kills mid-turn, queue deaths, memory
   soak over the turn volume — the churn suite. Wall-clock waiting
   deleted. The user's test = the consent confirmation, never evidence.
5. session lifecycle on the root: create, list, switch, artifacts save
6. version string: 0.7.0-x displayed on the sandbox
7. room→session mapping: voice tests do not pollute [MAIN]
8. the dispatcher: queued REST turns actually run + reply (proven queued,
   end-to-end pending)
THE ORDER: e2e green → sim-lab phone-class suite → receipts to the
coordinator → user confirmation test → the URD row → v0.8 starts.

## ALIGNMENT 10-27: adopted from the root's MAIN session (validated together)
- Rule 10-27 + scripts/drift-guard.sh (9d3daa8): cross-line parity — the
  10-02 mic fixes + the dialects theme never reached the v0.7 fork ("fixed,
  came back"). The guard inventories class-fixes across product worktrees.
- The user ADOPTED all four fork-gap measures (root's proposition, req 10-27):
  A fork manifest (docs/lines/<line>.md at fork time) · B merge cadence ≤3
  days on product lines · C commit-fixes-same-day on live-serving lines ·
  D drift-guard = a blocking ship step. The root writes these as fleet rule
  10-28 on the user's go.
- UX: the decorative mic glyph removed from the roots row; the footer
  teaching line retired (d02e965, rebuilt, restarted).
- FOLD INTO S2 TRUNK-MERGE: the merge brief cites 10-27/10-28 + runs
  drift-guard as a blocking step; S1's test gaps include the fork-gap class.

## RELEASE + REFLECTION NOTES (10-27, user)
1. MAC-TOOLS CAUTION (feeds S9 MAC-REVIEW): the Mac tools (Letters, Project,
   skid workers, Flow) help AI sessions manage background work — but may
   impose LIMITATIONS on AGI we cannot see from here. S9's brief adds the
   limitations audit: what does each tool PREVENT or constrain (the cost
   side), not only what it enables.
2. THE MULTI-ROOT REFLECTION placement: Q8 (the grove lanes, the third
   identity lane) gets its essence placed in docs/veraldar-doctrine.md —
   the sap that syncs to the Mac (workspace-thor/theway/) — so every root
   shares the same inter-root model before any root builds one.
3. RELEASE TIMELINE (v0.7 ready → live): user's 3 rulings → S3+S1 waves
   (~1-2 d) → S2 trunk merge (~0.5 d) → freeze v0.7.0-rc1 → user consent
   check → soak (72h or 7d) → PROMOTE: GitHub latest + veraldar.org updated
   same day → v0.8 opens (the bridge + the tokens + the APK). Fastest:
   ~5-6 days from the rulings; 7d soak: ~10 days.

## THE USER RETURNS (10-29, after 2w away) — concerns → the retrospective wave
LAWS ADDED:
1. MAJORS PARALLEL: every major version runs as its own root//stack,
   reachable, communicating when needed; the majors' // = the trend
   instrument. :443 returns to THE STABLE (v0.6 + opencode); v0.7 gets its
   own port/URL; the next major the next port — promoted only when the
   user validates (the coordinator profiles, the LLM management, the
   extensions).
2. AWAY-MODE: the system must keep working + self-driving while the user
   cannot access from the phone. The holiday proved the waves die without
   a driver — the self-driving loop (the scheduler, the chain) is
   mandatory, not optional.
3. STORY COHERENCE: veraldar.org (the org + Yggdrasil + root-trunk-branch)
   vs GitHub (stale 3w, 10-10 last commit) vs omarchy (the mess) — one
   story everywhere; the GitHub sync + the docs archive (the useless
  堆积 → archived); the install story (a root install easily + the trunk
   webrtc ready) must exist or be honestly parked.
4. THE MAC EXTENSIONS: the scheduled agent-call flows + the project-follow
   (the global context) — wanted; the Mac access STILL refused (the Remote
   Login off 2w+). The user asks what access is needed.
WAVE DISPATCHED: the RETROSPECTIVE (sonnet 5.5, deep-dive, all of the above
+ the holiday retrospective + what-stopped-why + the fix plan + the trend
instrument).

## THE TREE IS THE SURFACE (user law 10-29)
No external alert channels (no ntfy/email/telegram). The user listens
through the TREE: the root talks to the trunk, the trunk to the branch,
the phone sees everything. Several roots = the resilience, more roots
later. All failure surfaces = the tree's own (the routes, the sessions,
the error turns). The alert-channel question is DROPED.

## OLLAMA FALLBACK — the one user step (10-29)
The provider wave is done; the root runs 885122c with the provider
catalog + the fallback chain + the error visibility. OLLAMA is not on
omarchy (the install needs the user's sudo). THE ONE STEP (copy for the
user):
  sudo pacman -S --noconfirm ollama && sudo systemctl enable --now ollama
  ollama pull qwen3:8b
Then the coordinator adds the ollama provider to the root's config and
e2e-tests the fallback (the quota stop → the fallback answers). Until
then the tree runs on zai alone with the honest banner on any stop.

## THE THREE MAJOR RINGS (10-29, live)
| ring | URL | version | brain |
|---|---|---|---|
| the STABLE | https://omarchy.tail5435b1.ts.net:8445 | v0.6.1 | opencode :4096 |
| the CURRENT | https://omarchy.tail5435b1.ts.net (:443) | v0.7.0-rc2 | the root :4100 |
| the NEXT | https://omarchy.tail5435b1.ts.net:8443 | the dev line | the root (the clone) |
The user validates on :443 (the provider + the session coordination) BEFORE
any v0.8 testing. The v0.6 ring: always reachable, the emergency door.
