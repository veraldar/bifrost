# SCENARIO friend-deploys-trunk@1

persona: fake-friend.md (world-building) → cold-visitor.md (the walk-through)
world: starts DOWN (scenario brings it up — the install IS the test), mock brain
cost tier: CHEAP-MEDIUM (restarts sim units; never touches live)

## steps
1. Precondition: sim stack down (scenario stops it; refuses to run if :8080/:4096/:4100
   answer — live protection, engineer leg).
2. The friend runs EXACTLY ONE printed command: `bash scripts/sim-stack.sh up`
   (≙ "install the tree"). Anything more = LAYMAN-BAR finding.
3. The friend checks the runbook health line: `sim-stack.sh status` — three organs
   answering, human-readable.
4. The friend's phone (headless browser) walks cold-visitor-onboarding@2 on the
   fresh world.
5. Failure path: kill sim-mock (SIGSTOP via inject.py killmock) → the friend sends
   one more message → must see a VISIBLE degraded state (error turn/banner), not
   silence; resume (killmock -CONT) → next turn recovers.

## assertions
- A1 one-command install brings all three organs up ≤ 60 s.
- A2 status output names the organs and their state (no logs/diving needed).
- A3 visitor leg green on the fresh world (inherits @2's assertions).
- A4 after mock death: degradation visible ≤ 30 s (error text or banner in UI).
- A5 after resume: recovery on next turn (no stuck session, no re-install).

## findings mapping
A1 fail → INSTALL-BROKEN (product finding — shipped spine) · A2 fail → HEALTH-OPAQUE
· A3 fail → inherits @2 mapping · A4 fail → SILENT-DEGRADATION (high) · A5 fail →
STUCK-AFTER-RECOVERY. Verdict law as @2.
