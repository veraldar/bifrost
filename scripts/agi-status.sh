#!/usr/bin/env bash
# agi-status.sh — fleet view of delegations from the agi-run.sh evidence log.
# Read-only. Companion to scripts/agi-run.sh (fleet rule 10-04).
set -u
LOG_DIR="${AGI_LOG_DIR:-$HOME/Work/bifrost/.agi-log}"
LOG="$LOG_DIR/log.tsv"
TODAY="$(date +%F)"

if [ ! -f "$LOG" ]; then
  echo "AGI delegation status — no evidence log at $LOG (no runs have gone through agi-run.sh)"
  exit 0
fi

# latest line per runid (log is append-only; a run may have RUNNING + final lines)
latest=$(tac "$LOG" | awk -F'\t' '!seen[$1]++')

echo "AGI delegation status — $TODAY ($LOG)"
echo

# --- runs today ---
ok=0; fail=0; stalled=0; recovered=0
while IFS=$'\t' read -r runid date sess model start end dur exitc status out note; do
  [ "$date" = "$TODAY" ] || continue
  case "$status" in
    OK) [ -n "$note" ] && [ "$note" != "-" ] && recovered=$((recovered+1)) || ok=$((ok+1)) ;;
    FAIL) fail=$((fail+1)) ;;
    STALLED) stalled=$((stalled+1)) ;;
  esac
done <<< "$latest"
total=$((ok + fail + stalled + recovered))
echo "RUNS TODAY: $total (ok $ok$([ "$recovered" -gt 0 ] && echo "+$recovered recovered"), fail $fail, stalled $stalled)"
echo

# --- running now ---
now=$(date +%s)
running=0
while IFS=$'\t' read -r runid date sess model start end dur exitc status out note; do
  [ "$status" = "RUNNING" ] || continue
  running=$((running+1))
  s_epoch=$(date -d "$start" +%s 2>/dev/null || echo "$now")
  el=$(( now - s_epoch ))
  flag=""; [ "$el" -ge 3600 ] && flag=" (STALE? >1h — wrapper died?)"
  printf 'RUNNING: %s session=%s model=%s started=%s elapsed=%02d:%02d:%02d%s\n' \
    "$runid" "$sess" "$model" "$start" $((el/3600)) $((el%3600/60)) $((el%60)) "$flag"
done <<< "$latest"
[ "$running" -eq 0 ] && echo "RUNNING NOW: none"
echo

# --- last failure ---
lastfail=$(printf '%s\n' "$latest" | awk -F'\t' '$9=="FAIL" || $9=="STALLED"' | tail -1)
if [ -n "$lastfail" ]; then
  IFS=$'\t' read -r runid date sess model start end dur exitc status out note <<< "$lastfail"
  echo "LAST FAILURE: $runid session=$sess status=$status exit=$exitc dur=${dur}s at=$start note=$note"
  echo "  evidence: $LOG_DIR/outputs/$runid.err"
else
  echo "LAST FAILURE: none"
fi
