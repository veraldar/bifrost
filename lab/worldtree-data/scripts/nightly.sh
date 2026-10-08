#!/usr/bin/env bash
# Nightly worldtree cycle: fetch fresh source data -> recompute -> commit run -> publish to veraldar.org.
# One fetch a night (run --no-fetch): run used to fetch again, doubling the keyless GitHub spend past its budget and,
# during the 10-08 backfill, past the unit's 1800 s timeout.
set -e
cd "$(dirname "$0")/.."
exec >> nightly.log 2>&1
export PYTHONUNBUFFERED=1  # a killed cycle still leaves its log lines (10-08: the timeout ate them)
echo "=== nightly $(date -u +%FT%TZ)"
flock -n /tmp/worldtree-nightly.lock -c '
  python3 -m wt fetch
  python3 -m wt run --as-of "$(date -u +%F)" --commit --no-fetch
  bash scripts/publish.sh
' || echo "nightly skipped: another cycle holds the lock"
