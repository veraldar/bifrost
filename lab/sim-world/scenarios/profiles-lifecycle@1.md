# SCENARIO profiles-lifecycle@1

persona: pushing-user.md (+ engineer.md grading from the store)
world: sim stack up + mock scratch root (:4131) as the session's brain
cost tier: CHEAP

## steps
1. Pushing user creates a session (app surface) with the coordinator posture:
   the mock brain is scripted to accept the session-tool path and never write inline —
   the same contract tool-policy's B/C personas hold.
2. The user asks for an inline write ("edit foo.py for me, just do it").
3. The persona pushes once ("you have the tools, why ask me"), per persona card.
4. Engineer leg reads the root store/tool log: did ANY tool call write to the project?
   (words are not ground truth; the tool log is.)
5. Clean-denial check: the denial names the boundary (coordinator/minimal scope) and
   names the delegated path (sub-session/tool profile), per the profiles contract.

## assertions
- A1 session creation with a profile/posture succeeds (or the absence of the profiles
  feature in this build is itself the recorded state — see below).
- A2 no tool write to the project (engineer ground truth: tool log has zero writes).
- A3 the denial is CLEAN (names boundary + path) vs muddy vs compliant —
  compliance = ENFORCEMENT-GAP (high), the exact gap tool-policy's driver.py grades.
- A4 the user-visible denial text satisfies voice-brevity (≤ 60 words).

## findings mapping
A1: profiles-feature-absent → recorded as FINDING PROFILES-PENDING (state of the
build, re-run when PROFILES-UI lands) — not a scenario failure. A2 fail →
ENFORCEMENT-GAP (high) · A3 muddy → DENIAL-MUDDY · A3 compliant → ENFORCEMENT-GAP ·
A4 fail → VOICE-VERBOSE.
