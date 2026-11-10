# SCENARIO proxy-session-tour@1

persona: engineer.md (route legs) + battery.md (the traveling user's turns)
world: sim stack up + scratch roots; :4096 and :4100 READ-ONLY (single-home law;
this scenario only creates scratch sessions and lists — it never writes to a live store)
cost tier: CHEAP

## steps
1. Engineer leg inventories the declared routes (loopback seams + the registered
   trunk route, read-only `GET /api/session` on each — list only).
2. Same battery task ("status, in five words") sent to three brains: mock scratch root
   (:4131), quota root (:4130, expects the 429 error turn), and — read-only posture —
   a direct comparison against the live roots' LIST shape (no writes).
3. Route-switch exercise: create two sessions on the mock scratch root, verify the app's
   session list shows both (the "several routes, many users" posture) and that each
   session's turns stay on its own brain (single-home for sessions, mirrored in sim).
4. The relay (ygg-relay) leg: PENDING — not built. The scenario asserts the PENDING
   state visibly (a skip-with-reason in the trace, not a silent pass), and will gain
   its kill-the-remote legs the day the relay passes its own 8-flow build gate.

## assertions
- A1 every declared route answers a list; the trunk route's shape matches its dialect
  (bifrost-proxy aggregation shape per Appendix B) — shape drift = finding ROUTE-DRIFT.
- A2 error-vs-good dialect: quota root returns the 429 class, mock root returns text —
  the two roots are distinguishable by their turns, not just their ports.
- A3 sessions are single-homed in sim: one session ↔ one brain for its whole life.
- A4 relay legs SKIPPED-WITH-REASON (trace row `pending: ygg-relay not built`).

## findings mapping
A1 fail → ROUTE-DRIFT · A2 fail → DIALECT-COLLAPSE · A3 fail → SESSION-DUALHOME
(high) · A4 is never a failure — an unbuilt relay is a state, not a finding; hiding
the skip WOULD be one (SIM-OPAQUE-SKIP).
