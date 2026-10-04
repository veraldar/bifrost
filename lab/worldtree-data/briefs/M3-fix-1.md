# M3-fix-1 — arxiv backfill fix + resume (read after M3-build.md)

Context: the first M3 run was stopped during step 3. Steps 1–2 are committed
(5cf8f13, 2f428ac). Your own uncommitted step-3 WIP (wt/common.py month_of_url,
wt/fetch.py, wt/extract.py, wt/run.py, tests/test_extract.py) is intact in the
worktree — keep it, finish it.

## What the arxiv evidence says (measured, not guessed)
raw/arxiv/cs.AI/fetch-log.csv: 108 attempts, **0 stored** — 32× HTTP 429,
76× HTTP 500, all on `http://export.arxiv.org` with `max_results=0`.
Your own step-1 note (5cf8f13) already identified: **the arXiv API now returns
a 500 error feed for `max_results=0` queries**. Separately, `http://` now
301-redirects, and burst requests additionally trip 429 rate limiting.

## Locked fixes (amend locked decision 3 of M3-build.md)
1. arxiv URLs: `https://export.arxiv.org/...` and `max_results=1` (count still
   read from `<opensearch:totalResults>`; the 1 result is discarded — or
   `max_results=1` with `perPage` unaffected: totalResults is the count).
2. Pacing: ≥ 6 s sleep between arxiv requests. On 429/500/502/503 the existing
   retry backoff (5/15/45) applies, then the month is marked skipped — a pass
   never aborts on individual failures.
3. Repair sweeps: after the first pass, up to 3 further sweeps over skipped
   months (6 s pacing), then stop.
4. Acceptance: ≥ 90 % of months 2019-01 → last complete month stored
   (≥ 84 of ~93). Below that → BLOCKER-M3.md (exact per-status counts) and
   STOP the arxiv part; pubmed/fedreg/noaa continue to step 4 regardless.
5. tests/proofs_m3.sh arxiv line: switch to https + max_results=1 if not
   already (it is, per 5cf8f13 — verify it passes again).

## Resume procedure
1. `git status --porcelain` — your WIP is there; other sessions' files
   (`docs/lab-playbook.md`, `scripts/agi-*.sh`, `docs/roadmap-proposal-v2.md`)
   are OFF-LIMITS. Do not stage them; do not revert them; do not rewrite
   history (commit 6405ead swept unrelated WIP — known damage, remedy is your
   pathspec fix, already committed in 5cf8f13).
2. Redo step 3 with the fixes above (fetch only the 4 new sources). The
   already-stored pubmed/fedreg/noaa snapshots dedupe — no refetch of
   unchanged months.
3. Continue with steps 4–9 of M3-build.md unchanged.
