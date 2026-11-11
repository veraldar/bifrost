#!/usr/bin/env bash
# lat-p95 — coordinator ≤5s law watch (artifacts/coordinator-5s-law-plan.md item 8).
# Last hour of the brain's `LAT phase=ok steps=1 session=<MAIN>` rows → p95 of
# total_ms+queue_ms (nearest-rank) → /tmp/lat-p95.tsv (rewritten EVERY run).
# ONLY on the ok→breach transition (p95 > LIMIT_MS) appends one
#   lat-p95 ALERT <iso> — p95=Nms n=K >5000
# to /tmp/sub-status.tsv (that file wakes MAIN, so per-run alerts would add load).
# Run from scripts/lat-p95.timer (10 min user timer).
#
# Env: BRAIN_URL (default :4100) · SES_ID (default newest session titled "[MAIN]",
# resolved like watch-landings resolve_main) · UNIT (lk-yggdrasil) · SINCE (-1h) ·
# LOG_FILE (read rows from a file instead of journalctl — scratch/e2e) · OUT_TSV ·
# STATUS_FILE · STATE_FILE · LIMIT_MS (5000).
set -u
BRAIN_URL="${BRAIN_URL:-http://127.0.0.1:4100}"
UNIT="${UNIT:-lk-yggdrasil}"
SINCE="${SINCE:--1h}"
OUT_TSV="${OUT_TSV:-/tmp/lat-p95.tsv}"
STATUS_FILE="${STATUS_FILE:-/tmp/sub-status.tsv}"
STATE_FILE="${STATE_FILE:-/tmp/lat-p95.state}"
LIMIT_MS="${LIMIT_MS:-5000}"

resolve_main() {
  curl -s --max-time 5 "$BRAIN_URL/session" | python3 -c '
import json, sys
try:
    ss = json.load(sys.stdin)
except Exception:
    sys.exit(0)
mains = [s for s in ss if (s.get("title") or "").strip() == "[MAIN]"]
mains.sort(key=lambda s: s.get("time", {}).get("updated", 0))
print(mains[-1]["id"] if mains else "")' 2>/dev/null
}

SES="${SES_ID:-$(resolve_main)}"
if [ -n "${LOG_FILE:-}" ]; then rows=$(cat "$LOG_FILE" 2>/dev/null)
else rows=$(journalctl --user -u "$UNIT" --since "$SINCE" --no-pager -o cat 2>/dev/null); fi

read -r P95 N < <(printf '%s\n' "$rows" | python3 -c '
import math, re, sys
ses = sys.argv[1]
v = []
for l in sys.stdin:
    if "LAT phase=ok " not in l or " steps=1 " not in l:
        continue
    f = dict(re.findall(r"(\w+)=(\S+)", l))
    if not ses or f.get("session") != ses:
        continue
    try:
        v.append(int(f["total_ms"]) + int(f.get("queue_ms", 0)))
    except (KeyError, ValueError):
        pass
v.sort()
print(v[max(0, math.ceil(0.95 * len(v)) - 1)] if v else 0, len(v))' "$SES")

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PREV=$(cat "$STATE_FILE" 2>/dev/null || echo ok)
STATE=ok
[ "$N" -gt 0 ] && [ "$P95" -gt "$LIMIT_MS" ] && STATE=breach

printf 'time\tp95_ms\tn\tstate\tsession\n%s\t%s\t%s\t%s\t%s\n' "$NOW" "$P95" "$N" "$STATE" "${SES:-unresolved}" >"$OUT_TSV"
if [ "$PREV" = ok ] && [ "$STATE" = breach ]; then
  printf 'lat-p95 ALERT %s — p95=%sms n=%s >%s\n' "$NOW" "$P95" "$N" "$LIMIT_MS" >>"$STATUS_FILE"
fi
printf '%s' "$STATE" >"$STATE_FILE"
cat "$OUT_TSV"
