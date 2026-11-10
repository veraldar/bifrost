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
/\[net([·][^]]*)?\] / {
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
/\[net-fail([·][^]]*)?\] / { fails++; next }
/\[ptt-fail/ { ptt_fail++; next }
/\[ptt([·][^]]*)?\] / {
  if (/mic requested/) ptt_req++
  else if (/mic enabled/) ptt_on++
  else if (/commit ok/) ptt_commit++
  else if (/discard ok/) ptt_discard++
  else if (/slide-cancel/) ptt_cancel++
  ptt_other++
  next
}
/\[send-fail/ { send_fail++; next }
/\[send([·][^]]*)?\] / {
  if (/posted direct/) send_post++
  else if (/posted queued/) send_queued++
  else if (/landed/) send_land++
  next
}
/\[free-fail/ { free_fail++; next }
/\[free([·][^]]*)?\] / { if (/commit ok/) free_commit++; next }
/\[voice([·][^]]*)?\] / {
  if (match($0, /room disconnected \(reason=[^)]+\)/)) {
    r = substr($0, RSTART + 26, RLENGTH - 27); disc[r]++
  } else if (/self-heal reconnect scheduled/) rec_att++
  else if (/self-heal reconnect OK/) rec_ok++
  else if (/reconnect attempt .* failed/) rec_fail++
  else if (/voice agent left/) agent_left++
  next
}
/\[busy([·][^]]*)?\] / {
  if (match($0, /(abort|clear|wedge) [^ ]+ after [0-9.]+s/)) {
    split(substr($0, RSTART, RLENGTH), f, " ")
    ev = f[1]; sec = f[4] + 0; runs[ev]++
    if (ev == "clear") { csum += sec; if (sec > cmax) cmax = sec }
    if (ev == "abort") { asum += sec }
    if (ev == "wedge") wedges++
  } else if (match($0, /^.*\[busy([·][^]]*)?\] [a-z]+/)) {
    ev = substr($0, RSTART, RLENGTH); sub(/^.*\[busy([·][^]]*)?\] /, "", ev)
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
  # interaction outcomes (req 10-02): expected effect vs what happened —
  # a gap between the two columns of a pair is lost user input
  if (ptt_req || ptt_fail) {
    print ""
    print "== interaction outcomes"
    if (ptt_req) printf "ptt holds:        %d requested, %d mic-on, %d commits ok, %d discarded, %d slide-cancels\n", ptt_req, ptt_on, ptt_commit, ptt_discard, ptt_cancel
    if (ptt_fail) printf "ptt NO-EFFECT:    %d (mic enable/discard/commit failed — spoken words lost)\n", ptt_fail
    # queued sends add no echo (the proxy owns pickup) — landed pairs with direct only
    if (send_post || send_queued || send_fail) printf "sends:            %d posted direct, %d landed, %d queued (proxy pickup), %d FAILED\n", send_post, send_land, send_queued, send_fail
    if (free_commit || free_fail) printf "tap-to-send:      %d ok, %d FAILED\n", free_commit, free_fail
    n = asorti(disc, dkeys)
    for (i = 1; i <= n; i++) printf "disconnects:      %d x %s\n", disc[dkeys[i]], dkeys[i]
    if (rec_att) printf "reconnects:       %d attempts, %d ok, %d failed\n", rec_att, rec_ok, rec_fail
    if (agent_left) printf "voice agent left the room: %d\n", agent_left
  }
}' "$LOG"
