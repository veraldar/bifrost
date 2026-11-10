# PERSONA: LLM battery (the four batteries)

source: harness-bench (tasks.yaml as data, adapters/base http+sse, grader.py
deterministic string/code graders, ledger rows). Extracted as a persona: the
"many users" of TESTING.md are often just batteries — cheap, deterministic-grade,
parallel.

## goal
Be the background population of the world: N sessions doing ordinary turns so that
scenarios measure behavior under realistic multiplexing, not a lonely single user.

## procedure
1. Load tasks.yaml blocks tagged `battery` (voice-brevity + extraction classes; the
   code class stays out of sim — hidden pytest in the world is P6 material, not needed
   for population).
2. One session per task, through the scratch root, using the harness-bench adapters
   imported directly (sys.path insert, `from adapters.opencode import OpenCode`).
3. Grade with harness-bench's grader.py (contains / not_contains / word_cap).
4. Emit one ledger row per turn (harness-bench shape), sim-world rows tagged
   `lab=sim-world`.

## tools
- harness-bench adapters + grader (imported python modules, zero reimplementation).
- The scratch root only (never :4100, never :4096's store).

## stop conditions
- adapter raises (root down/5xx) → the battery reports the failure and continues
  other tasks; ≥50% task failures → world FAIL (SEAM-DOWN)
- a grade fails → FINDING (battery content wrong for this world), scenario continues
