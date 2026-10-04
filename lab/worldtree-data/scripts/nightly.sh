#!/usr/bin/env bash
# Nightly worldtree cycle: fetch fresh source data -> recompute -> commit run -> publish to veraldar.org.
set -e
cd "$(dirname "$0")/.."
exec >> nightly.log 2>&1
echo "=== nightly $(date -u +%FT%TZ)"
flock -n /tmp/worldtree-nightly.lock -c '
  python3 -m wt fetch
  python3 -m wt run --as-of "$(date -u +%F)" --commit
  bash scripts/publish.sh
' || echo "nightly skipped: another cycle holds the lock"
