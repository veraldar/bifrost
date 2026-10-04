# Roadmap proposal — v0.7 → v1.0 (planner session, 10-02)

Proposal only. `docs/plan.md` is untouched — the product session re-sequences
after user approval. Effort unit: **1d = one focused session-day** (build +
verify). Estimates are honest-median, not optimistic.

---

## Q1 — Windows one-click: when, and what ships

**Answer: a WSL2-first one-click ships in ~v0.8.0 (est. 3–5d of work after
v0.7). Native no-WSL Windows is a separate, harder gate — v1.x, experimental
flag at best in v0.8.**

Dependency-by-dependency (verified 10-02):

| dependency | status today | gap | effort |
|---|---|---|---|
| opencode on Windows | Native install EXISTS (choco/scoop/npm/binary) but official docs recommend **WSL** ("better performance, full compatibility"); v2 adds desktop app + IDE ext | We have never validated bifrost's REST surface (`opencode serve`) against opencode-on-Windows; native gaps unspecified upstream | WSL path: 0.5–1d validation. Native: 0.5–2d + unknown risk |
| Tailscale on Windows | First-class official client (MSI/winget, GUI) | ~zero; bootstrap must winget it + read the tailnet IP | 0.25d |
| Voice on Windows | **The docker-free path already exists**: `edge/voice_server.py` (sherpa-onnx, pip-only, CPU, exact API shapes the agent consumes) — 7/7 PASS on x86 Linux. sherpa-onnx ships Windows wheels | Windows validation run + model fetch script port (get_models.sh is bash) | 0.5–1d |
| LiveKit on Windows | Our compose uses docker. LiveKit server is a single Go binary (runs on Windows) | Either accept Docker Desktop for LiveKit only, or dev-binary path | 0.5–1d |
| bootstrap | `scripts/bootstrap.sh` is bash + systemd user units | PowerShell port (or WSL-only, where the existing script runs unchanged) | WSL-only: ~0d. Native PS port: 2–4d incl. service hosting (nssm/scheduled task) |
| Test hardware | — | **We need one real Windows box for the pass. User must provide/ designate.** | user |

**What v0.8 "one-click" ships with (WSL2-first):** one PowerShell command that
installs WSL2+Ubuntu, runs the existing bootstrap inside it, wingets Tailscale
on the Windows side, prints the pair QR. Stack: opencode (WSL), PWA + agent
(WSL), voice = edge CPU server (no docker required), LiveKit dev binary or
Docker Desktop, Tailscale native on Windows. Docker becomes optional, not
required — the edge server is the reason.

**What it does NOT ship with:** native-Windows agent (no WSL) — that needs the
PS bootstrap port + sherpa/systemd equivalents; schedule as v0.8-experimental
at best, honest "WSL recommended" line until then.

---

## Q2 — The TV scenario: what must exist, and where it sits

**"Install on the TV PC and ask bifrost to play a movie" = instance switcher
+ a media skill + TV-PC onboarding. The switcher is the real engineering
piece (vision.md verdict) — spec before building. It sits at v0.9.0, as the
centerpiece of the consumer ramp (v1.0 gate: onboarding phase 2 uses the same
pairing seam).**

Instance switcher — spec skeleton (to be formalized as `docs/spec-switcher.md`):

- **Model**: the PWA holds N *bridges*. A bridge = `{name, base_url, pairing
  credential, identity: accent color + tree glyph}`. Today the PWA is welded
  to its own origin's `/api/*` proxy; bridges make the backend a variable.
- **Transport**: phone → each bridge's own Next proxy (same-origin per bridge,
  preserving the "phone never talks to opencode directly" invariant), reached
  over Tailscale. No hub-and-spoke rewrite: one PWA, N origins, one session
  store keyed by bridge id.
- **Pairing**: reuse the spec-onboard `/pair` QR flow per bridge — scan once
  per PC, zero typing. This is why onboarding phase 2 and the switcher share
  a seam and should land in the same window.
- **UX**: home screen groups sessions under a bridge header; swipe the header
  (or a bridge rail) to change tree; per-bridge accent + glyph so you always
  know which PC you're talking to; voice room slug = `bridge/session`.
- **Non-goals v1 of the switcher**: bridging two PCs into ONE conversation;
  shared cross-bridge search; native push routing per bridge (later).

TV-specific extras (cheap once the switcher exists): the TV PC is just another
Yggdrasil PC; "play the movie" = a `skills/media/SKILL.md` driving mpv/mpv IPC
on the TV box + a voice-friendly permission profile (media commands
auto-allowed). Estimate: switcher spec 1d, build 3–5d, pairing seam 2–3d,
media skill + TV recipe 1–2d. **Total v0.9 window: 2–3 weeks.**

---

## Q3 — Labs inventory + status (verified on disk 10-02)

| lab | status | what it produced / will produce | feeds |
|---|---|---|---|
| **voice-lab** (`~/Work/voice-lab`) | **P1 baseline DONE + P2 first bench DONE** (results/*.json, findings written, engines live on Mac :8002). NOT finished: P2 CPU-box bench, FR corpus, streaming-STT probe; P3 winner-per-role + integration spec; P4 bifrost integration | Headline findings: free 4× first-audio win on prod voice (streaming_interval 4→0.5: 1.19s→0.19s, config change); Kokoro-82M fast path RTF 0.03; **measurable emotion control exists — VoxCPM2 NL prefixes move F0 130→275Hz EN+FR** (incumbent Qwen3: zero control, confirms user's "flat intonation" report); parakeet-v3 STT works (0.4–0.85s) | voice-quality tier for v0.7/v1.0; **voice-models.md data source**; edge CPU picks |
| **yggdrasil lab** | **TRIGGERED, not started on disk** — commit 64574a5 (10-01) plans `lab/yggdrasil/` (binary + ASSESSMENT.md); that dir does not exist in the repo; no claim line. Either running in a side workspace or stalled — needs a status ping from its session | Rust PoC of the opencode core loop, one static binary, driven by bifrost via OPENCODE_URL | evidence generator for the one-binary agent-core (v1.x "bifrostd"), zero product impact by design |
| **edge / bifrost-lite** (`edge/`) | **x86 DONE** (verify_edge 7/7; STT rtf 0.29 / TTS 0.26–0.37, CPU-only, env-only LOCAL=1). Remaining: spare-phone Termux run (arm64 RTF + battery) + fr-STT pick (sherpa 1.13 moonshine/qwen3 hooks) | The docker-not-required voice server — exactly what Windows/Linux-minimal installs need | Windows story (Q1); "runs on what you have" positioning; voice guide headless tier |
| **android-lab** | **RUNNING, unverified** — scripts/android-lab/ 01–04 exist (omarchy → ssh tunnel → Mac Studio AVD Chrome → live PWA); no `docs/android-lab.md`, no DONE claim, no evidence of a green consumer-flow run | The software proof of the consumer path (open → session → text round-trip, screenshots) | **v1.0 gate** (android-lab green is a named v1.0 box in plan.md) |
| **wedge-fix** (claim open) | **In flight** — event-driven liveness, error channel to phone, always-on SSE (files per claims.md) | Fixes the 09-30 15-min no-reply corpse | v0.7 reliability gate |

---

## Q4 — Voice model guide (`docs/guides/voice-models.md`)

**Plan: draft now from voice-lab data; publish only after P3 winners + a bifrost
A/B pass (user directive: try-ourselves-first). Lands with v0.8.** Provisional
table (all numbers measured, voice-lab findings 10-01; * = pending verification):

| tier | STT | TTS | notes |
|---|---|---|---|
| Mac (Apple Silicon) | Qwen3-ASR-1.7B-8bit — 0.56s, WER 3.7/2.3 EN/FR (*parakeet-v3 may beat it*) | Kokoro-82M fast path (0.08s first audio) + Qwen3 s0.5 identity voice (0.19s) + VoxCPM2 emotion tier* | best consumer tier; the quality story |
| Linux/Windows CPU, no docker | edge zipformer (0.68s, WER 6.4 EN; *FR pick open*) | piper (RTF 0.06, robotic but instant) | the default one-click tier |
| Linux CPU, docker ok | faster-whisper-small (5.5s wall, WER 6.4/12) | speaches Kokoro CPU (1.6–5.3s) | legacy fallback; guide should steer people OFF this |
| Headless mini-box (Pi-class) | edge sherpa int8 (*Termux/arm64 pending*) | piper | "bring your box" tier |
| Cloud API | any OpenAI-compatible STT | any OpenAI-compatible TTS | zero-hardware Tier-1 path (consumer decision tree) |

Guide structure: per-OS × per-tier pick table + "what you give up" column +
measurements appendix + update protocol (bench numbers must cite voice-lab
results). Draft 0.5d; verification pass (P3 + A/B) 2–3d.

---

## Q5 — Viral push calibration: push NOW (soft), keep the big cannon for v1.0

**Recommendation: run the launch checklist's techie push as soon as v0.7
ships (~1 week), framed as "enthusiast preview". Do NOT wait for Windows
one-click. Hold the full consumer narrative (YouTube arc, veraldar.org
announcement, "one-click any PC") for v1.0.**

Reasoning:
1. **The launch is already unblocked and overdue**: checklist Gate A is
   v0.4.0-tagged + hands-free human pass — both done (v0.6.0 shipped on top).
   Every week of silence is compounding-loss of the brand-rebuild momentum.
2. **The audiences are disjoint**: HN/r/LocalLLaMA/r/selfhosted are exactly
   the enthusiast audience the CURRENT release serves (docker+Node+terminal).
   Windows one-click serves the consumer audience — a different release, a
   different channel wave. Waiting couples two independent tracks for no gain.
3. **The agent-install skill is a HN hook today**: "paste one URL into your
   running agent, it installs bifrost" demos better to that crowd than a
   Windows button would — and it's shipped (cold-container validated, opencode
   + Claude Code harnesses).
4. **Evidence-triggered culture needs the demand signal**: connectors revival
   and the yggdrasil one-binary decision both wait on demonstrated demand;
   a techie launch IS the measurement instrument.
5. **Honest-friction mitigation is already built**: known-limits block,
   "what you need" list, takedown rule, results.md retro (checklist Gate C).
   HN grumbling about docker is survivable; a silent launch is not.
6. **Windows one-click becomes the SECOND wave**: "you asked, we built it" is
   a stronger post than "coming soon". results.md recurring-questions log
   tells us exactly what v0.8 must answer.

Cadence: wave 1 = techie preview at v0.7 (Show HN Tue–Thu 07:00–09:00 PT, X +
reddit stagger per checklist). Wave 2 = Windows one-click at v0.8 ("bifrost on
your Windows box, one command"). Wave 3 = consumer story at v1.0 (switcher +
TV + QR onboarding + Android proof). Only the user fires wave 1 (timing is a
taste/energy call, not an engineering one).

---

## Re-sequenced ladder (proposal)

| release | theme | contents | est. | hard deps |
|---|---|---|---|---|
| **v0.7.0** — "the reliable voice" | techie polish + the free voice win | wedge-fix (in flight), ux-mictap (in flight), voice P1 knobs (streaming_interval 0.5 + Kokoro fast path, A/B by ear), voice-lab P2 remainder (CPU bench, FR corpus, streaming STT), P3 winner spec, known-limits refresh | 5–8d | real-speaker A/B pass (user's ears) |
| **→ WAVE 1 launch** (techie preview) | per Q5 | checklist Gates B/C as written | 1–2d | v0.7 tag + user go |
| **v0.8.0** — "Windows doors" | WSL2-first one-click + voice guide | PS bootstrap (WSL path), edge voice on Windows, opencode-WSL validation, winget Tailscale, install docs + SKILL.md Windows notes, **voice-models.md published**, native-Windows stretch flag if the box allows | 3–5d (+3–5d native stretch) | **a real Windows test machine (user)** |
| **v0.9.0** — "many trees" | instance switcher + TV | switcher spec → build, per-bridge /pair pairing, media skill + TV recipe, onboarding phase 2 (QR zero-typing — same seam), notification polish | 2–3 weeks | switcher spec user sign-off; TV PC hardware choice (user) |
| **v1.0 — consumer** | the promise kept | android-lab green (gate), voice emotion tier (VoxCPM2 behind flag) if A/B survives, voice guide refresh, consumer decision-tree wiring (Tier 1 cloud / Tier 2 sovereign), full launch wave 3 | 2–3 weeks | v0.9 switcher; android-lab session finish |
| background labs (not release-gating) | — | yggdrasil lab (status ping → run → ASSESSMENT.md); edge Termux arm64 run; dreaming (post-v1 per plan) | drip | yggdrasil needs its session found/restarted |

Sequencing logic: reliability (v0.7) before attention (wave 1); Windows (v0.8)
before switcher (v0.9) because Windows is smaller, unblocks a whole OS, and
generates wave-2 material; the switcher is the biggest new surface and shares
its pairing seam with onboarding phase 2, so they land together in v0.9;
v1.0 then only has gates left, no new engineering.

## Only the user can decide

1. **Fire wave 1 now-at-v0.7 vs wait for v0.8** (rec: now; timing/energy call).
2. **Windows-first vs switcher-first** (rec: Windows first — smaller, wave-2
   material; swapping is fine if the TV demo matters more socially).
3. **Native no-WSL Windows commitment** (rec: experimental flag only, honest
   WSL-recommended line; full native post-v1.0).
4. **Voice taste call**: stability-first (Qwen3 s0.5 + Kokoro) vs emotion tier
   (VoxCPM2, looser identity — 35.6Hz spread vs 8.8Hz) after the A/B.
5. **Hardware**: a Windows test box for v0.8; which PC is the TV PC + its media
   stack (mpv assumed) for v0.9; the spare phone for the edge Termux run.
6. **yggdrasil lab**: confirm whether its session is actually running (no
   deliverables on disk 24h after trigger) or restart it.
7. **Voice guide publish timing** (rec: with v0.8, after P3 + A/B).
