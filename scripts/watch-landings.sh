#!/usr/bin/env bash
# lane-watcher — MAIN's initiator timer (LABS.md "MAIN initiator duty", binding 10-30).
# Polls /tmp/sub-status.tsv (mission runners append one line per lane landing); when the
# tail changes, POSTs the new line into MAIN's live session so MAIN wakes and reviews it.
# Promoted 10-30 from the hand-run transient `systemd-run /tmp/watch-landings.sh`
# (session coord-tools). Unit: scripts/lane-watcher.service (user unit).
#
# Env overrides: STATUS_FILE (default /tmp/sub-status.tsv) · BRAIN_URL (default the
# canonical root :4100) · SES_ID (default: newest session titled "[MAIN]", resolved
# per wake) · POLL_SECS (default 60).
#
# LANE-WILL scan (owner law 11-09: silent lane death must never happen again): every
# dispatch registers a will file in ~/.agi-log/wills/ (session, owed artifact, budget).
# Per poll: budget elapsed + artifact missing = STATION PING to MAIN (nudge, re-armed
# only when the artifact appears or a new dispatch line lands). If the will's lane is
# DEAD with no artifact: auto re-kick ONCE through agi-run.sh (re-kick marker in the
# will file); a will that re-kicks a second time (and is still dead + artifactless)
# escalates to MAIN loudly. Artifact seen = will closed, file removed.
set -u
STATUS_FILE="${STATUS_FILE:-/tmp/sub-status.tsv}"
BRAIN_URL="${BRAIN_URL:-http://127.0.0.1:4100}"
POLL_SECS="${POLL_SECS:-60}"
WILL_DIR="${WILL_DIR:-$HOME/Work/bifrost/.agi-log/wills}"

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
  curl -s -X POST "$BRAIN_URL/session/$1/message" -H 'content-type: application/json' \
    -d @/tmp/.lane-wake.json --max-time 30 -o /dev/null
}

LAST=$(tail -1 "$STATUS_FILE" 2>/dev/null)

# ---------- LANE-WILL scan ----------
pinged_marker() { printf '%s.pinged' "$1"; }

will_nudge() { # $1 = will path, $2 = message
  local sid msg
  sid="${SES_ID:-$(resolve_main)}"
  [ -n "$sid" ] || return 0
  msg="$(basename "$1" .will): $2"
  python3 - "$msg" <<'PY' > /tmp/.lane-nudge.json
import json, sys
print(json.dumps({"parts": [{"type": "text", "text": "LANE-WILL (auto-watch): " + sys.argv[1]}]}))
PY
  curl -s -X POST "$BRAIN_URL/session/$sid/message" -H 'content-type: application/json' \
    -d @/tmp/.lane-nudge.json --max-time 30 -o /dev/null
}

will_scan() {
  local will artifact budget disp elapsed now session unit rekick
  now=$(date +%s)
  for will in "$WILL_DIR"/*.will; do
    [ -e "$will" ] || return 0
    session=$(grep -oP '^session=\K.*' "$will"); artifact=$(grep -oP '^artifact=\K.*' "$will")
    budget=$(grep -oP '^budget_min=\K.*' "$will"); disp=$(grep -oP '^dispatched=\K.*' "$will")
    unit=$(grep -oP '^unit=\K.*' "$will"); rekick=$(grep -oP '^rekick=\K.*' "$will")
    [ -f "$artifact" ] && { rm -f "$will"; continue; }        # landed clean — close the will
    elapsed=$(( now - $(date -d "$disp" +%s 2>/dev/null || echo now) ))
    if [ "${budget:-0}" -gt 0 ] && [ $elapsed -ge $((budget * 60)) ] && [ ! -f "$(pinged_marker "$will")" ]; then
      touch "$(pinged_marker "$will")"                        # one nudge per will until state changes
      will_nudge "$will" "STATION PING: lane '$session' is over budget (${elapsed}s > ${budget}min) with no artifact at $artifact — tell the owner WITHOUT being asked."
    fi
    if kill -0 "$(grep -oP '^pid=\K.*' "$will")" 2>/dev/null; then continue; fi
    [ -n "$rekick" ] && {
      [ -f "$(pinged_marker "$will").esc" ] || {
        touch "$(pinged_marker "$will").esc"
        will_nudge "$will" "ESCALATION: re-kick of lane '$session' also died without writing $artifact — lane needs owner attention."
      }
      continue
    }
    # dead + no artifact + not yet re-kicked: ONE automatic re-kick
    echo "rekick=1" >>"$will"
    will_nudge "$will" "lane '$session' died with no artifact — auto re-kick ONCE via agi-run (artifact $artifact)."
    (
      export AGI_REKICK=1 AGI_TREE="${AGI_TREE:-}"
      AGI_SYSTEMD=1 "$HOME/Work/bifrost/scripts/agi-run.sh" \
        -s "$session" -f "$(grep -oP '^prompt_file=\K.*' "$will")" \
        ${artifact:+-a "$artifact"} ${budget:+-b "$budget"} </dev/null >/dev/null 2>&1
    ) &
  done
}

while true; do
  sleep "$POLL_SECS"
  will_scan
  CUR=$(tail -1 "$STATUS_FILE" 2>/dev/null)
  if [ -n "$CUR" ] && [ "$CUR" != "$LAST" ]; then
    LAST="$CUR"
    SID="${SES_ID:-$(resolve_main)}"
    [ -n "$SID" ] && wake "$SID" "$CUR"
  fi
done
