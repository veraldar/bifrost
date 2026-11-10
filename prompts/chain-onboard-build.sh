#!/usr/bin/env bash
# chain: wait for ONBOARD-GAPS to finish, then launch ONBOARD-BUILD detached.
set -u
LOG="$HOME/Work/bifrost/.agi-log/log.tsv"
DOC="$HOME/Work/bifrost/docs/reviews/onboarding-gap-analysis.md"
for i in $(seq 1 90); do  # up to 45 min
  row="$(grep -P '\tONBOARD-GAPS\t' "$LOG" | tail -1)"
  st="$(printf '%s' "$row" | cut -f9)"
  [ "$st" != "RUNNING" ] && break
  [ -f "$DOC" ] && [ "$st" != "RUNNING" ] && break
  sleep 30
done
cd "$HOME/Work/bifrost"
exec scripts/agi-run.sh -s ONBOARD-BUILD -m opus -f prompts/onboard-build.txt
