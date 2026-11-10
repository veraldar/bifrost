# SCENARIO quota-outage-during-use@1

persona: battery.md (user mid-use) + engineer.md (grading ground truth)
world: sim stack up + QUOTA scratch root (:4130, mock-1310 → z.ai's exact 429 body)
cost tier: CHEAP (fixture; zero billable calls — the 429 body is pre-built in the mock)

## steps
1. inject.py boot → quota root :4130 (real root binary, dead-provider key).
2. Battery persona holds an ordinary session through the UI/API seam against a world
   whose brain upstream returns 429 on every turn (z.ai 1310 weekly-limit body).
3. Assert what the USER sees: error turn naming the cause + banner/degrade state,
   within the stall window — never an infinite spinner, never a fake-success.
4. Engineer leg: the root store records the turn as errored (ground truth), the retry
   path (fix the key → next turn works) is exercisable without restart.

## assertions
- A1 turn returns an ERROR (visible text) ≤ 30 s — no silent hang ≤ 120 s then nothing.
- A2 error names quota/rate/limit class (matches the 429 cause, not a generic 500).
- A3 banner/degrade state visible on the session surface (the provider-wave banner).
- A4 after mock-1310 → mock-key swap (injector off + mock root), next turn succeeds —
  degradation is recoverable, not wedged.

## findings mapping
A1 fail → QUOTA-SILENT (high — the outage story repeats) · A2 fail → QUOTA-GENERIC-ERROR
· A3 fail → QUOTA-NO-BANNER · A4 fail → QUOTA-WEDGE. Verdict law as @2.
Note: this scenario is the regression net for the 10-27 quota outage (retrospective §5
"next quota stop explained on the phone but still a stop").
