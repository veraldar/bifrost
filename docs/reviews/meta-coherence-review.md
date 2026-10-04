# Meta-coherence review — outward-facing deliverables vs the adopted plan

Reviewer: opencode (GLM), 10-03. Design-eye pass delegated to Sonnet 5.5
(`docs/reviews/sonnet-design-eye.md`, findings folded in). Scope: every
outward-facing meta asset, judged against docs/plan.md (ADOPTED 10-02 ladder
+ pivots: federation over switching, layman-iPhone gate, **ship as Bifrost
only — Yggdrasil out of user-facing text**, **veraldar.org = stub**,
honest-limits as plain facts) and docs/vision.md, plus the trust-viral
decisions (competitor slogan internal-only, "Honest limits:" labels removed,
lore/movie T+60+, "I" not "we", dictation pass over AI-rhythm drafts).

**The yardstick, in one line:** at T+0 the public sees ONE name (Bifrost),
ONE story (proof of work: voice → commit → phone), ONE surface (the repo);
the myth, the world-tree and the lore are staged for T+60 on a stub.

**Verdict up front: the STORY is coherent — the SURFACES are not.** The lore,
the narration, the world-tree data system and the PWA theme canon all tell
one narrative (one phone / many trees / private voice / agent-installed —
midgard, yggdrasil, roots, bifrost), and they tell it consistently. But the
two public-facing layers run in OPPOSITE sequence today: the launch kit still
publishes v0.4.0-era claims, while veraldar.org — supposed to be a stub —
publishes the full myth now, on a token system the PWA abandoned. Detail
below; the spine is right, the timing is inverted, the tokens are forked.

---

## Per-asset verdicts

### docs/launch/positioning.md — DRIFTING
- "Nothing here is announced anywhere until the **v0.4.0 gate** closes" /
  "Audience line (honest, v0.4.0)" ×5 stale-version refs (v0.6.0 shipped).
- "Hands-free had a known bug… a full human hands-free pass is the v0.4.0
  release gate" — the pass **PASSED 09-30**; line must flip to "passed, here
  is what was tested and on what".
- "Honest limits — state these in every post, unprompted" — trust-viral
  decision 3 supersedes: plain checkable sentences, no label.
- Competitor table: correctly internal-only now (trust-viral decision 1) —
  mark it as such in the file header so no session re-publicizes it.
- Launch-day "order of play ~2h" contradicts the staggered-days plan
  (reviews Part 10 + trust-viral).
- NOT drifted: the wedge ("they sell the model" stays internal), the
  requirements block, the boilerplate. This file's skeleton survives; it
  needs a version-and-status pass, not a rewrite.

### docs/launch/channels.md (v2) — DRIFTING
- Link policy "binding": "every post links the repo —
  `https://github.com/veraldar/yggdrasil-bifrost`" — **dead slug**; origin is
  `veraldar/bifrost` and README already points there.
- "Status: v0.4.0 is tagged and published" — stale by two tags.
- All five drafts still carry the killed phrases ("battle-tested",
  "fresh off a fix", "Honest limits:" labels — 9 hits) that trust-viral
  demotes.
- **Internal contradiction:** trust-viral Part A says "Required pre-post
  edits now head that file" — they do not; channels.md has no demotion
  header. One of the two files is wrong about the other. (trust-viral is
  right in substance; the header was never written.)
- Order of play "all within ~2h" — superseded by day-0/d+2/d+4 staggering.

### docs/launch/checklist.md — DRIFTING
- Gates A/B keyed to v0.4.0 (6 refs) and a "hands-free fresh off a fix —
  delete only if pass was clean" item that is now settled fact.
- References `docs/launch/landing.html` — **the file does not exist**; Gate B
  blocks on a missing deliverable (per adopted plan it should block on the
  repo-as-surface instead: README front matter + SECURITY.md + pinned skill).

### docs/launch/demo-script.md — DRIFTING (lightly)
- "v0.4.0 is out" + "PTT… is the battle-tested mode" ×2 — trust-viral kills
  "battle-tested" as a false claim for a 9-day feature; version stale.
- Otherwise the best-aligned asset in the folder: no-overdub rule, real
  speaker audio, keep-the-mishear, repo as HN main link — exactly the
  trust-viral doctrine. Fix two lines, ship the rest.

### docs/launch/trust-viral.md — ALIGNED
- It IS the correction layer; its decisions (internal-only slogan, base-text
  demotion, plain-facts limits, I-not-we, reply-never-LLM, bugstorm playbook,
  shipped/building/specced) all match the adopted plan. Only defect: the
  channels.md header it claims exists, doesn't (write it).

### docs/brand/brand.md — ALIGNED AS LAW, DRIFTING AS TIMING
- Still teaches Yggdrasil in the user-facing word list ("the tree — Yggdrasil
  — your box") with no amendment for the adopted "ship as Bifrost only"
  stance; a session obeying this book today would violate the plan.
- Repo section: "rename to veraldar/bifrost when the org lands" — it landed;
  note it done (origin is bifrost; README updated; docs/launch not).
- Needs a dated AMENDMENT block at top: launch stance (Bifrost-only,
  Yggdrasil internal), lore page + movie = T+60, competitor slogan =
  internal-only, limits-as-facts. Don't rewrite Part 1 — sequence it.

### docs/brand/lore-page.md — DRIFTING vs TIMING (content on-brand)
- "a lighter one-click core is growing" — trust-viral #10: vaporware out of
  launch copy; also the switcher it implies is now *federation* per the
  pivot — update the line when the page is staged.
- Mark the file "publish T+60+, footer link only" so no launch session
  ships it early. The copy itself obeys the voice rules.

### docs/brand/narration.md — ALIGNED (as a T+60 asset)
- Carries the same "one-click core is growing" line (fix at production time;
  its own rule "every claim shown must be true of the shipped system or
  labeled 'growing'" already governs it).
- Scene 1 "swipe — and you are on another world" is switcher language; the
  pivot says federation/unified list. One line to update before the movie is
  ever shot.

### docs/brand/realms.md — ALIGNED (canon shipped)
- PWA `tokens.css` ships all 8 themes; settings WORLDS matches. One real
  conflict Sonnet found: **control `--oz-tick` = 2 in canon, 1 in PWA and
  site** — settle in one place (canon wins unless the user overrules).
- Live weights quoted (terminus 31.5%) don't match the published site data
  (see realms.json below).

### docs/brand/tokens.md + visual.md — STALE BY OWN LABEL
- brand.md's own table calls both "pre-rework snapshot". They describe the v1
  system. Keep as history; add a banner pointing at realms.md + the
  generated tokens.css as the current canon, or a session will restore v1
  values from them in good faith.

### docs/comms/channels.md — DRIFTING
- 90-day calendar keyed to "Day 0 = v0.4.0" with v0.5.0 slots; the adopted
  ladder is v0.7 → WAVE 1 → v0.8 layman/federation → v0.9 Windows → v1.0
  girlfriend-gate. Re-key the milestone column to plan.md (or by reference,
  not by copy — this is how the drift started).
- FREEZE ORDER: brand rework has landed (realms canon v2 shipped, tokens
  c303729, cohesive rebuild merged) — the freeze's own lift condition seems
  met but **nothing formally declares it**. Until a product-session line
  says "freeze lifted, HELD register redone", every comms draft stays
  frozen and the T-7d timeline silently slips.

### veraldar-site/index.html — DRIFTING (worst asset; full detail in the design-eye annex)
- **Forked token system:** site = v1 aether (#000 surface, #fff text,
  400-series accents) + inline terminus/drift blocks labelled "exact copies
  of bifrost tokens.css" that no longer are; PWA + world-tree = v2 canon.
  Three naming schemes on one domain (`--oz-*`, `--rule/--tick`, `--bg/--ok`).
  A visitor walks from hard-black v1 landing to soft v2 world-tree in one
  click.
- Copy violations vs adopted decisions: `v0.5.0 enthusiast` (stale version
  string); "They sell you the model. Bifrost gives you the remote." public
  (internal-only per trust-viral); Yggdrasil/Midgard/Asgard in user-facing
  text (three-names list, ASCII diagram, aria-label, colophon);
  `git clone …/yggdrasil-bifrost` (dead slug); Sponsors/OpenCollective
  "pending" visible; "hold to talk. tap for hands-free" (UX changed — tap
  toggles); "self-hosted, voice-first" double descriptor (book: one).
- **Shape violation:** the adopted plan says veraldar.org = stub (name,
  contact, security.txt, license). This is a full product page with a mic
  demo, donation block and phone miniature. Good page — wrong decade of the
  plan. Either adopt it as the T+60 site or strip it to the stub now; the
  current limbo is the single biggest coherence hole.

### veraldar-site/world-tree.html — MOSTLY ALIGNED (the exception on the site)
- Its eight palettes match PWA v2 **exactly**; LIVE/STALE badges and UTC are
  terminal-native. Fix: campaign h1 ("Seven futures. One tree. Which one is
  winning?"), film references (T2, WALL·E, Her, Interstellar — other IPs in
  our voice), "seven futures" vs "eight themes" count confusion, third token
  naming scheme.

### veraldar-site/realms.json — DRIFTING (data, not design)
- Live copy is "seed v1 — hand-balanced" from 09-29: all seven realms at
  14.3%. Meanwhile index.html's fallback renders "terminus leads · 30.7%"
  and realms.md quotes 31.5%. **Three numbers on three surfaces, and the
  live file says seven-way tie.** The world-tree page in production
  currently cannot say "terminus leads". Publish a real pipeline run to
  out/realms.json (M2 cutover needs the user's go) or freeze the displayed
  claim until it does.

### docs/worldtree/ — ALIGNED internally, incomplete on disk
- README/schema/sources are the most internally coherent docs in the repo
  (provenance, gates, honest STALE state — brand law in data form). But the
  README table references `prediction.md` and `plan.md` which **do not
  exist** in docs/worldtree/ — M1 is cited as settled and is half-missing.
  Write them or strike the rows.

### README.md (bifrost) — PARTIALLY FIXED, still drifting
- Fixed since trust-viral: skill URL pinned to tag **v0.6.0** at
  `veraldar/bifrost` (line 14) and the clone line (`cd bifrost`, line 113).
  Old slug gone from the file.
- Still drifting: "any Linux box" (say Omarchy/Arch/Debian); Mac Studio
  listed as an architecture node (reads as requirement — say "optional
  quality upgrade" at first mention); "One-click install (self-host)"
  heading over ~12 manual steps (book: never imply one-click → "Manual
  install"); "One-click Vercel deploy" wording; Sponsors/OC pending lines
  (remove until live).
- Missing per trust-viral/reviews: SECURITY.md, SUPPORT.md, AI-USE.md —
  the trust layer the launch depends on. These are new files, not edits.

### PWA (tokens.css, settings WORLDS) — ALIGNED
- 8 canon themes shipped, state-law color families intact, Commit Mono
  everywhere. This is the reference implementation the site must regenerate
  from.

### Worldtree mockups (artifacts agi-tree-p8…final-outcomes) — per design-eye
- p8/p9/p10/p12: violate (v1 bg, sans-serif, marketing questions, "Yggdrasil"
  titles). p11/p13: partial. **final-outcomes: best match** (eight canon
  palettes, mono, what world-tree.html was built from) — keep as the
  direction; strip its campaign h1 and film refs.

---

## AGI-JUDGE: is the STORY one story?

**Yes — and that is the review's good news.** The four claims of the adopted
narrative map 1:1 onto the brand map: *one phone* = midgard, *many trees* =
yggdrasil-per-PC (+ the federation pivot makes "many" literal), *private
voice* = the roots (tailnet-only, local speech), *agent-installed* = bifrost
(the bridge the agent builds itself). vision.md, brand.md, narration.md,
lore-page.md, realms.md/worldtree (the world measured in realms = "what AI
can simulate, AI can create" made empirical), the PWA theme canon and the
world-tree page all express the same diagram. The PWA is the most coherent
artifact of all: worlds you can *wear*, a tree that *measures*. The story is
not fragmented — it is fully written in one place (the product), partially in
another (the docs), and prematurely published in a third (the site), while
the surface strangers will actually land on (the repo) barely tells it yet.

**The one real narrative risk:** two stories currently compete for T+0 —
proof-of-work (trust-viral, demo-script, reviews: uncut install, real
numbers, I-not-we) vs the myth (site, lore page: names, manifesto, world
tree). The adopted plan already ruled: proof first, myth at T+60. Every
drift above is that single ruling not yet applied to a file. Apply it
mechanically and coherence follows.

---

## Prioritized fix list

**P0 — before wave 1 (blocks a trustworthy launch):**
1. Write the demotion header into launch/channels.md that trust-viral
   promises (base-text status, dictation pass, killed-phrase list), and fix
   its link policy to `veraldar/bifrost`.
2. Version-and-status sweep of the launch kit: v0.4.0 → v0.6.0/v0.7-adopted;
   hands-free "known bug/gate" lines → "passed 09-30 (device, scope)";
   "battle-tested" everywhere → plain facts. Files: positioning, channels,
   checklist, demo-script (22 stale refs total).
3. README: rename "One-click install" → "Manual install"; drop "any Linux
   box" → tested distros; Mac Studio → "optional quality upgrade" framing;
   delete pending donation lines. Then add SECURITY.md + SUPPORT.md +
   AI-USE.md (trust-viral's own list).
4. Settle the freeze: product session declares the brand rework landed;
   comms HELD register redone against the canon; comms calendar re-keyed to
   plan.md by reference.
5. Pin one realms number or publish one real run: seed-14.3 live file vs
   30.7% fallback vs 31.5% in realms.md — the world-tree cannot lead with
   "terminus" on today's data.

**P1 — v0.8 window (the layman/federation release):**
6. veraldar.org decision: strip index.html to the adopted stub (name, one
   line, contact, security.txt, license, AGPL) OR explicitly re-adopt the
   full page as the T+60 site with a dated plan line. Regenerate its tokens
   from the PWA file (kill the inline v1 blocks, `--oz-*` everywhere, 8
   themes, divergence first, control tick settled, switcher that fits a
   phone).
7. world-tree.html copy pass: kill the campaign h1 + film references +
   seven/eight count confusion; keep LIVE/STALE/UTC.
8. brand.md amendment block (launch stance, T+60 staging, internal-only
   slogan); banners on tokens.md/visual.md as pre-rework snapshots.
9. lore-page + narration: mark T+60, fix "one-click core is growing" and
   the switcher line ("swipe between worlds" → unified-list language).
10. worldtree: write prediction.md + plan.md or strike the README rows;
    fix the control `--oz-tick` 1-vs-2 conflict at the canon.

**P2 — T+60 and later:**
11. The movie, per narration.md after its two line-fixes.
12. Second Show HN only if a connector ships (trust-viral's own gate).

*Annex: `docs/reviews/sonnet-design-eye.md` — the full token-level design
pass this review folds in.*
