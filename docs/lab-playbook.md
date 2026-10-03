# Lab playbook — how to run a lab that actually finishes

Written 10-02 from the voice-lab (SUCCESS) vs yggdrasil-lab (FAILURE) comparison.

## The post-mortem in one line
voice lab = narrow slice + user in the loop + preinstalled tools → shipped.
yggdrasil = open-ended essence + spawned-and-abandoned + missing toolchain →
3 messages, 1 day, zero output.

## Failure causes found (evidence-based)
1. **No driver** — a session prompted once and left alone stops at the first
   milestone. Sessions do not self-continue.
2. **Missing prerequisites treated as blockers** — yggdrasil found "no Rust
   toolchain" and stopped, instead of installing it (voice lab never hit this:
   bash/python were preinstalled).
3. **Delegation seam unproven at scale** — `claude -p` in headless mode STOPS
   AND ASKS FOR PERMISSION before writing files (verified 10-02, M0). Without
   `--dangerously-skip-permissions` (non-root) there is no autonomous run.
4. **Open-ended scope** — "the essence of opencode" has no finish line; the
   voice lab's "server that round-trips 7/7" did.

## The procedure (every lab follows this)
1. **M0 — prove the critical seam small, BEFORE the mission**: one file, one
   command, one verifiable output. If the seam is "delegate to X", prove X
   writes and runs one file. Prerequisites get INSTALLED at M0, not noted.
2. **Narrow vertical slice** — a deliverable with a hard verification command
   (`curl this → that`, `7/7 pass`). "Rebuild the essence of X" must be cut
   into slices that each end green.
3. **Active driver** — the spawner prompts the lab at EVERY milestone and at
   every coordinator session-turn. A lab that went one full turn without a
   prompt is considered stalled; the driver re-prompts with "continue at
   milestone N" before anything else.
4. **Commit per milestone** — evidence lands in git as it happens, not at
   the end.
5. **Blockers get surfaced, not absorbed** — a missing tool is installed; a
   failed step twice escalates to the user. Silence is never a state.

## Driver contract (coordinator side)
- check in every session turn: labs first ("continue at milestone N")
- know each lab's current milestone + next prompt, always
- a lab with no reply for one coordinator turn gets re-prompted; two turns
  gets its mission re-cut smaller

## Fleet rule 10-01: BLOCKED = VISIBLE
A session that cannot proceed because it needs the user (account access,
physical presence, a decision) must post an artifact report or ask in-chat
— and stay loud until answered. Going dormant silently is a failure mode
(same class as stalling: absorbed blockers).

## Creative (AGI-design) labs — the brief that worked (10-02, veraldar outcomes page)

Design-by-checklist kills AGI craft. The winning shape, after an A/B:

- FEED: brand palettes only (theme JSONs) + the live data contract (fetch shape,
  provenance, fallback rule) + the story beats (chapters, their order, one line each).
- DO NOT FEED: existing HTML, the old asset to "reuse", layout/animation/typography
  rules, touch-target/tech checklists. Compliance eats taste.
- Say "everything else is 100% yours — astonish" and mean it.
- Two passes still fine: design free, then a data-spine pass — but never let the
  data pass redesign.
- Identical minimal briefs to 3 parallel labs → 3 genuinely different designs.
  Prescriptive briefs to 3 labs → 3 near-identical ones.

## Rule 10-02: THE INTERFACE LIES — STUDY FILES, DATA, AND USAGE
Rebuilding a tool from its API surface is rebuilding a shadow. The API shows
shapes; it hides time-dependent behaviors (compaction, migrations, backups,
token growth) that only appear over weeks of real use. A rebuild attempt must:
1. Go through the FILES and the DATA of the original (its store, its logs,
   its config) — not only its endpoints.
2. INFER THE USAGE PATTERNS by itself: how was this actually used? What did
   long use exercise (compaction = usage-born; tools = usage-born)? Make
   those assumptions explicitly and design for them.
3. Treat the owner's lived memory as a requirement source — the user knows
   behaviors no interface exposes.
The goal is not copying the API; it is copying the LIFE of the system.
