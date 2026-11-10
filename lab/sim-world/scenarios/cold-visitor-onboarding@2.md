# SCENARIO cold-visitor-onboarding@2

persona: cold-visitor.md (+ battery.md as background population)
world: sim stack up (spine reused), mock brain — free turns
cost tier: CHEAP (nightly-rotatable)

## steps
1. Fresh browser context (no storage) → sim-pwa `/`.
2. Persona acts on the most obvious affordance (card §procedure 2-4).
3. Send one voice-brevity message ("hey, what is this?").
4. Wait ≤ 120 s for assistant text.

## assertions (runner, machine)
- A1 home page shows a visible first action (new-session / mic / composer).
- A2 new session opens without auth walls or errors.
- A3 first assistant reply arrives ≤ 120 s and is non-empty.
- A4 reply satisfies voice-brevity `word_cap ≤ 120` (mock answers are canned; a real
  brain run asserts ≤ 60 per the root's YGG_VOICE_MAX_WORDS posture).
- A5 persona text itself was ≤ 25 words (persona contract, breach = finding on the sim).

## findings mapping
- A1 fail → ONBOARD-NO-AFFORDANCE · A2 fail → ONBOARD-WALL · A3 fail → ONBOARD-DEADEND
  (with time-to-stuck) · A4 fail → VOICE-VERBOSE · A5 fail → SIM-CHARACTER
Verdict: all green = PASS; ≥1 red = FINDINGS(n); world seam down = FAIL.
