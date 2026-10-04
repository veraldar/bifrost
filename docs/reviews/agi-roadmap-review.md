# AGI roadmap review — bifrost

Reviewer: opencode (GLM), outside-AGI critique pass, 10-02. Inputs: plan.md,
vision.md, roadmap-proposal.md, launch/* (positioning, channels, checklist),
brand/brand.md, comms/channels.md, README.md — plus the repo itself: claims.md,
git history (145 commits / 9 days / 8 tags), every `/api/*` route, bootstrap,
backup, install skill, systemd units, live tailscale/docker state. Deep
critique delegated to Claude Code (Opus): full text in
`docs/reviews/opus-critique.md` (same dir). This file = Opus + my verdict +
revised ladder + SECURITY + GAPS + USER DECISIONS + COSTS.

Headline: **the plan is internally rigorous and externally untested, and the
launch is blocked by stale docs and two security debts, not by code.** The
architecture is right for one user and unsafe for the next hundred until the
seam gets a name and a token.

---

## Part 1 — the five questions (Opus verdict → my verdict)

### 1. SEQUENCING

**Opus:** right shape, wrong ends. v0.7 is padded with research (voice-lab
P2/P3) dressed as polish; the default no-Mac path is 7–10s/turn per our own
voice-models table, which fails our own <2s gate — so the edge sherpa server
(parked in v0.8 as a *Windows* feature) must become the **Linux default in
v0.7**. v0.9 must not gate v1.0: QR pairing + android-lab green are the
consumer gate; the switcher is v1.1, evidence-triggered. Cut native-Windows,
VoxCPM2-in-v1.0, and all labs from the release table.

**My verdict: AGREE, ~90%.** The edge-to-v0.7 catch is the sharpest line in
the whole review — our own measured numbers contradict our own release theme
("the reliable voice") on the path strangers will actually run. Two
amendments:

- Keep the **switcher *spec*** (1d, roadmap-proposal already sketched it) in
  the v0.9 window even if the build moves to v1.1 — it is the only feature
  that makes the vision literal ("one phone, many trees"), and spec-now means
  v1.1 starts the day v1.0 ships.
- Opus missed a dependency: **the brand-freeze order** (comms/channels.md)
  HELDs every launch word until the brand rework lands in docs/brand/. The
  rework is not a line in the ladder. It must be, or wave 1 has no copy.

### 2. GO-TO-WORLD

**Opus:** channel mix fine; highest-leverage move is a **single unedited,
timed, cold-start recording** of "paste link → agent installs → phone talks
back" on the CPU path on a cheap box — the install-by-agent claim is the hook
and the thing HN won't believe. Retitle Show HN around the hook, not the
product name. Launch docs are stale (gated on v0.4.0; "hands-free fresh off a
fix" — v0.6.0 shipped and the pass passed). One primary channel per day, not
five in two hours. Seed 5–10 cold testers before day 0.

**My verdict: AGREE, and I rank the cold-start video the single
highest-leverage move** — it doubles as the trust asset, the HN first-comment
link, and the YouTube #1. My additions:

- veraldar.org at launch: **no.** The README is the trust layer until
  stars/clones exist; the site rides the brand rework and lands with v1.0.
  (Positioning doc already treats the repo as the surface.)
- The stale-docs problem is worse than Opus says: **three planning docs
  disagree on what v1.0 contains** (plan.md: QR + android; roadmap-proposal:
  + switcher + TV; comms calendar: QR + android with a v0.5.0 slot). plan.md
  must become the single source the others reference, or a solo-fleet ships
  contradictory public claims.
- r/omarchy is not a launch channel, it is a homecoming drink — keep it
  whenever, low stakes.

### 3. BRANDING

**Opus:** complexity tax. Ship "bifrost" only; "a Veraldar product" in the
footer at most; no Yggdrasil in the README (the core is opencode — calling it
Yggdrasil is false-ish); lore to docs/lore.md; manifesto off the landing;
rename the repo to `veraldar/bifrost` **before** wave 1 because renaming
after breaks every pasted install line; no veraldar.org at launch.

**My verdict: AGREE on substance, one pushback on tone.** The three-name map
is a strength *as an internal naming law and a future catalog* and a tax
*as launch copy* — the brand book itself confines Midgard/Asgard to lore-copy,
which concedes the point. Ship bifrost. But don't delete the lore: park it in
`docs/lore.md` + the narration script, linked once from a footer. The
manifesto ("What AI can simulate, AI can create.") belongs in the movie's
closing line, not an HN post. The loyalty clause is law for how we build, not
copy for what we launch — `PRINCIPLES.md` if surfaced at all.

### 4. EASE-OF-USE — where the first 100 stumble

Opus's ordered list, which I adopt in full: (1) CPU voice latency — kills
silently; edge as default + show measured RTT in the PWA header. (2) Tailscale
HTTPS + mic — MagicDNS/HTTPS admin-console detour; fix = install skill
detects and prints the exact admin URL + a `/selfcheck` page (mic, ICE,
tailnet reach) run from the phone. (3) hand-edited livekit.yaml ICE — skill
writes it; PWA shows "ICE failed: <reason>", not a spinner. (4) install-skill
runs on whatever model the user has — make it call one deterministic
`bootstrap.sh --check` and trust the exit code. (5) `opencode auth login`
ordering. (6) hands-free defaults — PTT default, hands-free opt-in. (7) manual
README path is five terminals — collapse to bootstrap. (8) docker wording
once edge ships.

**My additions from walking the code:**

- **Node ≥22 silent-CSS death** is already in the skill (good) but not in the
  README manual path — a `node --version` check belongs in
  `selfhost-check.sh`.
- **iOS is the unpriced platform**: PWA + web push on iOS require
  install-to-home-screen and degrade (no background push pre-install; mic
  quirks). First-100 includes iPhone owners. One honest known-limits line:
  "Android is the proven phone; iOS works but is second-class."
- The PWA currently opens every session in keyboard mode with a
  250–400ms tap-threshold mic — that fix (tap-threshold, 10-02) must ride
  v0.7; the "single click does nothing" trap is exactly the kind of thing
  100 strangers will hit 100 times.

### 5. BLIND SPOTS

**Opus:** the paste-a-URL install is a prompt-injection/supply-chain pattern
that HN's top comment will name within the hour (mutable `main`, runs shell,
no pin); tailnet = everyone on it (stolen phone = shell on the dev box); solo
maintainer support load with no `bifrost doctor`, no issue templates; metrics
measure attention, not installs-that-reached-a-voice-turn; honest-limits
ordering reads as "toy" when it leads; competitor teardown missing (the real
comparison is Claude Code remote/mobile + OSS agent remotes, not Cursor).

**My verdict: AGREE, plus five it missed — all found in the audit below:**
the `IS_VERCEL_PREVIEW=true` bypass flag in the production env; unencrypted
secret replication to the Mac via backup.sh; artifact HTML served same-origin
(script-exec chain from a prompt-injected agent); the brand-freeze dependency
missing from the ladder; the untested restore drill (backups exist, restores
are a rumor). Architecture-change candor is in Part 5.

---

## Part 2 — revised release ladder (recommended)

*(Superseded by Part 10 — the merged 3-reviewer ladder, which folds in the
Sonnet run and the federation pivot. Kept for the record.)*

| release | theme | contents | est. | notes |
|---|---|---|---|---|
| **pre-wave** | unblock | repo rename `veraldar/bifrost` + fix skill URL **pinned to a tag**; launch/comms docs rewritten against v0.6/v0.7 reality (kill "fresh off a fix"); plan.md = single ladder source; SECURITY.md + threat model; brand rework lands (freezes lift) | 2–3d | blocks wave 1, no code |
| **v0.7.0** | "the reliable voice" (earned) | wedge-fix, ux-mictap, `streaming_interval` knob, **edge sherpa voice = Linux default (no docker required)**, known-limits refresh incl. iOS line | 3–5d | real-speaker A/B (user) |
| **WAVE 1** | techie preview | Show HN day 0 only (hook-first title + cold-start timed video, CPU path, cheap box); X same day passive; r/LocalLLaMA day +2; r/selfhosted day +4; r/omarchy loose; 5–10 seeded cold testers before day 0 | 1 week | user fires |
| **v0.8.0** | WSL2 one-click | PS wrapper (WSL path only), edge-on-Windows validation, voice-models.md published, Tailscale admin-URL detection + `/selfcheck` page | ~1 week | Windows test box: VM is enough |
| **v0.9.0** | consumer gates | QR `/pair` onboarding, **device tokens at the seam** (see SECURITY #1), android-lab green, push polish; switcher *spec* signed off | 2 weeks | the consumer release candidate |
| **v1.0** | the promise kept | consumer decision tree wired (Tier 1 cloud / Tier 2 sovereign), veraldar.org one-pager + video #1, wave 3 launch | 1–2 weeks | no new engineering |
| **v1.1** | many trees | instance switcher build (spec exists), TV/media skill, per-bridge identity | evidence-triggered | wave-1/2 demand decides |
| background | — | voice-lab P2 remainder/P3, edge Termux arm64, yggdrasil lab (shelved per playbook lesson), hardwar | drip | none gate a release |

Cut from the ladder: native no-WSL Windows, VoxCPM2 in v1.0 (taste gamble,
35.6Hz spread), anything from the labs in a release table.

---

## Part 3 — SECURITY (ranked; fixes concrete)

Posture first, honestly: the boundary is real and mostly disciplined —
opencode on `127.0.0.1`, PWA on `127.0.0.1` behind `tailscale serve`,
edge voice server on `127.0.0.1`, `.env` files untracked, artifact route has
a traversal guard + type allowlist, diagnostics log-only. The problem is that
**the boundary is implicit and unnamed** — nothing in code or docs states
"the tailnet is the auth layer," so nothing tells you when you've outgrown it.

**S1 — HIGH. No auth on any `/api/*` route; the tailnet is silently the only
authentication.** Token minting, session create/delete, message send (→
opencode → shell), artifact read, diag read, push-sub add/remove: all
unauthenticated. Any tailnet member or stolen unlocked phone = full control,
including arbitrary code via opencode. Fine for one paranoid user; fatal for
`/pair`, family tailnets, and Tier 1 (Vercel-hosted PWA where the "network"
is the public internet).
**Fix (v0.9, blocking v1.0):** `/pair` mints a per-device bearer token; the
Next proxy checks it on every `/api/*` route (one middleware); settings gains
"devices" with revoke. The `/pair` QR already exists in spec-onboard — the
token is the same seam, ~1–2d.

**S2 — HIGH. Install-skill supply chain.** README + bootstrap clone mutable
`main` from `raw.githubusercontent.com`; the skill runs shell as the user; no
tag pin, no checksum, no "show what will run" step. This is the exact pattern
HN's first security comment will dissect, and it is also a real risk (repo
compromise = RCE on every installer's box).
**Fix (pre-wave):** pin the URL to a release tag (commit-SHA fallback);
bootstrap prints a short "about to: clone X, write Y, systemctl start Z"
manifest before executing; SECURITY.md carries the threat model ("you are
trusting the repo + your agent's harness; here is the minimal trust chain").

**S3 — MEDIUM. `IS_VERCEL_PREVIEW=true` sits in the live production
`pwa/.env.local`.** Its only effect is to bypass the token route's
"THIS API ROUTE IS INSECURE" production guard. The guard is designed for
dev; we run production with the dev escape hatch permanently on. It works
because of S1's network boundary — which means the flag *lies* about the
environment and will silently ship to a future deployment where the boundary
doesn't exist.
**Fix (v0.7):** rename to an explicit `BIFROST_AUTH=tailnet-implicit`; the
PWA logs a startup warning whenever it mints tokens without a real auth
layer; bootstrap sets it deliberately, never copied from examples.

**S4 — MEDIUM. Artifact HTML is served same-origin.** `/api/artifact/[name]`
returns agent-written HTML as `text/html`; the chat sandboxes the iframe, but
any top-level navigation (address bar, share-sheet open) executes that HTML
with the PWA's origin — i.e. same-origin JS that can mint LiveKit tokens,
read every transcript, edit push subs. Combined with prompt injection (a
malicious page the agent read tells it to "save this as an artifact"), that is
an injection → origin chain.
**Fix (v0.7, one line):** `Content-Security-Policy: sandbox allow-scripts`
header on the artifact route (all types), plus `X-Content-Type-Options:
nosniff`. The sandboxed iframe keeps working; top-level navigation loses the
origin.

**S5 — MEDIUM. Backups replicate every secret, unencrypted, to the Mac
Studio.** backup.sh deliberately includes `.env` files (correct — they're the
point) and `~/.local/share/opencode` (which carries provider auth) over SSH
into plaintext snapshots on another machine. A stolen or compromised Mac =
the keys to the tailnet, LiveKit, VAPID, and every LLM provider.
**Fix (v0.7, ~0.5d):** age-encrypt the secrets set to the Mac's recipient key
(secrets land as `.age` blobs), or verify FileVault-equivalent disk
encryption + document it as a trust boundary. **And run one restore drill
into a scratch directory before wave 1** — the restore procedure in
docs/backup.md has never been rehearsed.

**S6 — LOW. LiveKit binds `0.0.0.0` with `devkey` on the LAN** (compose host
net). Signal is also tailnet-proxied, so LAN exposure is redundant surface.
Fix: bind the tailscale IP + LAN IP explicitly in livekit.yaml, or leave and
document; rotate away from the `devkey` key name in bootstrap.

**S7 — LOW. Diag log injection + readable tail.** `POST /api/diag` writes
client-supplied strings with embedded newlines into log files (forgeable log
lines); `GET /api/diag` serves the latest tail to anyone on the seam. Fix:
strip newlines when formatting lines; accept readability post-S1.

**S8 — NOTE (forward-looking). Voice permission profile for the TV scenario.**
"Media commands auto-allowed" is a permission profile — the same mechanism
will be asked to auto-allow `rm`. When it is specced (v1.1), allowlists must
be per-skill, verb-scoped, and never shell-glob. Flag it now so the switcher
spec doesn't bake in a blanket trust mode.

---

## Part 4 — GAPS (fleet, build, docs)

**Fleet (from claims.md + git):** ~20+ sessions in 9 days, claim discipline
works, commit-per-fix culture real, and the yggdrasil lab closed *honestly*
("never reached Opus; zero Rust") with the lesson written into lab-playbook —
that failure log is a feature, keep it. Gaps:

- **Stale open claims:** onboard-p1 open since 09-26 (its spec is "under
  review" forever); LAUNCH session's Gate A still targets v0.4.0; android-lab
  running-but-unverified for a day+. Dead claims rot the board the same way
  dead sessions rot the wedge.
- **The v1.0 gate has no owner:** android-lab green is a named plan.md gate,
  its session is unverified, and nobody is paged. Fleet rule "BLOCKED =
  VISIBLE" exists (commit 8907885) — apply it to gates, not just labs.
- **Momentum misallocation:** ~10 design sessions (r1–r5, cohesive,
  rebuild-cohesive, gh-landing) before a single external user, while wave 1
  is blocked on stale docs. Design matters; ordering matters more.
- **Sessions-as-institution risk:** every fix lives in a session's head +
  claims.md one-liner. The wedge-fix session name
  (`fix-state---alpha-besta-release-225028`) is already illegible. Naming law
  for claims = one line, same as brand copy.

**Build (code done so far):** 145 commits, 8 tags, 43 e2e tests across 13
spec files (suite green), bootstrap/selfhost-check/deploy scripts, edge
server 7/7 verified. Gaps:

- No SECURITY.md, threat model, issue templates, or `bifrost doctor`
  (paste-able diagnostics) — support load has no levee.
- No restore drill, no cost ledger, no competitor teardown, no opt-in success
  signal (see USER DECISIONS #10 — without it, "evidence-triggered" is
  evidence-blind).
- README presents the Mac Studio as an architecture node (reads as
  requirement) and still ships `yggdrasil-bifrost` URLs everywhere.
- Three docs disagree on v1.0's contents (plan vs roadmap-proposal vs comms
  calendar). One ladder, referenced by all.

---

## Part 5 — architecture verdict (asked plainly)

**Keep:** phone → Next proxy → opencode (the one seam); self-hosted LiveKit
with pinned ICE; systemd user units; agent-installs-itself; edge CPU voice
server. Nothing here needs a rewrite, and the vision (PWA holding N bridges)
is additive, not structural.

**Change:** (1) the seam gains an explicit auth layer (S1) before it carries
a second instance or a public deployment — this is the single architectural
decision v1.0 depends on; (2) edge voice becomes the default speech path
 Latency is architecture, not polish; (3) install trust becomes pinned and
manifested (S2). If a big player ships "phone remote for your agent" first,
the durable diff is exactly these three plus the loyalty clause — owned,
local, honest — so they are also the moat, not chores.

---

## Part 6 — USER DECISIONS (only you can answer; better answers = better roadmap)

1. **Repo rename to `veraldar/bifrost` before wave 1?** Rec: yes, once, now.
   After wave 1 it breaks every pasted install line. GitHub redirects cover
   clones, not cached skills.
2. **Fire wave 1 at trimmed v0.7 or wait for v0.8?** Both reviewers: v0.7.
   Your call on timing/energy.
3. **Switcher: v1.1 evidence-triggered (both reviewers) or v0.9 centerpiece
   (original proposal)?** Rec: v1.1, spec in v0.9. If the TV demo matters
   more socially than the Windows door, swap — say so.
4. **Commit to device tokens at the seam (S1) pre-v1.0?** Rec: yes — Tier 1
   (cloud PWA) is unshippable without it.
5. **Brand rework landing date.** It gates all launch copy (freeze order).
   The final design pick is yours and nothing moves until it lands.
6. **Windows test box:** provide real hardware, borrow, or accept a VM for
   the WSL2 pass? Rec: VM is enough; a real box only upgrades confidence.
7. **veraldar.org at launch or with v1.0?** Rec: with v1.0.
8. **Launch hardware honesty:** record the demo on a cheap box (VPS or
   €200 mini-PC) instead of the M3 Ultra? Rec: yes — "we demo what we run"
   should mean something a viewer can afford.
9. **iOS stance for v1.0:** Android-proven, iOS-second-class as a stated
   limit? Rec: yes, one line, no promises.
10. **Success telemetry:** brand says no telemetry. Opt-in one-bit
    "it worked / it didn't" (`bifrost report` or a pinned Discussion
    template) — allowed? Rec: yes; it is measurement by consent, not
    telemetry, and evidence-triggered decisions starve without it.
11. **Budget line:** authorize ~€5–20/mo (VPS for demo/testing + captions
    tooling) or strictly owned hardware? Rec: authorize; it is rounding
    error against the sessions.
12. **yggdrasil + hardwar labs:** shelve until post-v1.0 or run per the new
    playbook (active driver, commit-per-milestone)? Rec: shelve; the
    playbook lesson says small-scale delegation proof first.

## Part 7 — COSTS (what I can verify; the rest is yours)

**Cash, recurring (verified in repo):** ≈ zero today. Vercel free tier
(validated), LiveKit + speech self-hosted on owned hardware, OVH €3 VPS
deferred, sponsors/opencollective not yet activated. Known future lines:
Infomaniak hosting for veraldar.org (amount TO-VERIFY in legal memo),
domain renewal (your registrar), CH trademark CHF ~350 if filed, Verein
CHF 200–500/yr if triggered (trigger table exists — correctly dormant).

**Compute:** owned and sunk — omarchy box + Mac Studio M3 Ultra; electricity
unmetered. No cloud inference in the default path.

**API/LLM:** voice replies ride a free-plan model
(`ling-3.0-flash-fin-free`); sessions run on your subscription plans (zai
coding plan; Anthropic plans for delegation — including this review and the
Opus pass). **No cost ledger exists anywhere in the repo** — the real numbers
live only in your billing dashboards. Gap: `docs/costs.md`, one table,
updated monthly; user pulls dashboard numbers once.

**The honest cost statement:** cash burned to date is a café budget; the
expensive currency is *sessions* — ~10 of them spent on identity before a
single stranger arrived, while launch sat blocked on stale docs and two
security debts. This review's whole ladder is priced in days, not francs.
Ship before you decorate again.

---

*Files: `docs/reviews/agi-roadmap-review.md` (this file) + 
`docs/reviews/opus-critique.md` (full Opus text) +
`docs/reviews/sonnet-critique.md` (full Sonnet text). Neither changes
plan.md — the product session re-sequences after your decisions on Part 6 +
Part 9.*

---

# ADDENDUM 10-03 — second reviewer (Sonnet 5.5) + the federation pivot

## Part 8 — SONNET 5.5 RUN vs OPUS (independent pass)

Sonnet 5.5 ran the same brief blind (same docs, repo access, no access to
Opus or my conclusions; it probed further — ran `ss`, checked file modes,
read route comments). Full text: `docs/reviews/sonnet-critique.md`.
**Agreement = high confidence. Divergence = flagged for you.**

### Where all three reviewers agree (act on these, confidence high)

- v0.9 must not gate v1.0 on the multi-tree feature; consumer v1.0 needs
  pairing + android proof only.
- v0.7 as proposed is padded; trim to launch-relevant fixes; launch before
  Windows; labs/specs leave the release table.
- Cold-start install video = the single highest-leverage launch asset; fix
  the supply chain + write SECURITY.md BEFORE posting anywhere.
- Ship as "Bifrost" only; Yggdrasil out of user-facing text until the Rust
  core exists; veraldar.org = stub at most; lore parked.
- Tailscale HTTPS/secure-context mic and hand-edited ICE are top stumble
  points; a `/selfcheck` page is the fix; iOS is second-class and must be a
  stated limit.
- Security set: unauth seam + guard bypass + artifact HTML same-origin +
  install-skill supply chain + plaintext backups — all real, all ranked
  HIGH/MED by both.

### New findings Sonnet contributed (verified against the repo)

1. **The repo rename is half-done and hanging on a redirect.** `git origin`
   is already `veraldar/bifrost`; README, bootstrap, and the install skill
   still clone `veraldar/yggdrasil-bifrost`. Works today via GitHub
   redirect; a shell-running install skill must never depend on a redirect.
   Grep + fix + pin to tag/SHA pre-wave. (This settles USER DECISION #1: the
   rename already happened — finish it.)
2. **opencode upstream API volatility.** Our own proxy carries a workaround
   for opencode v1.18 dropping `variant` (pwa/app/api/session/[id]/route.ts).
   A minor upstream release can brick every install. Fix: pin a supported
   version range, contract-test against it, surface the version in
   `/selfcheck`. Neither Opus nor I had named this; it may be the biggest
   operational risk of the three new ones.
3. **`.env` files are mode 0644** (pwa/.env.local, agent/.env, deploy/.env —
   verified): LiveKit secret, VAPID private key readable by any local user.
   `chmod 600` in bootstrap, fix the live files.
4. **Sharper kill chain for the guard bypass:** with the bypass on, any
   tailnet peer mints a 15-min LiveKit JWT for ANY room name with canPublish
   + agent dispatch — i.e. drives the coding agent by voice — and dispatch
   is also free resource exhaustion.
5. **Push/diag hardening:** allowlist push endpoint hosts (SSRF-ish surface),
   cap diag batch sizes (disk-fill), strip newlines (log forging).
6. **LAN speech hops are plain HTTP** (speaches :8000, Mac MLX :8001) —
   voice crosses the LAN unencrypted. Acceptable at home; must be IN the
   threat model, not absent from it.
7. **Backup multiplication:** the Mac likely re-copies the plaintext snapshot
   set into its own backup chain (Time Machine/cloud). Encrypt the secrets
   set at the source.
8. *"AI-written everything — read the copy aloud"* — adopted; add to
   Gate B.

### Divergences (flagged for you, with the vote)

| Question | Opus + me | Sonnet | Flag |
|---|---|---|---|
| Edge CPU voice default | v0.7 (it's config-level, and "reliable voice" is otherwise false advertising) | post-launch (shrink v0.7 to ≤1 week) | **2/3 say v0.7 — keep in v0.7**; it is hours, not days |
| Windows WSL one-click | v0.8, wave-2 material | evidence-triggered only (≥10 inbound asks), never scheduled | **Split — your call.** Merged rec: v0.8.5 conditional on wave-1 results.md; WSL docs page ships regardless |
| Seam auth timing | per-device tokens at v0.9 | static per-install bearer BEFORE launch; full tokens at v0.8; **Sonnet is right** — auth is load-bearing for Tier 1, /pair, AND federation; the 1-day static bearer belongs pre-wave | Adopt Sonnet |
| Tier 1 (Vercel-hosted PWA) | consumer decision-tree tier 1, as planned | **challenge:** hosted PWA = third-party code in the user's origin + LiveKit pushed public + secret held off-box — "do not call it self-hosted"; defer until a clean threat model exists | **New USER DECISION** — this reshapes v1.0's Tier 1 (see Part 9 #4) |
| Multi-tree transport | switcher, then user pivot to server federation | neither now: client-side multi-bridge (phone fans out, holds N device tokens, merges client-side); server federation only on cross-tree demand | See Part 9 — **I side with Sonnet on transport, with you on destination** |

## Part 9 — PIVOT VERDICT: federation vs switching (reviewer's own view)

*(Updated 10-03 by Part 13: the factual baseline — two live bridges + two
live trees, crossed daily — upgrades client fan-out from "v1.1
evidence-triggered" to v0.8/0.9 mainline. Transport verdict unchanged;
priority changed.)*

**Your instinct is right about the destination: a unified list beats
mode-switching.** The vision diagram already settles the topology argument —
it has ONE PHONE at the top. The phone is the hub. That is exactly the
architecture Sonnet names and the PIVOT gesture reaches for.

**Amendment: the transport should be client-side multi-bridge first, not
server-to-server federation.** One PWA holds N `(base_url, device token)`
pairs — the same S1 seam, once per tree — fans out itself, merges into one
list with tree chips, and failures stay isolated per bridge (a sleeping TV
PC is a grey chip, not a hanging list). Server-to-server peering (discovery,
relay, trust between boxes) is a distributed system with a per-hop security
boundary, version skew, and a blast radius that inverts your brand promise:
a server-side hub that can drive every tree means compromising the hub
compromises every PC; the phone-holds-N-tokens model keeps each tree
sovereign behind its own token. Build federation proper only when cross-tree
*actions* (move a session between trees, shared context search) are
demonstrated demand.

Failure modes the federation spec must answer before any server peering
exists (from Sonnet, confirmed): partial availability (per-peer timeouts +
stale states, never a spinner); version skew (versioned peer API +
capability negotiation); **`tree/slug` collision — today room = slug is the
LiveKit room, JWT identity, and opencode session id, so identical slugs on
two trees collide the moment one view sees both**; voice topology (which
tree hosts the room for a federated session?); push routing (VAPID is
per-box). Note the invariant wording: with N bridges the "one seam" becomes
"N authenticated seams, phone-only" — the spec must say exactly that, or
the invariant quietly dies.

**Cheap forward-compatible step that all three reviews support, do it in
v0.8:** make `tree` a first-class field now — `tree/slug` in room names,
token identity, and session ids — and version the peer-facing API surface
(`/api/v1/*`). Hours of work; removes the collision class before
multi-bridge ever ships; costs nothing single-tree.

## Part 10 — REVIEW BOARD LADDER (merged 3-way; supersedes Part 2)

| stage | contents | est. | notes |
|---|---|---|---|
| **pre-wave** (blocks launch, no features) | docs rewritten vs v0.6/v0.7 reality; **finish the rename** (grep every `yggdrasil-bifrost` URL → `veraldar/bifrost`, pin skill to tag + SHA, publish bootstrap.sh hash); SECURITY.md + threat model ("tailnet membership = shell"); **delete `IS_VERCEL_PREVIEW` bypass**; static per-install bearer on `/api/*` (1d); artifact route CSP `sandbox` + `nosniff`; `chmod 600` all env files; brand rework lands (unfreezes copy) | 3–4d | Sonnet's auth-before-launch adopted |
| **v0.7.0** — "the reliable voice" (earned) | wedge-fix, ux-mictap, **edge sherpa = Linux default** (2/3 vote; config-level), known-limits + iOS line, honest-limits ordering fixed (demo first, limits in one line + first reply); **cold-start video shot on a cheap box**; seed 5–10 cold testers NOW | ≤1 week | real-speaker A/B (user) |
| **WAVE 1** | HN day 0 only (hook-first title, video in first comment, repo as URL); X passive same day; r/LocalLLaMA +2d; r/selfhosted +4d; r/omarchy loose; results.md = the demand instrument | 1 week | user fires; not during a major model-release week |
| **v0.8.0** — "the pairing release" | `/pair` QR + per-device tokens + device list/revoke + `/selfcheck` page (mic, ICE, tailnet, opencode version probe); `tree/slug` namespacing + `/api/v1` groundwork; push endpoint allowlist + diag caps | ~1 week | every consumer path (Tier 1, multi-bridge) stands on this |
| **v0.8.5** (conditional) | Windows WSL2 one-click — fires only if results.md shows ≥ ~10 inbound asks; WSL docs page ships regardless | 1 week, evidence-triggered | the one deliberate Opus/me-vs-Sonnet split |
| **v0.9.0** | android-lab green + push polish + decision-tree wiring = consumer candidate; **multi-bridge client fan-out spec** (not server federation) | 1–2 weeks | |
| **v1.0** | consumer single-tree launch + veraldar.org one-pager + wave 3. **Tier 1 (Vercel-hosted) contingent on the new threat-model decision (Part 8/9 #4)** — if deferred, Tier 2 sovereign leads the story, which is also the more honest one | 1–2 weeks | no new engineering |
| **v1.1+** | unified multi-bridge list (client-side); server federation only on demonstrated cross-tree actions | evidence-triggered | vision kept, transport amended |
| background | voice-lab P2/P3, edge Termux, yggdrasil/hardwar shelved per playbook, ideas.md for dreaming/SIP/connectors/TV | drip | nothing gates a release |

**Decision list deltas (Part 6):** #1 answered (rename half-done — finish
it); #3 answered by your pivot, reopened as transport choice — **client
fan-out (recommended) vs server peering**; NEW: Tier 1 Vercel threat model —
ship it, defer it, or reframe it as "bring-your-own-box, hosted UI only";
edge-in-v0.7 stands unless you object.

---

# ADDENDUM 2 — RE-SEQUENCE REVIEW (user pivot: federation + layman onboarding
# to v0.8, Windows → v0.9, consumer gate = girlfriend-iPhone)

## Part 11 — verdict on the revised order

**VERDICT: CONDITIONAL GO.** The order is right and the layman-iPhone gate is
the correct north star — but only with scope discipline on what "federation"
means at v0.8, and with the gate executed at the right time.

*(Updated 10-03 by Part 13: "peering v1 = hub-and-ONE-peer, text routed
server-to-server" is superseded — with the Mac Studio already running its own
bifrost, the v0.8 mechanism becomes client-side fan-out over a static bridge
list (first peers: Mac Studio, then TV-PC). No server-to-server hop. See
Part 13.)*

### Q1 — Is federation-before-Windows right, given the layman gate? YES.

- Windows was already evidence-gated (Sonnet's position, adopted in Part 10).
  Moving it to v0.9 formalizes what every review wanted: no unevidenced
  Windows work. Cost of the swap ≈ zero.
- The layman gate needs zero Windows: the girlfriend owns an iPhone, the box
  is already running. The layman path is phone-side only — pair, install,
  talk. The load-bearing v0.8 items are therefore **pairing + device tokens
  (the S1 fix) + iPhone auto-setup**, and federation rides on the SAME token
  seam. That shared seam is the one honest reason they fit one window.
- The TV scenario is the only demo that makes the vision literal for a layman
  — one phone, two trees — and it is the wave-3 story. Building its minimal
  form pre-v1.0 means v1.0 launches with the real story instead of a mockup.

### Q2 — Is the TV scenario achievable in v0.8 scope? The minimal version, yes.

Name it **peering v1: hub-and-ONE-peer**. In:

- ONE static peer (TV-PC) registered by QR pair — **no peer discovery**.
- `tree/slug` namespacing (must exist anyway; Part 9).
- Text: couch instance routes prompts server-to-server over the tailnet to
  the TV peer's proxy using its instance token — same S1 seam, one hop.
- Voice: the phone joins the **owning tree's** LiveKit room directly over
  the tailnet (token minted by that peer). No audio relay through the couch
  box, ever — a media hop doubles latency and adds a failure point for zero
  benefit. If "routes to TV-PC" was meant to include audio, cut that now.
- Media skill (mpv IPC) + a verb-scoped auto-allow profile on the TV peer:
  play/pause/seek/open ONLY — never shell-glob (Part 3, S8).

Out of v0.8, explicitly: peer discovery, capability negotiation, unified
merged list (a "Trees" group header is enough), cross-tree actions,
version-skew handling (you control both boxes — same repo, same tag; write
that assumption down). Scope honesty: this is a **2–3 week release**, not
the ~1 week the old table carried. Write the honest number or the ladder
will "be late" instead of "be scoped."

### Q3 — the girlfriend-iPhone gate: right gate, wrong timing as written

plan.md puts the test at v1.0; the layman onboarding it validates ships at
v0.8. A gate you first execute at launch is a demo, not a gate. **Run it at
v0.8 exit; re-run at v1.0 as regression.** Pre-register the script now:
unboxing → talking to the agent in ≤15 min, zero terminal, zero
founder-questions, one allowed stumble. iOS specifics go IN the script:
install-to-home-screen (push requires iOS 16.4+ and install), mic permission
flow, backgrounded-reply behavior — a push failure is a recorded known-limit,
not a fail, and that is decided BEFORE she picks up the phone. android-lab
green stays as the software regression behind the human pass.

### Q4 — new finding: the ladder drifted in its own adoption edit

plan.md's adopted table contradicts both itself and the stated order:
v1.1 says "v0.8 federation is the base" over a v0.8 row that is WSL2;
v0.9 carries a "federation spec signed off" item for a thing now being
built at v0.8; vision.md PIVOT still scopes federation as v1.1+ with peer
discovery. plan.md is the single ladder source by its own rule — reconcile
this week: table to the adopted order, and vision.md PIVOT to the staged
scope: **peering v1 hub-and-peers (v0.8) → unified list (v1.1) → general
federation (evidence-triggered)**.

### Revised ladder (only the changed rows; pre-wave/v0.7/WAVE 1 unchanged)

| release | contents |
|---|---|
| **v0.8.0** "the layman release" (2–3 wks) | /pair QR + device tokens + revoke + /selfcheck; iPhone auto-setup flow (home-screen install, mic permission, first talk); peering v1 (tree/slug, one static peer via QR, text routing, phone joins owning tree's room); TV recipe + media skill + verb-scoped auto-allow. **EXIT GATE: girlfriend-iPhone pass** (android-lab green as regression) |
| **v0.9.0** | Windows WSL2 one-click — **conditional**: fires only if wave-1 results.md shows ≥ ~10 inbound asks; else this slot becomes polish + voice guide and v1.0 pulls forward |
| **v1.0** | decision-tree wiring (Tier 1 contingent on the Vercel threat-model decision), veraldar.org one-pager, wave 3; girlfriend test re-run as regression |
| **v1.1+** | unified list across peers (client-side merge), more peers; general federation evidence-triggered |

**Conditions attached to the GO:** (1) v0.8 = hub-and-ONE-peer, no
discovery; (2) girlfriend test pre-registered and run at v0.8 exit;
(3) plan.md + vision.md reconciled to this order this week; (4) voice
topology = phone joins owning tree's room, no audio relay; (5) Windows v0.9
stays evidence-conditional — if wave 1 explodes with Windows asks, it can
still jump the queue with your say-so, but that is a decision made on data,
not on the ladder.

---

# ADDENDUM 3 — "THE TREE IS THE DOOR" (vision.md, 10-02)

*The door: veraldar.org tree, "hold to start" → vocal onboarding (who they
are + provider choice → personalized install command/QR). PWA first-run:
tree fills the screen alone → click → vocal onboarding → THE MAIN session
created (caps-tagged) → tree shrinks to a corner but stays the door —
clicking it always opens main. One gesture, two surfaces: knock, and the
bridge opens.*

## Part 12 — verdict: ADOPT WITH THREE AMENDMENTS

The instinct is right and the gesture grammar is already shipped — the site's
own copy says "the tree above and the mic in bifrost answer the same way:
hold, and it turns amber." The door is that sentence made interactive. It is
the most brand-coherent interaction idea in the repo. The three amendments
are about WHERE the voice happens, WHEN each surface ships, and what the
gate measures.

### (1) COHERENT — yes, with one sequencing conflict
- With the vision/brand/interaction law: fully. Hold = knock is the PTT
  grammar extended to onboarding; the tree-as-door is the myth made UI.
- With the ladder: the **PWA door** slots into v0.8 with zero added scope —
  it IS the layman onboarding's face (see A2). The **veraldar.org door**
  conflicts with the adopted "stub at launch, lore T+60" ruling: a site that
  runs vocal onboarding is a product surface, not a stub (see A3). Coherent
  in kind; the two surfaces ship at different times.
- Naming law: "THE MAIN" as a caps-tagged slug is fine, but define it — a
  reserved slug `main`, displayed caps, code register lowercase, created
  exactly once, never deleted by swipe-to-delete without an explicit
  ritual (the one session the door always reopens).

### (2) FEASIBLE — PWA door: small; site door: small only if it doesn't listen
- PWA door (3–5d): full-screen tree first-run component (the ygg tree
  component exists from the cohesive rebuild), tap → onboarding wizard as a
  real session with a permission profile (the agent stack already runs —
  this is post-install), create `main`, shrink animation. Slides into the
  existing /pair + selfcheck work as its UI.
- Site door (2–3d **text-first**): hold-to-knock → shows the install command
  + QR + the skill manifest + SECURITY.md link. All client-side, nothing
  stored, nothing transmitted.
- Site door **with real vocal onboarding** (+1–2 weeks and a legal surface):
  browser STT on iOS Safari is flaky, mic needs a prior gesture chain and a
  secure context, and pre-install voice capture creates a data-controller
  surface (criterion 3). Feasible technically; wrong trade pre-v1.0.

### (3) SAFE — the one real danger in the idea, and the fix
- **A public website that records voices pre-install breaks the prime
  directive's own promises**: "nothing public", "nothing phones home",
  log-only diagnostics, no-cookie-by-design (legal memo), no telemetry
  (brand). The moment veraldar.org captures "who they are" by voice, the org
  becomes a GDPR data controller for strangers — consent, retention,
  processor choice, a privacy page — and hands HN the headline: "the
  privacy project's landing page records you." Browser speech APIs also
  route audio through third-party cloud STT (Chrome→Google), meaning the
  knock would leak audio to the exact intermediaries the product exists to
  remove.
- **Amendment A1 (advisory, binding unless you overrule): the door listens
  only behind the bridge.** The site tree knocks and *hands over* (install
  command/QR + manifest + security link — zero capture). The vocal
  onboarding — who you are, provider choice (the identity menu is already
  the message) — happens inside the PWA, where speech already runs on the
  user's own stack, over the tailnet, with the browser's own mic prompt as
  the consent layer. Provider choice by voice gets a bureaucratic
  confirmation step per brand copy law ("set provider — X, this box").
  Nothing is stored server-side; the wizard composes locally.
- If you want site-side voice anyway: post-v1.0, on-device-only processing,
  explicit consent UI + privacy page, and it becomes a USER DECISION — not
  a default.

### (4) EASY FOR A LAYMAN — yes, with iPhone physics respected
- The girlfriend-iPhone gate applies literally: **knock → talking ≤15 min,
  zero terminal.** The door is the right shape for that — one gesture, no
  forms.
- iOS realities the door must absorb (all agent-buildable details): long-press
  triggers text-selection/callout (suppress `-webkit-touch-callout`);
  mic permission needs the press gesture (a knock IS one — good) and a
  secure context (the known Tailscale-HTTPS stumble — selfcheck covers it);
  PWA mic wants install-to-home-screen first, so the site door's sequence is
  **knock → install card → PWA → tree fills screen → vocal onboarding**;
  and a zero-shame text fallback stays visible the whole time (Safari speech
  variance must never strand a layman).
- Gate note: the door makes the v0.8 exit gate EASIER to pass, not harder —
  it removes the "find the session list" step entirely.

### (5) MOSTLY AGI-BUILDABLE — ~90%
- Agent-buildable: both door surfaces, the wizard flow, the permission
  profile, the reserved-`main` mechanics, iOS touch suppression, the
  shrink-to-corner state machine, and its tests (a `door.spec`: knock →
  install card; PWA first-run → `main` exists → tree cornered → click
  reopens main). This is proven fleet territory (mic-tap, artifacts, themes
  were all fleet-built).
- Human-only: the wizard's final voice/script (taste — brand law; fleet
  drafts, you pick, r1–r5 pattern); the provider-choice catalog (your
  identity stance); any site-side-capture decision (A1 overrule); the
  girlfriend-test execution itself; the privacy-page sign-off if A1 is ever
  overridden.
- Maintenance: small surface, e2e-covered, fleet-maintainable.

### Ladder impact — naming, not resequencing
- **v0.8 row, renamed:** "iPhone auto-setup flow = **the door**: site tree
  knocks → install card; PWA first-run tree → vocal onboarding → `main`
  created → tree to corner." No scope change, no date change; the door is
  the onboarding's UI, not a new feature line.
- **veraldar.org door = the T+60 "the tree answers" evolution** (with the
  stub → full-site decision already pending from the meta-coherence review).
  At launch the world-tree page may carry the hold gesture as a grammar
  demo — hold, amber — capturing nothing.
- **New USER DECISION (only if A1 is contested):** site-side voice capture —
  recommend never pre-install; post-v1.0 on-device-only with consent UI if
  the story demands it.

---

# ADDENDUM 4 — FACTUAL BASELINE + THE ARCHITECTURE PROPOSAL (10-03)

## Part 13 — two live trees change the answer's PRIORITY, not its SHAPE

### 13.0 Fleet completion check first (asked before proposing)

Did AGI finish every task asked across the fleet? **No — 7 open claims, and
they sort into three honest buckets:**

- **Blocked on the user, not AGI:** stutter-fix (M2 fix live on
  `fix/voice-stutter`; remaining = user ear-pass + post-deploy Safari
  data); edge-spike Termux half (needs the physical spare phone).
- **Genuinely unfinished by AGI:** backup-mac (first-run evidence never
  produced — the S5 backup risk is still unrehearsed); android-lab (a named
  v1.0 gate, still unverified 2 days after trigger); worldtree-data (in
  flight, 10-03 mission); ux-mictap (in flight).
- **Delivered but not closed out:** yggdrasil-s4 marked DONE with
  deliverables *uncommitted* (install.sh, systemd unit, PKGBUILD sit in the
  dirty tree) — a delivery gap, not a work gap; onboard-p1 open since 09-26
  and superseded by the v0.8 layman-door pivot — close it as obsolete.
- Reviews (my lane): all delivered — agi-roadmap-review (+3 addenda),
  meta-coherence + design-eye, opus/sonnet critiques.
- Labs: the yggdrasil lab's "stalled" status in roadmap-proposal is
  **outdated** — it ran (slice 3: bifrost's own e2e green against the Rust
  core via OPENCODE_URL; slice 4: install kit). The lab playbook lesson
  (active driver, commit-per-milestone) is now PROVEN, not just written.

The pattern in the unfinished set: nothing is blocked on capability; the
blockers are *evidence steps that need the human* (ear-pass, spare phone,
first backup run, emulator) and *close-out discipline*. The fleet finishes
work; it under-finishes claims.

### 13.1 What the factual baseline changes

Two bifrosts + two yggdrasils are live (omarchy building bifrost;
Mac Studio running its own for a different project), and the user crosses
between them today. That converts the multi-tree question from "someday,
on evidence" to "the owner is the evidence." It also confirms the naming
law's sharpest test: the VPS access point is a **BIFROST** (bridges
connect), never a Yggdrasil — bifrost-net's node hosts no agent core. Both
corrections are right.

What does NOT change: the transport analysis. Same-owner peers collapse the
trust-bootstrap problem (both boxes are one principal on one tailnet), but
the structural arguments stand — and they now argue FOR the simpler design,
because the second tree already runs a full bifrost:

- Every tree already ships the whole stack (proxy + agent + LiveKit). A
  peer needs no new server role — just a credential in the phone.
- The couch/TV scenario (v0.8) needs exactly the same plumbing as "see the
  Studio's sessions": a second bridge credential, tree chips, owning-tree
  voice. One build, two scenarios.
- A hub (either tree proxying for the other) adds a hop, a blast radius,
  and an availability dependency (Studio asleep → its sessions vanish from
  a hub-fed list; from a client fan-out they just grey out).

### 13.2 The proposal: HYBRID, staged — fan-out now, peering on demand, bifrost-net as lab

**Stage 1 — "bridges" in the client (v0.8–v0.9, mainline).** The phone holds
a static bridge list `{name, base_url, device_token, glyph}` — one `/pair`
per tree. The PWA fans out itself: merged session list with tree chips,
session ids namespaced `tree/slug`, voice room hosted by the OWNING tree
(phone joins that tree's LiveKit directly over the tailnet; no relay). Each
peer's proxy sends CORS allowlist + accepts its device token (the S1 seam,
multiplied, not redesigned). Failure isolation per bridge: asleep = grey
chip, never a spinner, never a hanging list.
*Effort: 5–8d — and it REPLACES the v0.8 "static peer via QR" line item
rather than adding one; first peer = the Mac Studio (zero new installs —
dogfooding is the feature), second = the TV-PC (the couch demo).*

**Stage 2 — server-side peering, only for cross-tree ACTIONS (v1.x,
evidence-triggered).** If a named action demands instance-to-instance
contact — hand a session from couch-tree to rack-tree, unified search across
trees — add peer tokens + a versioned peer API (`/api/v1/peer/*`), deny by
default, scoped per peer. The `tree/slug` + versioning groundwork from v0.8
makes this a small increment. Until such an action is asked for by use
(not by vision), client fan-out answers everything two same-owner trees
need.

**Stage 3 — bifrost-net (sovereign sky-bridge): stays a [LAB], off the
product ladder.** The concept is sound and the BIFROST-naming correction is
right (bridge, not tree; it hosts no agent core). But it is a mesh +
NAT-traversal + WebRTC + bridge protocol in one Rust binary — the exact
shape of work the yggdrasil lab just taught us to de-risk: run it under the
playbook (active driver, commit-per-milestone), M0 = two nodes meshed via
boringtun + one str0m echo test + an honest ASSESSMENT.md, trigger =
sovereign-tier demand after v1.0 or the user calls the spike. One honesty
flag for that assessment: boringtun is Cloudflare's Rust WG implementation —
solid, but less battle-worn than the kernel/wireguard-go implementations;
"proven crates, never hand-rolled crypto" should say exactly that.

**What I explicitly do NOT propose:** general peer discovery, capability
negotiation, or unified cross-tree search in v0.8–v1.0. Two same-owner
static peers make discovery a complication without a customer.

### 13.3 Ladder deltas (supersede the Part 11 rows where they conflict)

| stage | change |
|---|---|
| v0.8 | "peering v1 hub-and-ONE-peer" → **"bridges: static bridge list, client fan-out; peer #1 = Mac Studio (live today), peer #2 = TV-PC"**; rest of the row unchanged (pair/device tokens/selfcheck/door/girlfriend gate) |
| v0.9 | unchanged; add "cross-tree action list" as an open question the wave-1/2 evidence answers |
| v1.x | server peering IF a cross-tree action is demonstrated |
| off-ladder | bifrost-net [LAB] spike per vision.md de-risk path; playbook-governed; user-callable now |

### 13.4 Close-out orders (from the fleet check)

1. yggdrasil-s4: commit the install kit (deliverables exist uncommitted).
2. onboard-p1: close as superseded by the v0.8 door.
3. backup-mac: run the first backup + rehearse one restore (S5) — it is the
   oldest open claim and a security item.
4. stutter-fix + edge-spike: the two user-gated items — your ear, your
   spare phone; everything else is done.

---

# ADDENDUM 5 — DESKTOP VOCAL FLOW (refinement, 10-03) — review COMPLETE

*The refinement: full vocal flow on DESKTOP — set language, set voice, set
up bifrost-net, get the QR, all by voice. Compliance twist: the onboarding
conversation runs on the user's OWN edge voice server (local STT/TTS,
already built: `edge/voice_server.py`), so nothing is captured pre-install
and nothing crosses to the org. Sequence: minimal install (agent + edge
voice) → vocal onboarding conversation → QR for the phone.*

## Part 14 — verdict: YES — capability real, compliance twist accepted, A1 dissolves

**Reconciliation with the three amendments:**

| amendment | status under the refinement |
|---|---|
| **A1** — the door listens only behind the bridge | **Dissolved, not violated.** The vocal conversation happens after the minimal install — on the user's hardware, over the user's edge server. The org never becomes a data controller; there is no pre-install capture anywhere. The bridge doesn't just get handed at the knock — the tree's first act *inside* is the welcome. This is the honest version of "the tree is the door": knock (silent) → cross → the tree speaks, with your own voice stack. |
| **A2** — PWA door = the v0.8 onboarding UI | **Extends, unchanged.** The desktop flow is the SETUP door (install-time: lang, voice style, provider/country, optional bifrost-net, QR); the PWA first-run door remains the MAIN-creation door (phone side). One conversation model, two surfaces, same grammar — the vision's "one gesture on two surfaces" now has a second, literal instance. |
| **A3** — site door silent until T+60 | **Unchanged.** veraldar.org still never records; the vocal welcome lives past the install, on the box. |

**Can AGI build/test/validate all on this machine? YES, with two human
gates that were already gates:**

- **Build (all agent-buildable, ~1 week total, inside v0.8 scope):** the
  wizard is slot-filling conversation (language → voice style →
  provider/country → bifrost-net → QR) riding the existing agent + edge
  voice server (`LOCAL=1`, OpenAI-shaped APIs — the seam bifrost already
  speaks). QR = the /pair seam. Permission profile = onboarding session
  auto-allows only wizard verbs. `tree/slug` + reserved `main` carry over.
- **Test (automatable HERE):** desktop Chrome mic automation is solved
  technology the suite already uses — `--use-fake-device-for-media-stream`
  + `--use-fake-ui-for-media-stream` feed a wav as mic input, so the FULL
  loop is headless-verifiable: fake-mic → edge STT → slot capture →
  config written → QR rendered → QR contents decode to a minted device
  token → selfcheck green. A `door-desktop.spec` proves the whole welcome
  without a human ear.
- **Validate (human gates, already named):** TTS intelligibility and
  conversation feel = your ear (same A/B rule as every voice change); the
  phone leg = the girlfriend-iPhone test, which this flow makes EASIER —
  the desktop prologue (talk → QR) is fully automatable, so the human
  starts at scan-and-talk.
- **bifrost-net slot:** the wizard may offer it only as far as the lab has
  produced — until M0+ lands the artifact, the slot says "sovereign access
  point: specced" (shipped/building/specced law; the wizard never promises).
  VPS provisioning, when real, drives the USER's own provider account and
  keys; secrets land in local `.env` (age-encrypted per S5), never org-side.
- **Two dependencies to note:** French STT on the edge path is still an
  open pick (edge-spike claim) — English works today, the language slot
  degrades honestly ("French STT: pending") until it lands; and the
  desktop welcome needs a real speaker/mic pass on one Linux box + one Mac
  before the gate (same rule as hands-free).

**Ladder placement: no date change — scope consolidation again.** v0.8's
onboarding row gains its desktop half, explicitly: *minimal install (agent +
edge voice) → desktop vocal door (lang/voice/provider/bifrost-net-slot/QR)
→ phone /pair → PWA first-run tree → main.* The two doors are one feature:
the layman release's onboarding, spoken.

**With this, the review is COMPLETE:** roadmap (Part 1–2, ladder Part 10/11),
second reviewer (Part 8), pivot + factual-baseline architecture (Part 9, 11,
13), security (Part 3, S1–S8), gaps + fleet close-out orders (Part 4, 13.0),
user decisions (Part 6, deltas in 9/11/13), costs (Part 7), the door (Part
12), and the desktop vocal flow (this part). Standing decisions deferred to
the user are indexed in Part 6 + Part 13.4; nothing else pends a reviewer.
