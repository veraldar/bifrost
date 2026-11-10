# Metrics ledger — schema

The ledger answers one question: **are we improving?** (v07-reflection-and-plan §9.4).
Six fixed metrics, every wave and every release, always with the **build hash** and the **device class**.
Everything — the six-row block, the month table, the chart — is generated from the JSONL here. Prose is never the source.

## Layout
```
docs/metrics/
  schema.md              this file
  waves/<wave>.jsonl     one JSON object per line; the only source of truth
  index.jsonl            derived (scripts/metrics.py index): wave, date, rows, metrics, builds, sha256 of the file
```
Wave id: `YYYY-MM-DD-<kind>[-<label>]` — e.g. `2026-10-06-sim-c5`, `2026-10-24-v07-gate-final`.

## The six metrics
| metric | value | unit | extra fields | source / adapter |
|---|---|---|---|---|
| `e2e_pass_rate` | passed / (passed + failed) per suite; flaky counts as passed | ratio | `suite` `num` `den` `skipped` `detail.failed[]` | Playwright JSON reporter (`--from playwright`); ygg-sim cycle JSON (`--from sim`, suite `ygg-sim`: pass / (pass + fail), BREAK-OK/KNOWN/SKIP in `detail`) |
| `flake_rate` | tests that passed only on retry / ran | ratio | `suite` `num` `den` `detail.flaky[]` | Playwright `flaky` status. Needs `--retries=1` in the referee run, else it reads 0 forever |
| `voice_rtt` | p50 in ms | ms | `src_kind` (`you`/`e2e`/`sim`) `leg` (`transcript`/`first_audio`/`stt`/`brain`/`handsfree_turn`) `n` `p50` `p95` `dup_turns` | nightly digest of `voice.turn {json}` diag lines (`--from voice`); the sim's `bridge.handsfree-round`. **Never mix sources** |
| `wedge_count` | runs wedged per 100 runs | per100 | `n_runs` | daily count (not yet collected) |
| `gate_green` | green items / items in plan.md's gate | ratio | `suite` `num` `den` | the gate in machine form (backfilled once from the reflection §2.1) |
| `uptime` | % of 5-min probes GREEN | ratio | `slot` `recover_s` | `gate.py --quick` on a timer (not yet collected) |

Anything else is an **extra series**, named `x.<name>` (`x.scenarios`, `x.slo_held`, `x.lane_ok_rate`). Extras are charted
or tabled on request; they never appear in the six-row block.

## A row
```json
{"v":1,"ts":"2026-10-07","wave":"2026-10-07-sim-c7","metric":"e2e_pass_rate","value":1.0,"unit":"ratio",
 "suite":"ygg-sim","num":23,"den":23,"build":"app0.6.0+sim0.5.0","device":"phone-sim",
 "from":"lab/ygg-sim/report/cycles/cycle-7.json","detail":{"ran":30,"break_ok":4,"known":3,"skip":0,"wall_s":425}}
```
Required: `v` `ts` (YYYY-MM-DD) `wave` `metric` `build` `device` `from`. `value` is a number or `null`.
`null` is for "the pass count is recorded, the fail count is not" (lk-verify): `num` is kept, `value` is not invented.
`build` is a release label, a commit, a Next build id, or `app<ver>+sim<ver>`; `n/r` = not recorded in the source.
`device` is a class: `desktop-chromium`, `phone-sim`, `box`, `s22` (the real phone), `pixel7-emu`.
Key within a wave: (`metric`, `suite`, `src_kind`, `leg`) — a re-append replaces the row with that key.

## Missing is a fact, not a zero
A wave with no row for a metric prints `— not collected (<what is missing>)` in the block. No row is ever written for
a number that the source does not state. Backfilled prose numbers carry the report they were read from in `from`.

## Commands
```
scripts/metrics.py append --wave W --ts D --build H --device C --from playwright|sim|agi|voice FILE
scripts/metrics.py append --wave W --ts D --build H --device C --metric gate_green --num 6 --den 8 --suite "plan.md gate"
scripts/metrics.py backfill                      # the §9.4 history, idempotent (rewrites the waves it owns)
scripts/metrics.py report --wave W               # the six-row block (paste at the top of the wave report)
scripts/metrics.py report --wave W --check docs/reviews/<report>.md   # does the report open with it? exit 1 if not
scripts/metrics.py report --all                  # table, every wave
scripts/metrics.py month 2026-10                 # table + artifacts/metrics-2026-10.svg
scripts/test-metrics.sh                          # the spec: adapters, regenerate-from-JSONL, check
```

## The wave-report rule
Every wave report opens (right under its title) with the output of `metrics.py report --wave <wave>`, between its
`<!-- metrics:begin -->` / `<!-- metrics:end -->` markers. The report's own prose may not restate those numbers differently.
The nightly voice digest: `metrics.py append --wave <date>-voice --ts <date> --build <live label> --device s22 --from voice pwa/.diag/diag-<date>.log`
(a no-op, loudly, until S1 writes `voice.turn` lines).
