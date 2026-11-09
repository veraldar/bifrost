#!/usr/bin/env bash
# station-sim shared helpers. Sourced by each cases/NN-*.sh. Everything lives under
# $SIM_ROOT (default /tmp/station-sim-r1); the real station (unit, wills, /tmp/sub-status.tsv,
# /tmp/.lane-wake.json) is never touched.
SIM_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SIM_HERE/../.." && pwd)"
SIM_ROOT="${SIMDIR:-/tmp/station-sim-r1}"
POLL=2

case_init() { # $1 = case number (2 digits), $2 = title
  CN="$1"; CTITLE="$2"
  CD="$SIM_ROOT/c$CN"; rm -rf "$CD"; mkdir -p "$CD"/{log,wills,brain,work,art}
  PORT=$((14000 + 10#$CN)); PIDS="$CD/pids"; : >"$PIDS"; FAILS=0; RESULT_NOTE=""
  WILLS="$CD/wills"; STATUS="$CD/status.tsv"; POSTS="$CD/brain/posts.log"; : >"$STATUS"; : >"$POSTS"
  echo write >"$CD/mode.claude"
  # agi-run + watcher scratch env (RIG LAW)
  export AGI_SYSTEMD=0 AGI_LOG_DIR="$CD/log" AGI_BIN="$SIM_HERE/mock/claude" AGI_WILL_DIR="$WILLS" \
         AGI_STATUS_FILE="$STATUS" AGI_PUSH_URL= AGI_LETTER_DIR="$CD/letters" AGI_AUTO_PUSH=0 \
         AGI_STALL_SECS=30 AGI_POLL_SECS=1 FAKE_DIR="$CD" FAKE_STATUS="$STATUS"
  export BRAIN_URL="http://127.0.0.1:$PORT" STATUS_FILE="$STATUS" WILL_DIR="$WILLS" POLL_SECS=$POLL \
         WAKE_JSON="$CD/.lane-wake.json"
  unset SES_ID
  brain_start
}

spawn() { # run "$@" detached in its own session; records pid(=pgid) in $PIDS; sets SPID
  setsid "$@" >>"$CD/spawn.log" 2>&1 </dev/null &
  SPID=$!; echo "$SPID" >>"$PIDS"
}
brain_start() { spawn python3 "$SIM_HERE/mock/brain.py" "$PORT" "$CD/brain"; BRAIN_PID=$SPID
  for _ in $(seq 50); do curl -s -o /dev/null "$BRAIN_URL/session" && return 0; sleep 0.1; done; }
brain_stop() { kill "$BRAIN_PID" 2>/dev/null; wait "$BRAIN_PID" 2>/dev/null; }
brain_mode() { echo "$1" >"$CD/brain/mode"; }

watcher_start() { spawn "$REPO/scripts/watch-landings.sh"; WATCH_PID=$SPID; }
watcher_stop() { kill -TERM -- "-$WATCH_PID" 2>/dev/null; }

dispatch() { # $1 session  $2 artifact (as given to -a)  $3 budget min (default 30); cwd = work/
  local s="$1" a="$2" b="${3:-30}"
  [ -f "$CD/prompt.txt" ] || echo "sim task" >"$CD/prompt.txt"
  FAKE_LANE="$s" FAKE_ARTIFACT="$(abs "$a")" spawn bash -c "cd '${DISPATCH_CWD:-$CD/work}' && exec '$REPO/scripts/agi-run.sh' -s '$s' -f '$CD/prompt.txt' -a '$a' -b '$b'"
  DISP_PID=$SPID
}
abs() { case "$1" in /*) echo "$1" ;; *) echo "${DISPATCH_CWD:-$CD/work}/${1#./}" ;; esac; }

wait_for() { # $1 timeout secs, rest = shell test; 0 when it became true
  local t=$1 end=$(( $(date +%s) + $1 )); shift
  while [ "$(date +%s)" -lt "$end" ]; do eval "$*" && return 0; sleep 0.3; done; return 1
}
will_file() { ls "$WILLS"/*.will 2>/dev/null | head -1; }
mark() { EVENT_T=$(date +%s.%N); }          # the fault moment, for the latency check

# --- terminal-signal accounting -------------------------------------------------------------
# A terminal signal = a DELIVERED (2xx) post whose text is LANE LANDED / STATION PING /
# ESCALATION. The "auto re-kick" notice is informational, not terminal. Duplicates count.
sig_count() { python3 - "$POSTS" <<'PY'
import json, sys
n = 0
for l in open(sys.argv[1]):
    try: p = json.loads(l)
    except Exception: continue
    t = p["text"]
    if 200 <= p["code"] < 300 and ("LANE LANDED" in t or "STATION PING" in t or "ESCALATION" in t): n += 1
print(n)
PY
}
sig_latency() { python3 - "$POSTS" "${EVENT_T:-0}" <<'PY'
import json, sys
ev = float(sys.argv[2]); ts = []
for l in open(sys.argv[1]):
    try: p = json.loads(l)
    except Exception: continue
    t = p["text"]
    if 200 <= p["code"] < 300 and ("LANE LANDED" in t or "STATION PING" in t or "ESCALATION" in t): ts.append(p["t"])
print("%.1f" % (min(ts) - ev) if ts else "-")
PY
}
posts_matching() { python3 - "$POSTS" "$1" "${2:-any}" <<'PY'
import json, re, sys
n = 0
for l in open(sys.argv[1]):
    try: p = json.loads(l)
    except Exception: continue
    ok = 200 <= p["code"] < 300
    if re.search(sys.argv[2], p["text"]) and (sys.argv[3] == "any" or (sys.argv[3] == "2xx") == ok): n += 1
print(n)
PY
}
rekicks() { grep -c '' "$CD/fake.runs" 2>/dev/null || echo 0; }   # fake claude invocations

# --- assertions -------------------------------------------------------------------------------
check() { # $1 name, rest = test command; records pass/fail
  local name="$1"; shift
  if eval "$*"; then echo "    ok   $name"; else echo "    FAIL $name"; FAILS=$((FAILS+1)); RESULT_NOTE="$RESULT_NOTE $name;"; fi
}
settle() { sleep $((POLL * 3 + 1)); }      # three polls: any extra/duplicate signal would show
# INVARIANT: exactly one terminal signal (delivered, no dups), within $1 secs (default 2 polls
# + slack) of the fault; afterwards no wills/markers left. Call BEFORE teardown.
assert_invariant() {
  local lim="${1:-$((POLL * 2 + 6))}" lat
  wait_for "$lim" '[ "$(sig_count)" -ge 1 ]'; settle
  lat=$(sig_latency); SIG_LAT="$lat"
  check "exactly-one-terminal-signal(got $(sig_count))" '[ "$(sig_count)" -eq 1 ]'
  check "signal-within-${lim}s(lat=$lat)" '[ "$lat" != - ] && awk "BEGIN{exit !($lat <= $lim)}"'
  check "no-leftover-wills/markers" '[ -z "$(ls -A "$WILLS" 2>/dev/null)" ]'
}
teardown() { # kill everything the case spawned, then assert nothing survived
  watcher_stop 2>/dev/null
  local p
  while read -r p; do [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null; done <"$PIDS"
  sleep 1
  LEFT=""
  while read -r p; do [ -n "$p" ] && [ -n "$(pgrep -g "$p" 2>/dev/null)" ] && { LEFT="$LEFT $p"; kill -KILL -- "-$p" 2>/dev/null; }; done <"$PIDS"
  check "no-leftover-sim-pids${LEFT:+($LEFT)}" '[ -z "$LEFT" ]'
}
case_end() { # prints the one-line table row, exits non-zero on any FAIL
  teardown
  local v=PASS; [ "$FAILS" -gt 0 ] && v="FAIL($RESULT_NOTE)"
  printf 'ROW|%s|%s|%s|%s\n' "$CN" "$CTITLE" "${SIG_SUMMARY:-?}" "$v" | tee "$CD/row"
  [ "$FAILS" -eq 0 ]
}

# hand-written will for a LIVE (sleeper) lane that is long over budget: $1 session $2 artifact $3 pid
old_will() {
  printf 'session=%s\nartifact=%s\nbudget_min=1\npid=%s\nunit=none\ndispatched=%s\nprompt_file=%s\n\n' \
    "$1" "$2" "$3" "$(date -Iseconds -d '-2 hours')" "$CD/prompt.txt" >"$WILLS/$1.will"
}
sleeper() { spawn sleep 300; SLEEP_PID=$SPID; }
