#!/usr/bin/env bash
# fold-tighten-r1 SETTLE watch. Waits for the watcher's SWAP-DONE row for $NAME (never restarts
# anything itself), then reads every /tmp/lat-p95.tsv rewrite after the swap. A window is CLEAN when
# the tsv's p95 < LIMIT with n >= 1 AND the post-swap-only p95 (lat-p95.sh over journal rows since
# the swap, private out/state, no status writes) is < LIMIT with n >= 1; a breach resets the count;
# n = 0 windows are skipped. Two consecutive clean windows = SETTLED. Cap 12 h = NOT-SETTLED.
# Verdict: one auto-verdict POST to MAIN via send-lane.sh (meta auto + internal, silent law) and the
# artifact's verdict line rewritten. No sub-status row (the POST is the wake).
set -u
NAME=${NAME:-yggdrasil-fold-tighten-r1-618eeba3}
MAIN=${MAIN:-ses_770b899884cf47718e054f6f2702630c}
REPO=${REPO:-$HOME/Work/bifrost}
ART=${ART:-$REPO/artifacts/fold-tighten-r1.md}
TSV=${TSV:-/tmp/lat-p95.tsv}
STATUS=${STATUS:-/tmp/sub-status.tsv}
LIMIT=${LIMIT:-5000}
POLL=${POLL:-30}
NEXT=" · Next-actions: 1) split ttfb prefill vs thinking on MAIN LAT rows 2) next lever: window 2->1 or digest cap 160->80ch"
D=$(mktemp -d /tmp/fold-tighten-settle.XXXX); LOG=$D/settle.log
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
verdict() { # $1 = verdict line
  python3 - "$ART" "$1" <<'PY'
import sys
p, v = sys.argv[1:3]
try: L = open(p).read().splitlines()
except OSError: L = []
L = [v] + L[1:] if L else [v]
open(p, "w").write("\n".join(L[:8]) + "\n")
PY
  python3 -c 'import json,sys;print(json.dumps({"parts":[{"type":"text","text":"AUTO-VERDICT fold-tighten-r1 settle: "+sys.argv[1]}],"meta":{"auto":True,"internal":True},"internal":True}))' "$1" >$D/payload.json
  "$REPO/scripts/send-lane.sh" -s "$MAIN" -t fold-tighten-r1-settle -f $D/payload.json -w 12 >>"$LOG" 2>&1
  log "verdict posted rc=$?: $1"
}
log "waiting for SWAP-DONE $NAME"
for _ in $(seq 1440); do   # up to 12 h, 30 s polls
  grep -qE "SWAP-DONE $NAME" "$STATUS" 2>/dev/null && break
  grep -qE "SWAP-ESCALATE $NAME" "$STATUS" 2>/dev/null && { verdict "# fold-tighten-r1 — VERDICT: PARTIAL NOT-SETTLED $(date -Iseconds) — swap escalated, $NAME never went live$NEXT"; exit 1; }
  sleep "$POLL"
done
ROW=$(grep -E "SWAP-DONE $NAME" "$STATUS" 2>/dev/null | tail -1)
[ -n "$ROW" ] || { verdict "# fold-tighten-r1 — VERDICT: PARTIAL NOT-SETTLED $(date -Iseconds) — no SWAP-DONE in 12 h (MAIN never idle with no lane)$NEXT"; exit 1; }
T=$(date -d "$(cut -f1 <<<"$ROW")" +%s); log "swap at @$T: $ROW"
seen=$(stat -c %Y "$TSV" 2>/dev/null || echo 0); [ "$seen" -lt "$T" ] && seen=$T
clean=0; wins=0; hist=""
for _ in $(seq 1440); do
  sleep "$POLL"
  m=$(stat -c %Y "$TSV" 2>/dev/null || echo 0); [ "$m" -gt "$seen" ] || continue
  seen=$m
  read -r p n < <(tail -n1 "$TSV" | awk -F'\t' '{print $2, $3}')
  read -r pp pn < <(SES_ID=$MAIN SINCE="@$T" OUT_TSV=$D/post.tsv STATE_FILE=$D/post.state STATUS_FILE=/dev/null \
    "$REPO/scripts/lat-p95.sh" | tail -n1 | awk -F'\t' '{print $2, $3}')
  log "window: hour p95=${p}ms n=$n · post-swap p95=${pp}ms n=$pn"
  [ "${n:-0}" -ge 1 ] && [ "${pn:-0}" -ge 1 ] || continue
  wins=$((wins + 1)); hist="$hist ${p}/${pp}"
  if [ "$p" -lt "$LIMIT" ] && [ "$pp" -lt "$LIMIT" ]; then clean=$((clean + 1)); else clean=0; fi
  if [ "$clean" -ge 2 ]; then
    verdict "# fold-tighten-r1 — VERDICT: GREEN SETTLED $(date -Iseconds) — 2 clean lat-p95 windows <${LIMIT}ms on $NAME (hour/post-swap p95 ms:$hist)"
    exit 0
  fi
done
verdict "# fold-tighten-r1 — VERDICT: PARTIAL NOT-SETTLED $(date -Iseconds) — 12 h after swap, no 2 consecutive clean windows (${wins} windows, hour/post-swap p95 ms:${hist:- none})$NEXT"
exit 1
