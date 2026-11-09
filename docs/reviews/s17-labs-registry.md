# S17 LABS-REGISTRY — report (10-27)

Source: v07-reflection-and-plan §7.2 S17, §10.4–10.5. Nothing live was touched (no restart, no publish, no build).

## Done-checks
| check | result |
|---|---|
| `where.sh labs` answers "which labs run, where, since when" in one call | **PASS**: 0.14 s; probes (worldtree timer + next run + last ledger line, lk-verify, ygg-sim container + "driver: none", voice-lab, bridge/yggdrasil, dormant labs' last commits) + the 16-row registry (state / wake / owner). In `all` too. `scripts/test-where.sh` extended (4 checks + `labs` subcommand): GREEN |
| a nightly run leaves no trunk commit, writes one ledger line | **PASS in a scratch repo; first live proof is tonight's 14:30 CET run.** `commit_run` on a run that changed no tracked file → no commit (returned `None`); with a tracked change → one commit, as before. `python3 -m wt ledger` appended one line. Not run through the live `publish.sh` (that publishes to veraldar.org) |

## What changed
- `docs/labs.md` (new): the §10.4 rows, each with state, wake trigger, owner. `where.sh labs` parses it between `<!-- labs -->` markers.
- `scripts/where.sh labs` (S5's where.sh lacked it; added), `scripts/test-where.sh`.
- `lab/worldtree-data/wt/gitops.py`: `commit_run` skips the empty commit (was `--allow-empty`: 17+ empty "run …: published" commits since 10-10, robots wrote 21 of the trunk's last 40).
- `lab/worldtree-data/wt/ledger.py` + `python3 -m wt ledger` + a last step in `scripts/nightly.sh`: one line per night in `lab/worldtree-data/ledger.jsonl` (gitignored; inside the lab dir, so `backup.sh` covers it). The marker went to the **run ledger**, not a `robots/worldtree` ref: no second place to look, no git plumbing in a cron.
- `docs/claims.md`: the ygg-sim "SELF-IMPROVING LOOP running" line is now `[x]` closed, original text kept as HISTORY.

## The run-health line (S14 schema)
S14 has not landed (`scripts/metrics.py`, `docs/metrics/` do not exist), so I could not read its schema. I shaped the line as flat JSONL a metrics adapter can read as-is: `ts, lab=worldtree, metric=worldtree.run_health, value (1 ok / 0 not), run_id, published, first_gate_failure, sources_fresh, published_sha_ok, fresh_run, method_version, trunk_commit=false`.
`value=0` when: held by a gate, a stale/snapshot_age gate failed, the live `https://veraldar.org/realms.json` sha ≠ `out/realms.json`, or the manifest isn't today's (a dead night no longer looks healthy).
**Open for S14:** point its worldtree adapter at `lab/worldtree-data/ledger.jsonl` and rename keys if its schema differs. Writing into `docs/metrics/` from the nightly would have recreated the trunk-commit problem.

## Left alone / to know
- `docs/claims.md` is not committed by me: it carries another session's uncommitted edit. The ygg-sim line edit sits in the working tree.
- Past empty commits stay in history; none rewritten.
- The old law "one commit per run" is gone; the manifest (`repo_commit`) and ledger are the per-run record. No doc in the lab states the old rule.
- Registry facts are the 10-27 snapshot of §10.4; `where.sh labs` shows live state beside them.
- First real ledger line appears after tonight's nightly (the `labs` worldtree row says "no ledger line yet" until then). Check with `scripts/where.sh labs`.
