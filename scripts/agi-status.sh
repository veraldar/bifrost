#!/usr/bin/env bash
# agi-status.sh — fleet view of delegations from the agi-run.sh evidence log.
# Companion to scripts/agi-run.sh (fleet rule 10-04).
#
# No zombie states (S4): a run whose latest row is RUNNING but whose wrapper pid is gone
# is reaped — a DEAD row is appended to the log (durable, so chains waiting on the log
# stop too). The pid is read from the RUNNING row's note (`pid=N unit=U`); rows from
# before S4 carry no pid, but the runid ends in the wrapper's pid, so they resolve too.
# A pid counts as alive only if /proc/<pid>/cmdline still names agi-run (pid reuse).
# Any call reaps, so a DEAD lane reads DEAD the moment anyone looks (≤ 60 s budget is the
# caller's polling interval: chains poll every ≤ 30 s). `--reap` = reap quietly and exit.
# AGI_STATUS_RO=1 = never write.
set -u
LOG_DIR="${AGI_LOG_DIR:-$HOME/Work/bifrost/.agi-log}"
LOG="$LOG_DIR/log.tsv"
TODAY="$(date +%F)"

if [ ! -f "$LOG" ]; then
  echo "AGI delegation status — no evidence log at $LOG (no runs have gone through agi-run.sh)"
  exit 0
fi

LOCK="$LOG_DIR/.lock"
wrapper_alive() { # runid note
  local pid
  pid="$(printf '%s' "$2" | grep -oP '(^|\s)pid=\K[0-9]+')"
  [ -n "$pid" ] || pid="${1##*-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0   # unparseable → don't claim dead
  [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'agi-run' && return 0
  return 1
}
reap() {
  [ "${AGI_STATUS_RO:-0}" = "1" ] && return 0
  local runid date sess model start end dur exitc status out note nowiso
  while IFS=$'\t' read -r runid date sess model start end dur exitc status out note; do
    [ "$status" = "RUNNING" ] || continue
    wrapper_alive "$runid" "$note" && continue
    nowiso="$(date '+%F %H:%M:%S%z')"
    s_epoch=$(date -d "$start" +%s 2>/dev/null || date +%s)
    (
      flock 9
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$runid" "$date" "$sess" "$model" "$start" \
        "$nowiso" "$(( $(date +%s) - s_epoch ))" "-" "DEAD" "$out" "wrapper gone while RUNNING (${note:--}); reaped by agi-status" >>"$LOG"
    ) 9>"$LOCK"
  done < <(tac "$LOG" | awk -F'\t' '!seen[$1]++')
}
reap
[ "${1:-}" = "--reap" ] && exit 0

# latest line per runid (log is append-only; a run may have RUNNING + final lines)
latest=$(tac "$LOG" | awk -F'\t' '!seen[$1]++')

echo "AGI delegation status — $TODAY ($LOG)"
echo

# --- runs today ---
ok=0; fail=0; stalled=0; recovered=0; dead=0
while IFS=$'\t' read -r runid date sess model start end dur exitc status out note; do
  [ "$date" = "$TODAY" ] || continue
  case "$status" in
    OK) [ -n "$note" ] && [ "$note" != "-" ] && recovered=$((recovered+1)) || ok=$((ok+1)) ;;
    FAIL) fail=$((fail+1)) ;;
    STALLED) stalled=$((stalled+1)) ;;
    DEAD) dead=$((dead+1)) ;;
  esac
done <<< "$latest"
total=$((ok + fail + stalled + recovered + dead))
echo "RUNS TODAY: $total (ok $ok$([ "$recovered" -gt 0 ] && echo "+$recovered recovered"), fail $fail, stalled $stalled, dead $dead)"
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
lastfail=$(printf '%s\n' "$latest" | awk -F'\t' '$9=="FAIL" || $9=="STALLED" || $9=="DEAD"' | tail -1)
if [ -n "$lastfail" ]; then
  IFS=$'\t' read -r runid date sess model start end dur exitc status out note <<< "$lastfail"
  echo "LAST FAILURE: $runid session=$sess status=$status exit=$exitc dur=${dur}s at=$start note=$note"
  echo "  evidence: $LOG_DIR/outputs/$runid.err"
else
  echo "LAST FAILURE: none"
fi
