#!/usr/bin/env bash
# lane-watcher — MAIN's initiator (LABS.md "MAIN initiator duty", binding 10-30).
# Shipped source of truth: this file. Polls the mission status file (one line per
# lane landing); when the tail changes, POSTs the new line into MAIN's live session
# so MAIN wakes and reviews it. Runs as scripts/lane-watcher.service (user unit).
# See docs/coord/README.md for the one-paragraph enable on a fresh box.
#
# Env overrides: STATUS_FILE (default /tmp/sub-status.tsv) · BRAIN_URL (default the
# canonical root :4100) · SES_ID (default: newest session titled "[MAIN]", resolved
# per wake) · POLL_SECS (default 60).
set -u
STATUS_FILE="${STATUS_FILE:-/tmp/sub-status.tsv}"
BRAIN_URL="${BRAIN_URL:-http://127.0.0.1:4100}"
POLL_SECS="${POLL_SECS:-60}"

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

wake() { # $1 = session id, $2 = landing line
  python3 - "$2" <<'PY' > /tmp/.lane-wake.json
import json, sys
print(json.dumps({"parts": [{"type": "text", "text": "LANE LANDED (auto-watch): " + sys.argv[1]}]}))
PY
  # -o /dev/null: silent success, journal shows the wake line below (also matches
  # the coordinator profile's curl allow-list, if a coordinator ever runs this).
  curl -s -X POST "$BRAIN_URL/session/$1/message" -H 'content-type: application/json' \
    -d @/tmp/.lane-wake.json --max-time 30 -o /dev/null \
    && echo "$(date -Is) wake: [$1] <- $CUR" \
    || echo "$(date -Is) wake FAILED: [$1] <- $CUR"
}

LAST=$(tail -1 "$STATUS_FILE" 2>/dev/null)
echo "$(date -Is) lane-watcher up: status=$STATUS_FILE brain=$BRAIN_URL poll=${POLL_SECS}s"
while true; do
  sleep "$POLL_SECS"
  CUR=$(tail -1 "$STATUS_FILE" 2>/dev/null)
  if [ -n "$CUR" ] && [ "$CUR" != "$LAST" ]; then
    LAST="$CUR"
    SID="${SES_ID:-$(resolve_main)}"
    [ -n "$SID" ] && wake "$SID" "$CUR"
  fi
done
