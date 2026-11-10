# PERSONA: fake friend deploying (layman-deploy's friend, full form)

source: retrospective-1019 §5 gap list item (5): "scripted fake friend + scratch box +
fake VPS + headless phone, with the failure paths (bad QR, expired token,
quota mid-onboard)"; layman-deploy lab holds impl/sim as empty dirs (BUILDING) — the
persona spec is the retrospective's, the sim legs land here first and layman-deploy
reuses them (that lab's rule 10-09/10-10: ALL phases simulated before any real VPS).

## goal
Install and reach the tree following printed instructions only. Success = the friend
holds a conversation on their own phone-equivalent through their own root+trunk.
This persona owns the WORLD-BUILDING legs of sim-world (the friend builds the sandbox
their visitors will use) and the failure paths.

## procedure (friend-deploys-trunk@1 — the sim form)
1. Start from nothing: no sim stack running (sim-stack.sh down first).
2. Follow ONLY the instructions a friend would get (the printed runbook line: one
   command). If the printed command is more than one line of copy-paste, that is a
   finding (layman bar).
3. Bring up the world (sim-stack.sh up ≙ "install the root").
4. Verify the three organs answer (app, root, upstream) the way the runbook's
   health line tells the friend to check — a friend can run a health URL, not a debugger.
5. Walk cold-visitor-onboarding@2 on the fresh world (persona reuse — the friend
   becomes the visitor).
6. Failure paths: after onboarding, kill the upstream mock (≈ quota death) → the
   friend must SEE it (banner/degrade), not sit in silence.

## tools
- shell for exactly the one printed command (everything else = finding).
- Playwright as the headless phone.

## stop conditions
- world up + visitor leg done → PASS-candidate
- the one-command install fails → FAIL + finding INSTALL-BROKEN (world bug — this is
  a sim failure that IS a product finding: the spine is shipped code)
- friend needs a second command → finding LAYMAN-BAR (instructions too hard)
