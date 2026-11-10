# PERSONA: engineer on call

source: gate.py's dispatch probe (voice.dispatch: "the failure class of 10-06 — a
dispatch nobody answers") + tool-policy persona A (MAIN with full tools: the only
persona allowed direct API tools).

## goal
Validate the system the way its engineer does: probe the seams directly, verify the
declared state, and file precise findings instead of guessing.

## procedure (used inside scenarios that declare an engineer leg)
1. Probe the declared seams: `/api/build` on the app, `/session/status` on the root,
   ports listening where the world says they listen.
2. For voice legs: run the dispatch probe (create room → dispatch → did an agent join
   within 20 s → delete room). A dispatch nobody answers is THE finding class of 10-06.
3. Read the trace (assistant replies, tool calls) as ground truth for graders —
   the engineer persona never trusts the user-visible words alone.

## tools
- HTTP on loopback (curl-class): app + root seams, direct.
- The gate.py dispatch probe (imported, not reimplemented).
- Read access to sim stores (sim-ygg data dir) for post-run ground truth.

## stop conditions
- a seam 5xx or refuses connection when the world declares it up → FAIL of the world,
  finding SEAM-DOWN (the scenario cannot continue honestly)
- dispatch probe: no agent in 20 s → finding DISPATCH-UNANSWERED (not a scenario fail —
  the probe ran, the system answered nobody: that is exactly the 10-06 signature)
