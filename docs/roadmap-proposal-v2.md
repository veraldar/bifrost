# Roadmap proposal v2 — re-based on MEASURED velocity (planner session, 10-04)

> **RECONCILED 10-04 (inline, budget pause — no delegation needed for my own doc).**
> The ladder moved under this proposal the same day it was written. Deltas vs
> the sections below:
> 1. **v0.8 and v0.9 merged** (user call): ONE v0.9.0 arc — device tokens (S1
>    full) + WebRTC transport (**P2P-first, bifrost-net relay fallback —
>    pairing is going no-tailscale direct**) + /pair QR + iPhone auto-setup.
>    **Build is complete** (auth e2e 7/7, V9 transport green, release
>    validation 8/8) — the arc now waits on the operator gate + tag, i.e. on
>    HUMAN validation capacity, exactly per the bottleneck law.
> 2. **Windows one-click has no ladder slot** — cut with "native no-WSL". It
>    revives evidence-triggered only; the trigger pattern it pioneered
>    (≥N asks) now lives in the native-app eval's Rung A/B bars instead.
> 3. **Girlfriend-iPhone gate executes at v1.0** (current plan.md), not at
>    v0.8-exit as the review argued; the eval's Rung 0 measurements ride the
>    gate script either way. The review's timing argument stands recorded.
> 4. **Tag flag**: this repo carries no tags above v0.3.1 — if releases are
>    cut from a mirror (veraldar/bifrost), every "vX.Y tagged" trigger in
>    this doc and the native-app eval must name WHICH repo's tag counts.
> 5. Unchanged and still binding: the bottleneck law, S2→S3→S1 order (S1 is
>    built and e2e-green inside the v0.9.0 arc; S2/S3 remain pre-wave items),
>    parallel-lane map, and the model ladder (10-04b) for all future runs.

Supersedes `roadmap-proposal.md` (v1). Respects the adopted ladder (plan.md
10-02) + review Addendum 2/13 revisions (federation pivot, girlfriend gate at
v0.8 exit, Windows evidence-conditional). plan.md untouched — product session
applies after user approval.

---

## 1. The measured baseline (what changed since v1)

Build effort is no longer an estimate. Evidence, all commit-referenced:

| delivered | size | wall-clock |
|---|---|---|
| bifrost-net M1 (S2 mesh + S3 WebRTC relay + S4 serve — one binary, 5/5) | a transport stack | **~1 day** |
| yggdrasil slices 1-4, 6a/6b, 7 (+ installer) — tools loop, roll-up, anthropic dialect | an agent core | **~1 day/slice-cluster** |
| cohesive brand rebuild — every screen, both repos | full resurface | **~1 day** |
| worldtree-data M2 steps 0-11 (catalog→fetch→extract→aggregate→determinism) | a data pipeline | **~1 day** |
| launch kit, legal memo, tailscale research | docs fleets | **~1 day each** |
| fix fleet (hf-restart, ptt-*, send-lost, mic-openplay…) | 2 releases | **2 days** |

**Consequence: any single-slice build is a 1-day unit. A release's honest
cost is NOT its build sum — it is verification + integration + human gates.**

## 2. The bottleneck law (binding for this plan)

> **Codegen ≈ 1 day per slice. The schedule lives in VERIFY/INTEGRATE
> (cross-box, cross-device, e2e, coordination cadence) and in HUMAN GATES,
> which do not compress.**

Planning consequences:
1. Releases are sized by their **verify budget + gate calendar**, not build.
2. Never stack two builds into one lane-day: every build-day gets a verify
   half-day (e2e suite as referee, sandbox stack 8090/4100 next to live).
3. Adding build lanes (more sessions) has ~zero ladder effect. Adding VERIFY
   capacity (devices, seeded testers, emulator greens) compresses wall-clock
   1:1. Hardware requests below ARE the critical path.
4. The labs prove the point: bifrost-net M1 was 1 day of build; its next gate
   (bifrost→bifrost-net→yggdrasil end-to-end in the sandbox) is integration —
   that, not code, is what the calendar now books.

## 3. Compressed ladder

Sizes = build-days (b) + verify-days (v). Serial spine unless marked ∥.

| step | size | contents | hard gate to exit |
|---|---|---|---|
| **pre-wave** | 1b + 1v (+1 parallel docs-day) | repo rename `veraldar/bifrost` + **S2 fix: skill URL pinned to tag**; SECURITY.md + threat model; **S3 fix** (vercel-preview flag); plan/vision reconciliation (review Q4 drift — one ladder source); launch docs vs v0.6/0.7 reality; **HUMAN: brand rework verdict** (freezes lift) | S2+S3 landed — nothing public before the supply-chain fix |
| **v0.7.0** "reliable voice" | 2b + 2v | wedge-fix, ux-mictap, streaming_interval knob (first audio 1.19→0.19s), **edge sherpa = Linux default (no docker)**, known-limits + iOS line | **HUMAN: real-speaker voice A/B (your ears) + phone e2e pass** |
| **WAVE 1** (user fires) | 0b + 1wk calendar | techie preview per checklist (HN day 0, X, reddit stagger, 5-10 seeded cold testers) | **HUMAN: go-public #1 + 3h HN watch** |
| **v0.8.0** "the layman release" | 4-5b (∥ during wave 1) + 4-5v | /pair QR + **S1 device tokens + revoke** + /selfcheck; iPhone auto-setup flow; peering v1 = client-side fan-out over static bridge list (Part 13 — no server hop), tree/slug; TV recipe + mpv skill + verb-scoped auto-allow (S8) | **HUMAN: girlfriend-iPhone pass (pre-registered script, ≤15 min, zero terminal) + TV-PC real device + android-lab green regression. This gate is the wall-clock: builds land mid-wave-1; the gate schedules around HER** |
| **v0.9.0** Windows — CONDITIONAL | 2-3b + 2v, only if fired | fires on wave-1 data (review bar: ≥ ~10 inbound Windows asks); else slot collapses → polish + voice guide + **v1.0 pulls forward ~1 week** | **HUMAN: real Windows box test; data call to fire/skip** |
| **v1.0** "the promise kept" | 3b + 3v | consumer decision tree wired (**HUMAN: Vercel Tier-1 threat-model decision** — ship/defer/reframe), veraldar.org one-pager + video #1 (**HUMAN: design verdict**), **girlfriend re-run as regression**, WAVE 3 | **HUMAN: go-public #2 (consumer story)** |
| **v1.1+** evidence-triggered | — | unified session list across peers (client-side merge); general federation only on demonstrated cross-tree actions | HUMAN: evidence verdict |

**Net: the serial spine is ~3 weeks build+verify; every other week in the
old plan was gate calendar and parallel-lane integration — now stated as
such instead of hidden in "2-3 weeks".**

## 4. Security sequencing (S1/S2/S3 — order is load-bearing, keep)

| debt | severity | fix | lands | why this order |
|---|---|---|---|---|
| **S2** supply chain (README/bootstrap clone mutable main) | HIGH | pin skill URL to tag | **pre-wave, blocks public** | before attention exists; 1-line build, must not ride a bigger release |
| **S3** vercel-preview flag lie | MED | BIFROST_AUTH=tailnet | v0.7 | same release as the first strangers installing |
| **S1** no auth on `/api/*` (tailnet = only boundary) | HIGH | device tokens + revoke at the seam | **v0.8, blocking v1.0** | consumers arrive at v0.8; peering/fan-out rides the SAME token seam — one seam, one fix, both features |

## 5. Parallel vs serial map

**Serial spine (one integration referee — the e2e suite + sandbox stack):**
pre-wave → v0.7 → WAVE 1 → v0.8 (+girlfriend gate) → [v0.9?] → v1.0 → WAVE 3.
Only this lane may touch `pwa/ agent/ deploy/` live paths.

**Parallel lanes (never gate a release; each with own verifier):**
- **yggdrasil lab** (slice 7 green, anthropic dialect): next = bifrost drives
  it end-to-end via OPENCODE_URL in the sandbox (8090/4100). Feeds v1.x
  one-binary core. Human gate: none until assessment read.
- **bifrost-net lab** (M1 5/5): next = yggdrasil/bifrost over its mesh+webrtc.
  The sovereign-transport evidence — v1.x "no LiveKit/Tailscale dependency"
  option. Out of ladder by design.
- **voice-lab** (P2 remainder: CPU bench, FR corpus, streaming STT; P3
  winners): feeds voice-models.md (publish slot: v0.8/v0.9 or the Windows
  slot if fired) + v1.0 emotion tier decision.
- **worldtree-data M2** (steps 0-11 done): standalone; touches nothing.
- **edge Termux arm64**: BLOCKED on **HUMAN: spare-phone session**.

**Coordination cadence (the actual limiter):** claims.md discipline, one
verifier per lane, sandbox-not-live (b1cd9ce law), answer-first fleet law.
The pre-wave "plan = single ladder source" fix is what keeps parallel lanes
from re-coupling.

## 6. All human gates, one table

| gate | when | what it needs |
|---|---|---|
| brand rework verdict | pre-wave | your eyes on the rebuild |
| real-speaker voice A/B | v0.7 exit | your ears, real speaker |
| **go-public #1** (wave 1) | after v0.7 | your go + HN watch (3h) |
| **girlfriend-iPhone** | v0.8 exit | her, an iPhone, pre-registered script (unboxing→talking ≤15 min; push failure = recorded known-limit, decided before she starts) |
| TV-PC real device | v0.8 verify | the TV box + mpv choice |
| Windows fire/skip call | post-wave-1 data | results.md ask count + a real Windows box if fired |
| Vercel Tier-1 threat-model decision | pre-v1.0 | your risk call (ship/defer/reframe) |
| one-pager + video design verdict | v1.0 | your eyes |
| **go-public #2** (wave 3) | v1.0 | your go |
| spare phone | parallel lane | edge Termux run |

## 7. What only the user decides (v2 shortlist)

1. Wave-1 go timing (rec: the day v0.7 gates pass — build lanes run during).
2. Girlfriend gate date (rec: pre-book it NOW — it is the ladder's true
   critical path; everything else flexes around it).
3. Vercel Tier-1: ship / defer / reframe "bring-your-own-box, hosted UI".
4. Windows fire/skip on wave-1 data (rec: honor the ≥10-asks bar).
5. Voice emotion tier (VoxCPM2) in v1.0 or later — after A/B.
6. Whether bifrost-net/yggdrasil graduate to a v1.x "one binary" spike once
   their integration gates pass — evidence-triggered, your call when the
   ASSESSMENT lands.
