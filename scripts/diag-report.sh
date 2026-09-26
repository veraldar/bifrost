#!/usr/bin/env bash
# Latency + quality report from the PWA request diag log.
# Usage: scripts/diag-report.sh [pwa/.diag/diag-YYYY-MM-DD.log]   (default: today)
set -euo pipefail
LOG="${1:-pwa/.diag/diag-$(date +%F).log}"
[ -f "$LOG" ] || { echo "no diag log: $LOG" >&2; exit 1; }

awk -v diaglog="$LOG" '
function pctl(key, p,   n, arr, i, j, tmp) {
  n = split(lat[key], arr, " ")
  for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (arr[j] + 0 < arr[i] + 0) { tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp }
  return arr[int((p / 100) * n + 0.999999)] + 0
}
/\[net\] / {
  st = ""
  for (i = 3; i <= NF; i++) if ($i ~ /^[0-9][0-9][0-9]$/) { st = $i; dp = i + 1; break }
  if (st == "" || dp > NF || $(dp) !~ /ms$/) next
  dur = $(dp); sub(/ms$/, "", dur)
  method = $(dp + 1)
  path = (dp + 1 < NF) ? $(dp + 2) : "-"
  sub(/\?.*/, "", path)
  gsub(/\/session\/[^/]+/, "/session/*", path)
  key = method " " path
  cnt[key]++; lat[key] = lat[key] " " dur
  if (dur + 0 > max[key] + 0) max[key] = dur + 0
  total++
  if (st + 0 >= 500) errs5xx++
  next
}
/\[net-fail\] / { fails++; next }
/\[busy\] / {
  if (match($0, /(abort|clear|wedge) [^ ]+ after [0-9.]+s/)) {
    split(substr($0, RSTART, RLENGTH), f, " ")
    ev = f[1]; sec = f[4] + 0; runs[ev]++
    if (ev == "clear") { csum += sec; if (sec > cmax) cmax = sec }
    if (ev == "abort") { asum += sec }
    if (ev == "wedge") wedges++
  } else if (match($0, /^.*\[busy\] [a-z]+/)) {
    ev = substr($0, RSTART, RLENGTH); sub(/^.*\[busy\] /, "", ev)
    runs[ev]++
  }
  next
}
END {
  print "== diag report: " diaglog
  printf "%-42s %7s %8s %8s %9s\n", "endpoint", "count", "p50ms", "p95ms", "max"
  n = asorti(cnt, keys)
  for (i = 1; i <= n; i++) { key = keys[i]
    printf "%-42s %7d %8.0f %8.0f %9d\n", key, cnt[key], pctl(key, 50), pctl(key, 95), max[key]
  }
  print ""
  printf "requests: %d   5xx: %d   net-fail: %d\n", total, errs5xx + 0, fails + 0
  if (runs["clear"]) printf "completed runs: %d (avg %.1fs, max %.1fs)\n", runs["clear"], csum / runs["clear"], cmax
  if (runs["abort"]) printf "aborted runs:   %d (elapsed-before-abort avg %.1fs)\n", runs["abort"], asum / runs["abort"]
  if (wedges) printf "WEDGES (stuck busy indicator): %d\n", wedges
  m = asorti(runs, rkeys)
  for (i = 1; i <= m; i++) if (rkeys[i] != "clear" && rkeys[i] != "abort") printf "busy %s: %d\n", rkeys[i], runs[rkeys[i]]
}' "$LOG"
