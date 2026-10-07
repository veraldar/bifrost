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
   And until 10-04, delegations were UNMEASURED — duration, exit code, output
   location and stalls existed only in the user's account-usage page. Fixed
   by fleet rule 10-04 below.
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

## Rule 10-02: REBUILD THE LIFE, NOT THE SURFACE
Rebuilding a tool from its API surface is rebuilding a shadow. The API shows
shapes; it hides time-dependent behaviors (compaction, migrations, backups,
token growth) that only appear over weeks of real use. Prompt form:

> Before writing code: study the data, files, DB, and logs; reconstruct how
> the system was actually used — over days, weeks, and months. Infer what the
> user needed but never had to ask for. Where the original falls short of the
> user's interest, do not copy the shortfall — build the better version.
> Present your reconstructed usage model and your planned improvements before
> building; one confirmation, then build.

The three upgrades this carries: the time dimension is explicit (compaction
gets caught), the inference is user-centered (best behavior FOR THE USER —
the missing tools would have been built), and the usage-model checkpoint
exposes gaps before the first line of code. The owner's lived memory is a
requirement source — the user knows behaviors no interface exposes.

## Fleet rule 10-04: MEASURED DELEGATION — all `claude -p` goes through agi-run.sh

Every lab delegation to Claude runs through `scripts/agi-run.sh`. A bare
`claude -p` call is forbidden: it leaves no evidence (duration, exit code,
output location) and stalls invisibly until someone notices the account usage.
An unmeasured delegation did not happen.

```bash
# the ONLY blessed delegation shape (session name mandatory):
scripts/agi-run.sh -s <SESSION-NAME> -m <model> "the prompt"
scripts/agi-run.sh -s <SESSION-NAME> -m <model> -f prompts/m4.txt
echo "prompt" | scripts/agi-run.sh -s <SESSION-NAME>
```

What the wrapper enforces (nothing to remember, all automatic):
- `--dangerously-skip-permissions` + model ALWAYS pinned (`--model`, never the
  account default) — the playbook's M0 lesson, mechanized.
- Evidence per attempt lands in `~/Work/bifrost/.agi-log/log.tsv` (gitignored):
  runid, date, session, model, start, end, duration_s, exit code, status,
  output file path. Human-readable result at the logged `.txt` path; raw
  stream + stderr alongside it.
- Stall detection: the run streams (`--output-format stream-json`); if the
  output has not grown for 10 min the wrapper kills it and retries ONCE;
  a second stall (or failure) is reported as a failure in the log. Plain `-p`
  text output is silent until the end — never hand-roll monitoring on it.
- Fleet view any time: `scripts/agi-status.sh` → runs today (count,
  success/fail/stalled), currently running with elapsed time, last failure.

## Fleet rule 10-04b: MODEL LADDER — Opus judges, Sonnet 5.5 does the rest

Every delegation picks the CHEAPEST model that does the job well:

- **Opus** — judgment, architecture, hard builds, final-authority documents
  (evals, decisions, designs, anything with a verdict).
- **Sonnet 5.5** — research passes, reviews of drafts, doc passes,
  verification reads, second opinions, mechanical summaries.

Decompose accordingly: a decision doc = Sonnet research pass → Opus final
judgment → Sonnet verification read of the result. Same `agi-run.sh` wrapper,
different `-m`; a Sonnet pass that disagrees with an Opus verdict escalates
BACK to Opus with the disagreement attached — Sonnet never overrules.

Sessions and drivers check `agi-status.sh` the same turn they check labs: a
delegation with no log line, or RUNNING for hours, is a stalled lab — same
handling as failure cause #1.

## Rule 10-03: REBUILDS RESTART THE SERVER
A `.next` rebuild under a running `lk-pwa` swaps chunk files the running
server still references — browsers holding old HTML get ChunkLoadError and
the app crashes client-side while every probe says 200. Rules:
1. Never `npm run build` the live tree without restarting `lk-pwa`
   immediately after (build+restart is one operation — scripts/deploy.sh
   does build+restart+probe+gate).
2. Long builds happen in worktrees, not the live tree.
3. Probes must check the page AND a chunk asset — a 200 HTML with dead
   chunks is the failure shape probes miss.

## Rule 10-04: HARDWARE/NEW-DOMAIN LABS — THE CONCRETE DELIVERABLE PATTERN
The hardware lane needed 4 user pushes. Root causes: an open-ended mission,
toolchain gaps discovered mid-flight, blockers absorbed silently. The
correct pattern for any NEW-DOMAIN lab (hardware, ML training, anything
with an unfamiliar toolchain):
1. **M0 ENFORCED before the mission**: the tool must run (extract, verify
   --version) before any design/build work. Missing prerequisites get
   installed or escalated AT M0 — never mid-mission.
2. **File-exact deliverable spec**: the paths, the formats, the acceptance
   command per deliverable. "See how far you can get" is not a spec.
3. **Every long op detached** — Rule 10-02 applies doubly: message arrival
   reaps in-process children (the triple-murder lesson).
4. **Blockers surface at attempt ONE** — a session flagging retries without
   executing violates BLOCKED=VISIBLE; the driver escalates at the second
   miss, not the fourth user push.
5. **The coordinator verifies the execution model** — not just the
   delegation: detached? pollable? committed where?

## Rule 10-05: THE THREE LAB LAWS (every lab, every model)
1. **THE LOOP**: every lab runs the self-improving cycle — build → test →
   validate → mine findings → propose v+1 → build v+1 → loop. The cycle
   command exists (ygg-sim pattern); the VERSIONS.md ledger logs each cycle.
   A lab without the loop is a one-shot, not a lab.
2. **THE ONLINE CHECK**: every milestone compares the work to the online
   state-of-the-art before calling it done — the external reference is the
   ground truth, not the lab's self-assessment. (Proven: the Parakeet duel,
   the tailscale research, the YouTube provenance.)
3. **THE COGNITIVE MATCH**: the prompt depth/freedom scales with the model's
   level — structured specs for small models, goal+data+freedom for frontier
   models (Rule 10-02). The same brief to every model wastes the strong ones
   and drowns the weak ones.

## Rule 10-06: THE DUAL-PATH LAB (external knowledge vs internal inference — then compare)
Every major build runs TWO paths in parallel, then merges best-of-both:
- **PATH A — external**: research the online state-of-the-art (aggregated best
  data/approaches/prior art), build with full external knowledge.
- **PATH B — internal**: build with ONLY our materials — our data, our
  inference, our judgment (the Rule 10-02 life-study, no external lookup).
- **THE COMPARE**: diff the two results — (a) what the external knowledge
  added (our inference gap = the AGI-ceiling measurement), (b) what our
  unique context captured that the external missed (our moat), (c) the
  best-of-both merge ships.
The compare is the learning engine: each dual-path run measures our true
capability and compounds the doctrine. The results are never thrown away —
the merge is the ship.

## Rule 10-07: EVERY LAB IS A SIMULATION — THE WORLD SETS THE CADENCE
The doctrine generalizes: every lab is a simulation of a piece of reality,
each with its VERSIONS ledger, each evolving from FOUR sources:
1. The incidents (every production bug = a missing scenario)
2. The environment drift (models, providers, transports)
3. The usage shifts (the store data, the life-study)
4. THE HUMAN-WORLD SHIFTS — the adoption, the assimilation, the layman
   feedback (the girlfriend test is an environment probe)
The human environment now changes at AI speed (the assimilation pace = the
development pace). The labs' evolution cadence must match the environment's:
CONTINUOUS, not per-release — the driver/watchdog cadence, the cycle command
per lab, the ledger per lab. A lab that evolves per-release drifts from
reality between releases. The fleet that evolves continuously never does.

## THE RESEARCH FEED (10-03, user): papers auto-discovered, concepts feed the labs
The labs don't invent methodology alone — the state-of-the-art is monitored
and absorbed: arXiv/Google Scholar queries per cadence (the self-improving
agents, LLM-agent self-modification, agentic search, agent reliability),
relevant papers surfaced, the applicable concepts extracted into this
playbook and the lab briefs. Foundation paper: **SelfSearch** (arXiv
2609.37968v2, SNU 2026) — agents modifying themselves from records of
previous self-improvement episodes: up to 11.2pp gains, $4.03 search cost,
82% Terminal-Bench. Our VERSIONS.md ledgers are those records; our cycle is
that search. The formal methods (episode records, reward-free search,
population-of-agents search) upgrade the loop as they publish.
