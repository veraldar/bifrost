# Comms — channel strategy + 90-day calendar

COMMS session, 2026-10-02, synced to the adopted ladder (state sync 10-02).
Law: `docs/brand/` (brand.md incl. the new map + manifesto, narration.md) +
the shipped finish (`pwa/styles/brand.css`, veraldar.org). We never invent
identity; we express it.

State of the world this calendar is keyed to:

- **Shipped (v0.6.0, repo now `veraldar/bifrost`)**: cohesive brand rebuild —
  signal rail, ygg tree component, line icons, state law, BIFROST caps copy;
  plus delegation skill (claude/codex from any session), settings page,
  themes (aether/terminus/drift), sub-sessions, input recall, 1.2x voice
  speed, female voice verified live. Security S2 (pinned tags + SECURITY.md)
  and S3 (`BIFROST_AUTH=tailnet`) done; secrets chmod 600.
- **Ladder (CONDITIONAL GO, AGI-reviewed — `docs/reviews/agi-roadmap-review.md`)**:
  pre-wave → v0.7.0 the reliable voice (edge sherpa = Linux default) →
  **WAVE 1 techie launch** (hook-first Show HN + cold-start video + 5–10
  seeded testers; the user fires it) → v0.8.0 federation + layman onboarding
  (iPhone auto-setup, /pair QR, device tokens S1) → v0.9 Windows WSL →
  v1.0 consumer (girlfriend-iPhone gate) → v1.1 federation deepen.
- **Pivots that change comms**: federation over switching (the instance
  switcher slot dies); **the tree is the door** (see below); ship as Bifrost
  only (Yggdrasil stays internal); veraldar.org stays a stub until post-v1.0
  — except the world-tree data page.

## The tree is the door — the launch narrative

The public story Wave 1 tells, woven through every draft (source:
`docs/vision.md` + the pivot):

> One phone. One network. Many trees. The door is a tree: on veraldar.org
> you hold the tree and start talking — and it hands you a personalized
> install. On the phone, the tree is the first screen.

Rules for using it honestly:

- The tree door is **the narrative frame now, the shipped interaction at
  v0.8.0** (layman onboarding). Until then every use is labeled *growing*.
  The techie Wave 1 audience gets it as the roadmap reveal, not as a
  feature claim.
- The door wording is **`hold to start`** (user pick, `docs/comms/drafts/
  site/hold-to-start-wording.md` option 1) — the website session owns the
  build; comms drafts echo those words exactly once shipped.
- Launch hooks read like: "hold the tree to start" / "the door is a tree" —
  one line, then the demo proves the bridge works today.

Standing hard rules, unchanged:

1. **Draft only.** Nothing publishes from here; the user publishes through
   his own accounts. No account access, no scheduling, no auto-posting.
   **Blocked = visible** (`docs/lab-playbook.md`): when a draft or slot is
   blocked, the blocker is named in the draft queue, never silently dormant.
2. **Wave 1 is the LAUNCH session's day 0** (hook-first Show HN + cold-start
   video + seeded testers). We never edit their files. Our drumbeat starts
   on their baton: `docs/launch/retro.md`.
3. **Honest tone always.** Limits in the same breath as the claim. Anything
   not shipped is labeled **growing** (federation, layman onboarding, the
   tree door, one-click core, the warden). Ship as **Bifrost** — Yggdrasil
   is internal naming, never a public product name.

## Why we communicate

The techie release is invisible without distribution: good code with no
signal gets no users; no users means no contributors, no funding, no org.
Comms has one job: **distribute truth.** Honest build-logs and demos are the
trust engine — they compound; hype decays. Trust is the asset funding and
contributors follow.

## How it works

- COMMS drafts; the **user publishes through his own accounts**.
- Channel map, by job:
  - **Show HN + Reddit** — the launch moment (Wave 1, user fires).
  - **YouTube** — demos and build-logs; the proof library.
  - **veraldar.org** — the always-on trust layer (stub: one-liner, lore,
    limits, AGPL, install link, world-tree page). No deep site work until
    post-v1.0.
- **The drumbeat = one honest artifact per release.** Every tagged release
  yields exactly one artifact (demo Short, build-log, or release-post
  angle). No artifact, no promo slot.

## Canonical honest-limits boilerplate

Paste at the bottom of every video description, Reddit post, and X thread
(re-check facts per release; v0.7.0 changes the speech line):

```
limits, stated: one linux box per tree, docker, node ≥ 22, your own llm key —
the one manual step (`opencode auth login`; nothing mints that for you).
speech runs on local models (sherpa edge on linux; MLX mac as the quality
path); the coding model is yours. everything travels the roots —
tailnet-only, auth-checked, nothing public. push-to-talk is the
battle-tested mode; hands-free passed its human pass. today: opencode as the
core, one bridge per box; claude/codex work as sub-tools through the delegate
skill. federation and layman onboarding (the tree door) are growing.
AGPL-3.0, free for everyone.
```

(Pre-v0.7.0 drafts say "faster-whisper + Kokoro in the compose" instead of
the sherpa line — the fact must match the tag being posted under.)

Cross-cutting: never claim "local LLM" — local *speech*, user's LLM. Never
argue "better model" — there is no model of ours. Never cross-post identical
text. One person, one account, always the user's.

---

## Channel 0 — veraldar.org (the always-on trust layer — stub)

Every channel points back here. It stays a **stub until post-v1.0** (user
decision): one-liner, lore, limits, AGPL, install link, plus the world-tree
data page. Boring on purpose: a stranger clicking through from HN, Reddit,
X, or a description always finds the same current facts.

- The tree door (hold-to-start vocal onboarding that hands a personalized
  install) is **growing — v0.8.0 scope**. Public copy mentions it only as
  the roadmap reveal.
- **No comment section — by design.** No identity system, no moderation
  load, no GDPR surface we don't need. The site points to the repo.
- SWISS MADE wording: on hold — see the swiss-made section. No origin claim
  on this site until the ORG session signs off.

## Comment routing (where the public talks back)

- **GitHub Issues** — live on `veraldar/bifrost`; the bug/feature lane.
  Every post and description points here for problems.
- **GitHub Discussions** — the conversation lane (Q&A, show-and-tell,
  ideas). Enabling in progress (user). Until that box is ticked, drafts
  route questions to Issues — never promise a lane that does not exist.
- **veraldar.org points to Discussions, hosts none.** One footer/about
  link; Issues until Discussions is enabled.
- No surface promises response times: "issues are read; discussion lives in
  the repo."

---

## Channel 1 — YouTube (primary)

Home video channel. Voice: the brand voice — terse, honest, terminal-native.
Flagship pieces: the movie (`docs/brand/narration.md`, words complete) and
the Wave-1 cold-start video (LAUNCH session owns the cut; our walkthrough
series extends it).

**Identity rules** (shipped signal-path finish, `brand.css`):

- Square 1px hairlines, no rounded chrome, line icons (never pixel art —
  the hybrid auto-fails), circuit-tree line work, lowercase `## ` chapter
  heads in descriptions. Palettes from tokens only (aether default;
  terminus corner ticks / drift dotted rules as world accents).
- State-color law — green alive · amber heard · red stop · sky info. Color
  only when it means that; thumbnails get one meaningful accent max.
- Wordmark: in-app form **BIFROST** (caps, Commit Mono, letterspaced);
  brand surfaces `veraldar▮` + "a Veraldar product." End cards end on the
  manifesto or on facts, never on a logo.
- Thumbnails: aether bg, square hairline frame, mono text, readable at
  120px. No faces, no arrows, no pixel art, no rainbow, no gradients.
- Captions burned in. Music: none or lo-fi. Hard cuts. Screen recordings
  never add motion the product doesn't have.

**Formats:**

| Format | Length | Cadence | Purpose |
|---|---|---|---|
| Feature demo | 3–6 min | ~every 3 weeks | one shipped thing, phone ⇄ box on screen |
| Build-log | 8–15 min | ~every 3 weeks | one real bug, decision, or review, told honestly |
| Self-hosting walkthrough | 15–25 min | ~monthly | zero-to-working-room on camera, every friction timed |
| The movie | 75–90s | once, re-cut per release | the structural story — narration.md verbatim |
| Shorts | 30–60s | 1–2 per long video | the demo moments |

**Series:**

1. **Feature demos** — "bifrost demo: <thing>". Real box, real tailnet; if
   STT mishears, keep it, captions carry intent. Shipped material queue:
   the voice tuned (1.2x speed, female voice verified live), input recall,
   sub-sessions swipe + mercy window, delegate skill, settings, worlds.
2. **Build-logs** — every episode a bug that shipped, a decision we can
   defend, or a review we published: hf-restart, ptt-flush, send-lost, the
   wedge, the on-device voice spike, and **"we had the roadmap reviewed by
   two AIs — conditional go"** (`docs/reviews/agi-roadmap-review.md`; what
   they flagged, what we changed).
3. **Self-hosting walkthroughs** — "bifrost from scratch, part N". Bare box
   → working room with a stopwatch. Part 4 candidate at v0.9: Windows WSL.

Video #1 = the Wave-1 launch set (30s demo + cold-start video, LAUNCH
session's `demo-script.md` + hook), uploaded by the user launch week.
Video #2 = the movie.

---

## Channel 2 — Reddit (beyond launch week)

Wave 1 belongs to the LAUNCH session. After that: **helpful presence, not
spam.**

**Ratio law: ten helpful comments per one project mention.** Mentions only
when the thread asks for exactly this. No drive-by links, no alts, no vote
coordination.

| Sub | Our genuine expertise there | Standing comments |
|---|---|---|
| r/LocalLLaMA | local speech: sherpa/whisper RTFs, MLX Qwen3 ASR/TTS latency, CPU fallback in the compose; speech-local vs LLM-local | RTF numbers on request, compose pointers, the "local LLM" correction |
| r/selfhosted | docker compose + systemd user units, reboots self-heal, the proxy seam, tailnet-only + auth posture, pinned tags | compose patterns, honest limits |
| r/omarchy | it runs on omarchy and wears the signal-path look | desktop/tooling talk first, project only when asked |

Self-posts: only on tagged releases, max one per sub per quarter, own angle
+ honest-limits block. At drumbeat start v0.7.0 is fresh — the first release
post leads with the reliable-voice landing, not back-filled tags.

---

## Channel 3 — X

3–4 posts/week, brand voice throughout (lowercase, no emoji, no exclamation
marks):

- 1 clip post (the week's Short; vertical, captions burned in)
- 1 terminal still (a real diff, status line, or timing)
- 1 build-note on landings, release-notes register
- replies: answer self-host/voice/local-speech questions with experience;
  link only when asked

Max 5 tweets/thread. No engagement bait. The manifesto closes things
(movie, trailer, pinned profile) — it does not pad posts.

---

## Channel 4 — merch (CONCEPTS ONLY)

**Gate: no production, no orders, no store until the user declares an
audience exists.** Concepts express the shipped identity; ship as Bifrost
only — no Yggdrasil product branding anywhere.

| # | Concept | Design | Print notes |
|---|---|---|---|
| 1 | wordmark tee | **BIFROST** caps, Commit Mono, letterspaced, chest print; hem label `veraldar▮` | 1 spot color (bone on near-black; aether palette), square, front only |
| 2 | state-law tee | four lines, each in its role color: `green = alive. amber = heard. red = stop. sky = info.` | 4 spot colors on black; no other ink |
| 3 | line-work sticker set | circuit-tree + the runestone artifact glyph, die-cut | 1-color vinyl, line work only, square terminals |

Never: rainbow anything, bridge illustrations, gradients, mascot merch (the
warden is not shipped — no name, no asset), any wording from the forbidden
list.

---

## 90-day calendar

Day 0 = **Wave 1 techie launch** (pre-wave + v0.7.0 done first; the user
fires it). Weeks from day 0. Conditional slots ⏻ fire when their trigger
lands. Every long video ships 1–2 Shorts cuts + the honest-limits
boilerplate. Reddit standing: 3 helpful comments/week unless a release post
replaces the slot. X: 3–4 posts/week throughout.

| Week | YouTube | Reddit (beyond standing) | Milestones |
|---|---|---|---|
| 1 | — launch week: LAUNCH runs Wave 1 (hook-first Show HN + cold-start video + 30s demo + 5–10 seeded testers); user uploads the launch set as video #1 | — LAUNCH posts day 0; we watch, draft, touch nothing; log seeded-tester questions | baton: their `retro.md`; metrics file opens |
| 2 | Feature demo 01 — "bifrost demo: the voice" (1.2x speed, female voice, a full hands-free minute; misheard turn included) | begin helpful presence: first 3 comments, zero links | our drumbeat starts |
| 3 | **The movie** — narration.md verbatim; visuals from the shipped PWA + veraldar.org + terminal; manifesto closes. The tree-door line lands as the roadmap reveal | — | channel trailer = movie cut, `veraldar▮` end card |
| 4 | Build-log 01 — "we had the roadmap reviewed by two AIs" (conditional go: what they flagged, what changed) | r/selfhosted comment push | — |
| 5 | Release post support — v0.7.0 "the reliable voice" (sherpa edge as Linux default; RTFs on screen) | release post: r/LocalLLaMA angle (sherpa RTF + local speech) | ⏻ v0.7.0 tag; Short: 30s RTF demo |
| 6 | Feature demo 02 — "bifrost demo: the delegate skill" (claude/codex as sub-tools, real delegation, real output) | — | — |
| 7 | Build-log 02 — "the mic that wouldn't stop listening" (hf-restart story) | r/LocalLLaMA comment push: RTF numbers in thread | — |
| 8 | Walkthrough 01 — "bifrost from scratch, part 1: the box" (omarchy → docker → systemd, stopwatch on) | r/selfhosted comment push | — |
| 9 | Feature demo 03 — "bifrost demo: input recall + sub-sessions" (swipe, mercy window, recall) | release post slot: r/selfhosted angle (auth posture + pinned tags) | — |
| 10 | Build-log 03 — "the fifteen-minute silence" (the wedge story → event-driven liveness) | r/omarchy presence week | — |
| 11 | Walkthrough 02 — "part 2: speech on a cpu-only box" (compose fallback vs sherpa edge; MLX as quality path) | — | — |
| 12 | ⏻ Feature demo 04 — "bifrost demo: the tree door" (hold to start → personalized install) when v0.8.0 lands; else worlds demo + "what's growing" honest segment | ⏻ v0.8.0 release posts: federation + onboarding (r/selfhosted); tree-door Short | ⏻ v0.8.0 = federation + layman onboarding (iPhone auto-setup, /pair QR, S1) |
| 13 | Retro — "90 days, honest numbers" (stars, clones, watch time, what broke; no vanity rounding) | — | calendar v2 from metrics; v0.9 WSL walkthrough queued as part 3; v1.0 watch (girlfriend-iPhone gate) begins |

Standing rows (every week, not in the table): 3 helpful Reddit comments ·
3–4 X posts · drafts land in `docs/comms/drafts/` · weekly metrics update ·
blocked slots named visibly in the draft queue.

---

## Draft queue + metrics

- **Drafts:** `docs/comms/drafts/<channel>/<slug>.md`. Header: `DRAFT —
  publish: user's <platform> account — suggested window: <week>`. Statuses:
  `draft → final-read → handed to user`. Published links + timestamps log
  to `docs/comms/results.md` (launch week's live in their
  `docs/launch/results.md`).
- **Next drafts in order**: launch-narrative brief (tree-is-the-door, one
  page for the LAUNCH session to pull from — we never edit their files) →
  FD-01 voice script → movie shot list (narration.md scenes 0–6) →
  roadmap-review build-log outline → v0.7.0 release-post angles.
- **Metrics:** `docs/comms/metrics.md`, weekly: stars/clones/contributors,
  YouTube subs + demo watch time, Reddit comment karma, seeded-tester
  questions. Raw numbers, no rounding. Day-90 retro reads it and writes
  calendar v2.
- **Takedown rule:** a serious install-breaking bug mid-drumbeat pulls the
  affected week's promo slot; correction on X + affected Reddit thread ≤1h.

## Open questions (filed in `docs/open-questions.md`)

- YouTube handle/channel name: `bifrost` vs `veraldar` — user decides at
  account creation.
- Merch production gate threshold — user call, pre-v1.0.
- Movie visuals: narration.md scene art — minimal keyed footage vs animated
  tree cuts; needs the user's eye on a first cut.
- SWISS MADE on veraldar.org — research done (section below); ORG session
  owns the decision; until then "the maintainer builds in Switzerland",
  nothing more.
- Seeded testers (Wave 1): do they get a private feedback channel (repo
  discussions vs a pinned issue)? Affects what we promise publicly.

## Should the site say SWISS MADE? — research + recommendation

(user question 10-02. Research here; the legal call is the ORG session's.
Nothing goes on veraldar.org until they sign off.)

The label (`swissmadesoftware.org`; MSchG SR 232.11 art. 48–48d):

1. **≥ 60% of production costs in Switzerland** — for software,
   essentially professional salaries. Gray zone: whether AI API spend
   counts as tooling or production cost is untested.
2. **Most significant part of development in Switzerland** — plausibly met.
3. **Company based in Switzerland AND registered in the commercial
   register** — not met yet (no registered entity; Verein trigger-gated,
   ORG dormant).

The label additionally requires membership + approval (Level 1: CHF 120/yr;
locked logo, backlink required). Misusing the "swiss made" description is a
punishable offense (MSchG art. 61) — the words alone are regulated. Separate
labels: *swiss hosting*, *swiss digital services*, "plus AI" (unreviewed).

Veraldar specifics: dev in CH plausible ✓ · 60% undocumented · no registered
entity ✗ · hosting claim inapplicable to a self-hosted product (veraldar.org
on Infomaniak could carry *swiss hosting* later if wanted).

**Recommendation: not yet.** Hold the claim until (a) a CH entity is in the
commercial register, (b) the 60% calc is documented, (c) Level 1 is
approved. Until then: "the maintainer builds in Switzerland" — a fact about
a person, not a product-origin claim.
