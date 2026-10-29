#!/usr/bin/env bash
# Nightly worldtree cycle: fetch fresh source data -> recompute -> commit run -> country panel -> publish to veraldar.org.
# One fetch a night (run --no-fetch): run used to fetch again, doubling the keyless GitHub spend past its budget and,
# during the 10-08 backfill, past the unit's 1800 s timeout.
set -e
cd "$(dirname "$0")/.."
exec >> nightly.log 2>&1
export PYTHONUNBUFFERED=1  # a killed cycle still leaves its log lines (10-08: the timeout ate them)
echo "=== nightly $(date -u +%FT%TZ)"
flock -n /tmp/worldtree-nightly.lock -c '
  VERALDAR_GH_CACHE="$PWD/state/gh-cache.json" python3 scripts/github_trend.py  # github.json for the AI EVOLUTION tab (VPS ip is gh-rate-limited; this box is not)
  python3 -m wt fetch
  python3 -m wt run --as-of "$(date -u +%F)" --commit --no-fetch
  python3 -m wt countries --as-of "$(date -u +%F)" --no-commit  # 0.6.0: the atlas is refreshed nightly too (it was only rebuilt by gate runs)
  bash scripts/publish.sh
  python3 -m wt ledger  # S17: the one run-health line (no trunk commit marks a run any more)
' || echo "nightly skipped: another cycle holds the lock"
