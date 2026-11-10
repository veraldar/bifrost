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
WILL_DIR="${WILL_DIR:-${AGI_WILL_DIR:-$HOME/Work/bifrost/.agi-log/wills}}"
WAKE_JSON="${WAKE_JSON:-/tmp/.lane-wake.json}"   # station-sim points this at scratch

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
  python3 - "$2" <<'PY' > "$WAKE_JSON"
import json, sys
print(json.dumps({"parts": [{"type": "text", "text": "LANE LANDED (auto-watch): " + sys.argv[1]}]}))
PY
  curl -s -X POST "$BRAIN_URL/session/$1/message" -H 'content-type: application/json' \
    -d @"$WAKE_JSON" --max-time 30 -o /dev/null
}

# A status line counts only when it is complete (newline-terminated) and carries an ISO
# timestamp; a truncated/garbage tail is ignored until a real line lands (station-sim case 8).
last_line() {
  local l; l=$(tail -n1 "$STATUS_FILE" 2>/dev/null)
  [ -n "$(tail -c1 "$STATUS_FILE" 2>/dev/null)" ] && l=""
  [[ "$l" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2} ]] || l=""
  printf '%s' "$l"
}
LAST=$(last_line)

# ---------- durable wake (opus review 9: a signal sent while :4100 is down must be
# retried until a 2xx, never silently consumed) ----------
pend() { grep -qxF "$1" "$STATUS_FILE.pending" 2>/dev/null || printf '%s\n' "$1" >>"$STATUS_FILE.pending"; }
# (grep -v exits 1 when it removes the LAST line — that must still replace the file, else the
# delivered line is replayed every poll: station-sim case 4/5/6)
unpend() { [ -f "$STATUS_FILE.pending" ] || return 0; grep -vxF "$1" "$STATUS_FILE.pending" >"$STATUS_FILE.pending.next" 2>/dev/null; mv "$STATUS_FILE.pending.next" "$STATUS_FILE.pending"; }
# a pending ping/escalation is retried by will_scan itself (it owns the marker) — flushing it
# here too delivered it twice (station-sim case 5); a closed will's leftovers are dropped
unpend_will() { [ -f "$STATUS_FILE.pending" ] || return 0; grep -vF "LANE-WILL (auto-watch): $(basename "$1" .will): " "$STATUS_FILE.pending" >"$STATUS_FILE.pending.next" 2>/dev/null; mv "$STATUS_FILE.pending.next" "$STATUS_FILE.pending"; }

# ---------- delivered registry (dup-wake root fixes, owner report 3x, 11-09) ----------
# $STATUS_FILE.delivered = tsv key<TAB>time<TAB>note. A landing is posted AT MOST once per key:
# key = sha1(artifact path + commit/branch hash from the line), fallback sha1(whole line).
# Every post goes through post_lane_line, so the landing path, flush_pending and will_nudge are
# all covered; a key already in the registry is skipped (callers then unpend it).
DELIVERED="$STATUS_FILE.delivered"
MARKER="AUTO-VERDICT REQUEST: "
line_key() { python3 - "$1" <<'PY'
import hashlib, re, sys
t = sys.argv[1]
art = re.search(r'[^\s"\']+\.(?:md|txt|json|html)\b', t)
h = next((m for m in re.findall(r'\b[0-9a-f]{7,40}\b', t) if re.search(r'\d', m) and re.search(r'[a-f]', m)), None)
print(hashlib.sha1(((art.group(0) + h) if art and h else t).encode()).hexdigest())
PY
}
delivered_has() { grep -q "^$1	" "$DELIVERED" 2>/dev/null; }
delivered_add() { delivered_has "$1" || printf '%s\t%s\t%s\n' "$1" "$(date -Iseconds)" "$2" >>"$DELIVERED"; }

post_lane_line() { # $1 = full text; returns 0 when delivered (2xx), already delivered, or assumed delivered (timeout)
  local sid code rc key text
  text="${1//"$MARKER"/}"                        # exactly ONE marker, added below (replay-path guard)
  key=$(line_key "$text")
  delivered_has "$key" && return 0               # already announced — skip, caller unpends
  sid="${SES_ID:-$(resolve_main)}"
  [ -n "$sid" ] || return 1
  python3 - "$text" "$MARKER" <<'PY' > "$WAKE_JSON"
import json, sys
print(json.dumps({"parts": [{"type": "text", "text": sys.argv[2] + sys.argv[1]}], "meta": {"auto": True}}))
PY
  [ "$(grep -o 'AUTO-VERDICT REQUEST:' "$WAKE_JSON" | wc -l)" = 1 ] || return 1
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BRAIN_URL/session/$sid/message" \
    -H 'content-type: application/json' -d @"$WAKE_JSON" --max-time "${POST_MAX_TIME:-90}"); rc=$?
  case "$code" in 2*) delivered_add "$key" "2xx"; return 0 ;; esac
  # curl timeout (28) = delivered-unknown: a MAIN mid-turn holds the run lock, the brain keeps
  # the queued message and completes the turn after the client gave up. Reposting made 3-6
  # identical landings — record it as assumed-delivered instead (a refused connection or a
  # 5xx is a real failure and stays pending).
  if [ "$rc" = 28 ]; then delivered_add "$key" "unconfirmed-timeout (assumed delivered)"; return 0; fi
  return 1       # ONE attempt per poll cycle
}

flush_pending() {
  [ -f "$STATUS_FILE.pending" ] || return 0
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in *"STATION PING:"*|*"ESCALATION:"*) continue ;; esac   # will_scan owns these
    post_lane_line "$line" || return 0   # brain still down — try again next poll
    unpend "$line"
  done <"$STATUS_FILE.pending"
}

# ---------- LANE-WILL scan ----------
pinged_marker() { printf '%s.pinged' "$1"; }

will_nudge() { # $1 = will path, $2 = message; marker only AFTER the brain acknowledged
  local will="$1" text ok
  text="$(basename "$will" .will): $2"
  if post_lane_line "LANE-WILL (auto-watch): $text"; then
    unpend "LANE-WILL (auto-watch): $text"
    return 0
  fi
  pend "LANE-WILL (auto-watch): $text"
  return 1
}

will_scan() {
  local will artifact budget disp elapsed now session unit rekick
  now=$(date +%s)
  for will in "$WILL_DIR"/*.will; do
    [ -e "$will" ] || return 0
    session=$(grep -oP '^session=\K.*' "$will"); artifact=$(grep -oP '^artifact=\K.*' "$will")
    budget=$(grep -oP '^budget_min=\K.*' "$will"); disp=$(grep -oP '^dispatched=\K.*' "$will")
    unit=$(grep -oP '^unit=\K.*' "$will"); rekick=$(grep -oP '^rekick=\K.*' "$will")
    [ -f "$artifact" ] && { rm -f "$will" "$(pinged_marker "$will")" "$(pinged_marker "$will").esc"; unpend_will "$will"; continue; }   # landed clean — close the will
    elapsed=$(( now - $(date -d "$disp" +%s 2>/dev/null || echo now) ))
    if [ "${budget:-0}" -gt 0 ] && [ $elapsed -ge $((budget * 60)) ] && [ ! -f "$(pinged_marker "$will")" ]; then
      will_nudge "$will" "STATION PING: lane '$session' is over budget (> ${budget}min) with no artifact at $artifact — tell the owner WITHOUT being asked." \
        && touch "$(pinged_marker "$will")"     # marker only on delivered ping
    fi
    if kill -0 "$(grep -oP '^pid=\K.*' "$will")" 2>/dev/null; then continue; fi
    if [ -n "$rekick" ]; then
      if [ ! -f "$(pinged_marker "$will").esc" ]; then
        will_nudge "$will" "ESCALATION: re-kick of lane '$session' also died without writing $artifact — lane needs owner attention." \
          && touch "$(pinged_marker "$will").esc"
      fi
      continue
    fi
    # dead + no artifact + not yet re-kicked: ONE automatic re-kick
    echo "rekick=1" >>"$will"
    will_nudge "$will" "lane '$session' died with no artifact — auto re-kick ONCE via agi-run (artifact $artifact)." || : ;
    (
      export AGI_REKICK=1 AGI_TREE="${AGI_TREE:-}"
      # scratch-env passthrough (station-sim): a sim's re-kick must stay in the sim's
      # log dir / fake claude / in-place mode — defaults unchanged when unset
      for _v in AGI_LOG_DIR AGI_BIN AGI_SYSTEMD AGI_WILL_DIR AGI_STALL_SECS AGI_POLL_SECS; do
        [ -n "${!_v:-}" ] && export "$_v=${!_v}"
      done
      AGI_SYSTEMD="${AGI_SYSTEMD:-1}" "$HOME/Work/bifrost/scripts/agi-run.sh" \
        -s "$session" -f "$(grep -oP '^prompt_file=\K.*' "$will")" \
        ${artifact:+-a "$artifact"} ${budget:+-b "$budget"} </dev/null >/dev/null 2>&1
    ) &
  done
}

while true; do
  sleep "$POLL_SECS"
  flush_pending
  will_scan
  CUR=$(last_line)
  if [ -n "$CUR" ] && [ "$CUR" != "$LAST" ]; then
    if post_lane_line "LANE LANDED (auto-watch): $CUR"; then
      unpend "LANE LANDED (auto-watch): $CUR"
    else
      pend "LANE LANDED (auto-watch): $CUR"   # replayed until the brain answers
    fi
    LAST="$CUR"   # only after delivery or durable pendency — never before
  fi
done
