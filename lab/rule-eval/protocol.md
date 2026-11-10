# rule-eval — the improvement-validation loop (protocol v1)

> The owner's law (10-28): **NO rule becomes binding before a simulation measures its
> gain/loss and the trend validates the improvement.**

This lab is the machine that enforces that law. A change — a rule, a policy, a harness
version, a prompt — is a **candidate**. It starts life as a hypothesis with a number
attached. It becomes binding only when the numbers say so, in the ledger, across time.

## 1. The protocol (state machine)

```
                 names metric(s) + baseline + target + guard
   (proposed) ───────────────────────────────────────────────▶ MEASURING
   MEASURING ── trend: target met at ≥3 measurement points,   ──▶ PROMOTED
                guard metric NOT regressed  (ledger evidence)
   MEASURING ── window expired (N days/runs) without that      ──▶ AUTO-SUNSET
   PROMOTED  ── later scorecard shows target missed or guard   ──▶ back to MEASURING
                regressed (re-measure before re-promotion)
```

A candidate may be **PROMOTED to binding** iff ALL of:

- **(a) named metric(s)** — written in the register at proposal time, with how each is
  measured (the probe) and which direction is "better".
- **(b) baseline measured BEFORE adoption** — the probe ran on the pre-change world and
  the number is in the ledger, with timestamp. No baseline = cannot enter MEASURING.
- **(c) after N days/Runs**, the ledger shows the **target met** and the rest of the
  scorecard **not regressed** (the **guard**: a second metric that would catch the
  candidate "winning" by breaking something else).
- **(d) trend visible in ≥3 measurement points** — three ledger rows at different times,
  not one lucky probe. A trend, not an anecdote.

Otherwise: **AUTO-SUNSET** — the candidate returns to DRAFT in the docs, its register row
gets `state: sunset` with the reason, and the sunset event is appended to the ledger.
A sunset is data, not punishment: it names what was learned and what the next candidate
should change.

### Roles of files
| file | role |
|---|---|
| `candidates.yaml` | the **register**: every candidate with rule, metrics, baseline, target, guard, points[] |
| `~/.local/share/bifrost/bench/rule-eval.jsonl` | the **ledger**: append-only measurement rows (same discipline as harness-bench) |
| `scorecards/rule-eval-<date>.md` | dated, human-readable snapshot of the register + verdicts |
| `metrics.py` | the **probe harness** (read-only against the live stores) |
| `eval.py` | the **state machine**: updates states, writes scorecards, appends events |

### Ledger row schema (one JSON object per line)
```json
{"ts": "...", "kind": "measurement", "candidate": "naming-law", "metric": "discovery_cost_s",
 "store": 4100, "value": 0.42, "unit": "s", "ok": true, "notes": "..."}
{"ts": "...", "kind": "event",      "candidate": "naming-law", "event": "promoted|sunset|measuring",
 "reason": "..."}
```
Same rules as harness-bench: append only, never rewrite; scorecards are dated files;
any tool may read the ledger, only `eval.py` writes events.

## 2. Metric library (measurable proxies for the messes we actually had)

| metric | target rule | probe (read-only) | better |
|---|---|---|---|
| **discovery_cost_s** | session-discovery: seconds for MAIN to find a lab's home/artifact | timed store query `GET /session` + title match + message read on a known lab (p50 of 5 runs). Harness `metrics.py discover-cost` | lower |
| **noise_ratio** | share of [LAB] sessions that are not standing labs / total [LAB]-titled | count from `GET /session`: `[LAB]*` titles not matching the standing registry in `docs/LABS.md` ÷ all `[LAB]*`. `metrics.py noise-ratio` | lower |
| **main_bloat_b** | bytes MAIN absorbed per coordination task | parse `lab/nous-sim/run-*/results.tsv`: prompt+answer bytes ÷ tasks. `metrics.py main-bloat` | lower |
| **drift_known_gaps** | drift-guard KNOWN-GAP count | run `scripts/drift-guard.sh` (read-only, ~0.2 s), count KNOWN-GAP rows. `metrics.py drift` | lower |
| **regression_escapes** | user-reported bugs the sim missed | count of journal/incident rows tagged escape since last scorecard. Currently MANUAL — no tagged feed exists yet; recorded as `null` until a reporter lands | lower |

Definitions fixed 10-28. A metric definition change is itself a candidate and enters the
machine (new baseline required).

## 3. First case — the `[LAB]/[RUN]` naming law

The candidate that spawned this protocol: after the 10-28 session-list mess (77 `[LAB]`
sessions, ~70 battery noise), the owner decreed `[LAB]` = long-running program,
`[RUN]` = one-shot measurement.

- **metric**: `noise_ratio` (primary); guard: `discovery_cost_s`; 
- **baseline (measured, pre-adoption — cited)**: `docs/LABS.md` 10-28: "77 [LAB]
  sessions, ~70 noise". Surviving store evidence: `:4096` still holds the pre-cleanup
  world — 11 duplicate `[LAB] harness-bench` titles + 57 total `[LAB]` titles, 0 `[RUN]`.
- **post**: `:4100` (yggdrasil root, MAIN's store) post-cleanup: 3 `[LAB]` standing labs
  (excluding this probe's own `[LAB] rule-eval` session) + 74 `[RUN]`.
- **window**: 7 days / ≥3 points. See `scorecards/` for the gain/loss verdict.

## 4. How any future change enters the machine

1. Add a row to `candidates.yaml` with `state: proposed` — one line of rule text, the
   metric(s), how measured, target, guard, N (window), and the baseline citation
   (file + number, or "measure now" → run the probe FIRST, then fill baseline).
2. `python3 metrics.py all` → appends measurement rows to the ledger.
3. `python3 eval.py` → moves states per the machine, writes a dated scorecard, prints
   verdicts. Repeat (3) at least 3 times across the window.
4. Promotion is a *consequence*, not a decision: when the ledger shows target+guard+trend,
   `eval.py` flips the state and the rule may be written as binding in the docs, citing
   the ledger rows. If the window closes without that, AUTO-SUNSET fires.
