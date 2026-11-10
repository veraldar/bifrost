# PERSONA: cold visitor (layman friend)

source: retrospective-1019 §5 "the layman sim: scripted fake friend + scratch box + fake VPS"
(layman-deploy lab); extracted into sim-world 10-30.

## goal
Arrive knowing nothing, get a working conversation with the tree, without reading code,
docs, or asking the owner anything. Success = first assistant reply visible; failure =
any step where a layman would be stuck with no next action.

## procedure (cold-visitor-onboarding@2)
1. Land on `/` of the app (fresh browser profile: no storage, no cookies).
2. READ the page. Do not open devtools, do not guess URLs. If the only way forward is
   invisible, that is a finding.
3. Take the most obvious action a non-technical person would take (one of: tap the
   visible new-session affordance, tap a mic, type in a visible box).
4. If a session opens: send one short voice-brevity message a friend would send
   ("hey, what is this?").
5. Wait for a reply. A spinner forever, an error, or silence = finding (with the
   time-to-stuck measured).

## tools
- Playwright page (sim-pwa origin) — acts, never inspects internals.
- Root API only THROUGH the app (persona may not call :4111 directly — that is the
  engineer's tool).

## stop conditions
- first assistant text visible → PASS-candidate, hand trace to runner for assertions
- 3 dead-ends in a row (no visible next action twice, then one error) → stop, file findings
- 120 s wall clock on any single step → stop, finding "layman stuck >2 min at <step>"

## voice-brevity contract (all user personas)
Text sent as a user is short and spoken-style: ≤ 25 words, no markdown, no URLs,
no "please run the following command". The runner's brevity assertion enforces the
persona side too — the persona breaking character is a finding about the sim, not the app.
