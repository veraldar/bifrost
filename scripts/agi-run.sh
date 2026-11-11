#!/usr/bin/env bash
# agi-run.sh — THE fleet delegation wrapper. Every lab `claude -p` run goes through here.
# Fleet rule 10-04 (docs/lab-playbook.md): an unmeasured delegation did not happen.
#
# Usage:
#   agi-run.sh -s SESSION [-m MODEL] [-f PROMPT_FILE] [-a ARTIFACT] [-b BUDGET_MIN] ["PROMPT TEXT"]
#   echo "prompt" | agi-run.sh -s SESSION
#
# What it does:
#   - runs `claude -p --dangerously-skip-permissions --model <MODEL> --output-format stream-json`
#     (model ALWAYS pinned — the account default is never trusted)
#   - logs one TSV evidence line per attempt to $AGI_LOG_DIR/log.tsv:
#     runid, date, session, model, start, end, duration_s, exit, status, output_file, note
#   - stall detection: if the output stream has not grown for AGI_STALL_SECS (default 600),
#     kill the run and retry ONCE; if the retry also stalls or fails, report failure.
#
# Env knobs (defaults are the fleet standard; overrides exist for testing):
#   AGI_MODEL       default pinned model (sonnet)
#   AGI_STALL_SECS  stall window in seconds (600)
#   AGI_RETRIES     retries after a stall (1)
#   AGI_LOG_DIR     evidence dir (~/Work/bifrost/.agi-log)
#   AGI_BIN         claude binary (claude)
#   AGI_SYSTEMD     1 (default) = re-exec under `systemd-run --user` so the lane lives in its own
#                   transient unit, OUTSIDE the caller's cgroup (restarting the hosting brain kills
#                   no lane). 0 = run in-place (tests only).
#   AGI_PUSH_URL    where the completion letter is pushed (http://127.0.0.1:8090/api/push — the
#                   sandbox PWA; never :8080/:4096). Empty = write the letter, skip the push.
#   AGI_LETTER_DIR  letters dir (~/Work/bifrost/artifacts/letters)
set -u

usage() { sed -n '2,10p' "$0"; exit 2; }

SESSION="unknown"
MODEL="${AGI_MODEL:-sonnet}"
PROMPT_FILE=""
PROMPT=""
ARTIFACT="${AGI_ARTIFACT:-}"
BUDGET_MIN="${AGI_BUDGET_MIN:-}"
WILL_DIR="${AGI_WILL_DIR:-$HOME/Work/bifrost/.agi-log/wills}"
STATUS_FILE="${AGI_STATUS_FILE:-/tmp/sub-status.tsv}"


while getopts "s:m:f:a:b:h" opt; do
  case "$opt" in
    s) SESSION="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    f) PROMPT_FILE="$OPTARG" ;;
    a) ARTIFACT="$OPTARG" ;;
    b) BUDGET_MIN="$OPTARG" ;;
    h|*) usage ;;
  esac
done
shift $((OPTIND-1))
[ $# -gt 0 ] && PROMPT="$1"
if [ -z "$PROMPT" ] && [ -n "$PROMPT_FILE" ]; then PROMPT="$(cat "$PROMPT_FILE")"; fi
if [ -z "$PROMPT" ] && [ ! -t 0 ]; then PROMPT="$(cat)"; fi
[ -z "$PROMPT" ] && { echo "agi-run: no prompt given (arg, -f FILE, or stdin)" >&2; exit 2; }

# --- dispatch-time path check (owner 11-10): a typo'd artifact dir (/home/ddweeb_xyz/...) used to
# spawn a whole lane whose stub then failed to write. Refuse BEFORE any will/spawn.
if [ -n "$ARTIFACT" ]; then
  _pdir="$(dirname "$ARTIFACT")"
  if [ ! -d "$_pdir" ]; then
    echo "agi-run: REFUSED — artifact parent dir does not exist: $_pdir (artifact $ARTIFACT) — typo? nothing spawned" >&2
    exit 2
  fi
fi

# --- canon header (owner [RUN] canon-enforce 10-31) ------------------------------------------
# Every MAIN brief carries the construct contract (docs/CONSTRUCT.md, 10-30) as its first
# lines. Sha pins the canon file — bump it whenever CONSTRUCT.md changes (canon-check.sh
# verifies trees against the same sha). Idempotent: never double-inject.
CANON_SHA="3a37c2945973b2e0cc56f29cd22e3d04d6f35f3d6c91de96e2fb22e681f7e76e"
_canon="CANON: Veraldar=org, Yggdrasil=product (root=brain, trunk=private line, branch=app; bifrost=first branch). Canon file: docs/CONSTRUCT.md sha256=${CANON_SHA}. Naming/structure work without this contract = refuse. Every report you land carries one canon line: run scripts/canon-check.sh and paste its CANON row."
case "$PROMPT" in *"CANON: Veraldar=org"*) : ;; *) PROMPT="${_canon}

${PROMPT}" ;; esac

# --- LANE-WILL (owner law 11-09: silent lane death must never happen again) -------------------
# Every dispatched lane is told: write your artifact — even FAILED with partial state — BEFORE
# going idle. If the lane dies without one, the harness writes the stub for it (guarantee below),
# and the auto-watch re-kicks once, then escalates to the station.
_will_law="LANE-WILL (binding, owner 11-09): before going idle you MUST write your brief's artifact file (even if it says FAILED + partial state). An idle lane with no artifact is auto-re-kicked once, then escalated. better-loops: an artifact whose verdict is PARTIAL/BLOCKED/RIG MUST carry a Next-actions: block (first line `# name — VERDICT: …`); a non-green verdict auto-dispatches a follow-up (max 3)."
case "$PROMPT" in *"LANE-WILL (binding"*) : ;; *) PROMPT="${PROMPT}

${_will_law}" ;; esac


# --- launch dedupe (owner row 11-10): a RUNNING same-session lane owns the artifact —
# a second launch stands down WITHOUT a will/stub (SKIPPED-DUP), so the watch never alarms.
_dedup_skip() { # $1 = live pid
  printf '%s\t%s\t-\tRUNNING\n' "$(date -u +%Y%m%dT%H%M%SZ-a1-$$)" "$SESSION" >>"${LOG_DIR:-$HOME/Work/bifrost/.agi-log}/log.tsv" 2>/dev/null || true
  printf '%s\n' "lane SKIPPED-DUP $SESSION — same-session lane pid $1 already RUNNING, second launch stands down (no will, no stub) $(date -Iseconds)" >>"$STATUS_FILE" 2>/dev/null || true
  echo "agi-run: [$SESSION] SKIPPED-DUP — live pid $1 owns this lane" >&2
  exit 0
}
if [ -z "${AGI_IN_UNIT:-}" ] && [ -n "$SESSION" ] && [ "$SESSION" != "unknown" ]; then
  _sess_pat="agi-lane-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '-')-*.service"
  for _u in $(systemctl --user list-units "$_sess_pat" --no-legend --no-pager 2>/dev/null | awk '$4=="running"{print $1}'); do
    _mpid="$(systemctl --user show -p MainPID --value "$_u" 2>/dev/null)"
    if [ -n "$_mpid" ] && [ "$_mpid" != "0" ] && kill -0 "$_mpid" 2>/dev/null; then
      _dedup_skip "unit $_u"   # name-keyed + MainPID alive: a lingering unit with a dead pid is NOT running
    fi
  done
  for _w in "$WILL_DIR"/$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '-').will; do
    [ -f "$_w" ] || continue
    _unit="$(grep -oP '^unit=\K\S+' "$_w" 2>/dev/null | head -1)"
    if [ -n "$_unit" ] && [ "$_unit" != "none" ] && systemctl --user is-active --quiet "$_unit" 2>/dev/null; then
      _dedup_skip "unit $_unit"   # inner lane registered its unit and it is RUNNING
    fi
    _wpid="$(grep -oP '^pid=\K\d+' "$_w" 2>/dev/null | head -1)"
    # only a live claude PROCESS counts as a lane: a stuck outer dispatcher (unit=none,
    # wrapper alive while the inner never started) must not block re-kicks (11-10 lesson)
    if [ -n "$_wpid" ] && kill -0 "$_wpid" 2>/dev/null; then
      case "$(tr '\0' ' ' < "/proc/$_wpid/cmdline" 2>/dev/null)" in
        *claude*) _dedup_skip "pid $_wpid" ;;
      esac
    fi
  done
fi

# --- will + budget registration (the watch's contract) ----------------------------------------
# Will file: who, what artifact, budget window. $-expanded (no eval). Removed only on clean exit
# with the artifact present — any other ending leaves it behind for the watch to act on.
WILL_FILE=""
if [ -n "$ARTIFACT" ]; then
  mkdir -p "$WILL_DIR" 2>/dev/null || true
  # session-keyed: the outer dispatcher writes the will as its dispatch record; the inner
  # (in-unit) invocation UPSERTS the same file with its own pid/unit (if the outer died
  # before the unit started, the will survives with a dead pid → the watch re-kicks —
  # the dispatch-abort class is covered by the same mechanism).
  WILL_FILE="$WILL_DIR/$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '-').will"
  _abs_artifact="$ARTIFACT"
  case "$ARTIFACT" in
    /*) : ;;
    *)  _abs_artifact="$PWD/${ARTIFACT#./}" ;;  # the watcher runs from $HOME — relative paths never resolve there
  esac
  printf 'session=%s\nartifact=%s\nbudget_min=%s\npid=%s\nunit=%s\ndispatched=%s\nprompt_file=%s\n%s\n' \
    "$SESSION" "$_abs_artifact" "${BUDGET_MIN:-0}" "$$" "${AGI_UNIT:-none}" "$(date -Iseconds)" \
    "${PROMPT_FILE:--}" "${AGI_REKICK:+rekick=1}" >"$WILL_FILE" 2>/dev/null || WILL_FILE=""
fi

# better-loops: artifact delivered → the shared helper auto-dispatches a follow-up when its verdict is
# non-green (same implementation the lane-watcher uses; dedupe + 3-iteration cap live there).
lane_followup() { # $1 = absolute artifact path
  [ "${AGI_FOLLOWUP_OFF:-0}" = 1 ] && return 0
  LF_IGNORE_UNIT="${AGI_UNIT:-}" STATUS_FILE="$STATUS_FILE" timeout 60 "$(dirname "$(readlink -f "$0")")/lane-followup.sh" "$1" >&2 || true
}

# Exit guarantee: a lane that ends without having written its artifact still leaves the marker —
# FAILED + partial state — so the station is never silently dark (owner law 11-09).
lane_will_finish() { # $1 = final status, $2 = note
  [ -n "$ARTIFACT" ] || return 0
  _abs_artifact="$ARTIFACT"
  case "$ARTIFACT" in
    /*) : ;;
    *)  _abs_artifact="$PWD/${ARTIFACT#./}" ;;
  esac
  if [ -f "$_abs_artifact" ]; then
    rm -f "${WILL_FILE:-/nonexistent}" "${WILL_FILE:-/nonexistent}.pinged" "${WILL_FILE:-/nonexistent}.pinged.esc" 2>/dev/null
    lane_followup "$_abs_artifact"
    return 0
  fi
  # same-name lane still alive owns this will + artifact: its death is the one to stub, not ours
  # (station-sim case 12)
  local _wpid; _wpid=$(grep -oP '^pid=\K.*' "${WILL_FILE:-/nonexistent}" 2>/dev/null)
  if [ -n "$_wpid" ] && [ "$_wpid" != "$$" ] && kill -0 "$_wpid" 2>/dev/null; then
    echo "agi-run: [$SESSION] ended ($1) but same-name lane pid $_wpid is live — no stub, will left to it" >&2
    return 0
  fi
  # name-keyed units: ANY live same-session unit owns the artifact (will pid may be dead/consumed)
  local _lu
  for _lu in $(systemctl --user list-units "agi-lane-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '-')-*.service" --no-legend --no-pager 2>/dev/null | awk '$4=="running"{print $1}'); do
    [ "$_lu" = "${AGI_UNIT:-}.service" ] || [ "$_lu" = "${AGI_UNIT:-}" ] && continue
    echo "agi-run: [$SESSION] ended ($1) but unit $_lu is live — no stub, no status line" >&2
    return 0
  done
  local adir; adir=$(dirname "$_abs_artifact"); mkdir -p "$adir" 2>/dev/null || true
  printf '# LANE FAILED — auto-stub by agi-run (LANE-WILL, owner 11-09)\n\n- lane: %s\n- final status: %s\n- note: %s\n- artifact the lane owed: %s (never written)\n- evidence: %s\n- dispatched: %s\n\nThe lane ended without writing its artifact. Partial state lives on its branch/logs above; the auto-watch has been notified.\n' \
    "$SESSION" "$1" "$2" "$_abs_artifact" "${LOG_DIR}/outputs/${RUNID_LAST:-unknown}.*" "$(date -Iseconds)" >"$_abs_artifact" 2>/dev/null || true
  local _sw=""
  if [ ! -f "$_abs_artifact" ]; then
    _sw=" STUB-WRITE-FAILED"
    echo "agi-run: [$SESSION] STUB WRITE FAILED — cannot write $_abs_artifact (unwritable dir?); status line still posted" >&2
  fi
  printf '%s\n' "lane-will FAILED-STUB $SESSION artifact=$ARTIFACT status=$1${_sw} $(date -Iseconds)" >>"$STATUS_FILE" 2>/dev/null || true
  rm -f "${WILL_FILE:-/nonexistent}" "${WILL_FILE:-/nonexistent}.pinged" "${WILL_FILE:-/nonexistent}.pinged.esc" 2>/dev/null
  [ -f "$_abs_artifact" ] && lane_followup "$_abs_artifact"
}

# --- one door, outside the caller's cgroup (S4): re-exec under systemd-run -------------------
# The prompt travels via a file so quoting/stdin survive the hop. AGI_IN_UNIT marks the child.
if [ "${AGI_SYSTEMD:-1}" = "1" ] && [ -z "${AGI_IN_UNIT:-}" ] && command -v systemd-run >/dev/null 2>&1; then
  _d="${AGI_LOG_DIR:-$HOME/Work/bifrost/.agi-log}/prompts"; mkdir -p "$_d"
  _pf="$_d/$(date -u +%Y%m%dT%H%M%SZ)-$$.txt"; printf '%s' "$PROMPT" >"$_pf"
  _unit="agi-lane-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '-')-$$"
  _envs=(); for _v in AGI_MODEL AGI_STALL_SECS AGI_RETRIES AGI_LOG_DIR AGI_BIN AGI_POLL_SECS AGI_PUSH_URL AGI_LETTER_DIR AGI_DETACH AGI_WILL_DIR AGI_STATUS_FILE AGI_REKICK; do
    [ -n "${!_v:-}" ] && _envs+=("--setenv=$_v=${!_v}"); done
  _wait=(--wait --pipe --collect --property=TimeoutStartSec=600)   # foreground: same blocking contract as before; AGI_DETACH=1 returns at once
  [ "${AGI_DETACH:-0}" = "1" ] && _wait=(--collect --property=TimeoutStartSec=600)
  _extra=()
  [ -n "$ARTIFACT" ] && _extra+=(-a "$ARTIFACT")
  [ -n "$BUDGET_MIN" ] && _extra+=(-b "$BUDGET_MIN")
  exec systemd-run --user --quiet --unit="$_unit" --description="agi lane $SESSION" \
    --property=TimeoutStartSec=600 --working-directory="$PWD" --setenv=AGI_IN_UNIT=1 --setenv=AGI_UNIT="$_unit" --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
    "${_envs[@]}" "${_wait[@]}" -- "$0" -s "$SESSION" -m "$MODEL" -f "$_pf" "${_extra[@]}"
fi

STALL_SECS="${AGI_STALL_SECS:-600}"
RETRIES="${AGI_RETRIES:-1}"
BIN="${AGI_BIN:-claude}"
LOG_DIR="${AGI_LOG_DIR:-$HOME/Work/bifrost/.agi-log}"
POLL_SECS="${AGI_POLL_SECS:-5}"
mkdir -p "$LOG_DIR/outputs"
LOG="$LOG_DIR/log.tsv"
LOCK="$LOG_DIR/.lock"

log_line() { # runid status exit end dur note
  local runid="$1" status="$2" exitc="$3" end="$4" dur="$5" note="$6" start startdate
  startdate="${1:0:8}"; startdate="${startdate:0:4}-${startdate:4:2}-${startdate:6:2}"
  start="$(grep -P "^${runid}\t" "$LOG" | head -1 | cut -f5)"
  (
    flock 9
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$runid" "$startdate" "$SESSION" "$MODEL" "$start" "$end" "$dur" "$exitc" \
      "$status" "$LOG_DIR/outputs/$runid.txt" "$note" >>"$LOG"
  ) 9>"$LOCK"
}

run_attempt() { # $1 = runid ; sets RC / STALLED / NOTE
  local runid="$1"
  local out="$LOG_DIR/outputs/$runid.jsonl"
  local err="$LOG_DIR/outputs/$runid.err"
  local start_epoch start_iso size last_size last_change now elapsed exitc
  start_epoch=$(date +%s)
  start_iso=$(date '+%F %H:%M:%S%z')

  : >"$out"
  # register RUNNING (fields: end,dur,exit placeholders '-')
  (
    flock 9
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$runid" "${runid:0:4}-${runid:4:2}-${runid:6:2}" "$SESSION" "$MODEL" \
      "$start_iso" "-" "-" "-" "RUNNING" "$LOG_DIR/outputs/$runid.txt" \
      "pid=$$ unit=${AGI_UNIT:-none}" >>"$LOG"
  ) 9>"$LOCK"

  setsid "$BIN" -p "$PROMPT" \
    --dangerously-skip-permissions \
    --model "$MODEL" \
    --output-format stream-json --verbose \
    >"$out" 2>"$err" &
  local pid=$!; CLAUDE_PID=$pid

  STALLED=0
  last_size=-1; last_change=$start_epoch
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL_SECS"
    size=$(stat -c %s "$out" 2>/dev/null || echo 0)
    if [ "$size" != "$last_size" ]; then last_change=$(date +%s); last_size="$size"; fi
    now=$(date +%s)
    if (( now - last_change >= STALL_SECS )); then
      STALLED=1
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      sleep 2
      kill -KILL -- "-$pid" 2>/dev/null || true
      break
    fi
  done
  wait "$pid" 2>/dev/null; exitc=$?
  elapsed=$(( $(date +%s) - start_epoch ))
  RC=$exitc; DUR=$elapsed

  # repo-reshape 10-29: a landed lane pushes its branch — no landed mission stays local-only.
  # Best effort (fails silently with a note); gh/auth downtime never fails a completed run.
  if [ "$RC" = "0" ] && [ "${AGI_AUTO_PUSH:-1}" = "1" ]; then
    _push_branch=$(git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [ -n "${_push_branch:-}" ] && [ "${_push_branch}" != "HEAD" ]; then
      if ! timeout 120 git -C "$PWD" push -u origin "$_push_branch" >>"$LOG_DIR/push.log" 2>&1; then
        echo "push-all note: landed lane '$SESSION' could not push '$_push_branch' (see $LOG_DIR/push.log)" >>"$LOG_DIR/push.log"
      fi
    fi
  fi

  # extract human-readable result (last stream-json "result" event)
  python3 - "$out" "$LOG_DIR/outputs/$runid.txt" <<'PYEOF'
import json, sys
res = None
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") == "result":
        res = e
if res is None:
    sys.exit(3)
t = res.get("result") or ""
if not t.endswith("\n"):
    t += "\n"
open(sys.argv[2], "w", encoding="utf-8").write(t)
sys.exit(4 if res.get("is_error") else 0)
PYEOF
  EXTRACT=$?
}

# Completion letter (envelope v1, v07-reflection §8.6): one file per finished lane in
# $LETTER_DIR, pushed through /api/push. Never fails the run — a letter is a courtesy of the
# harness, so author=harness, kind=result|blocked.
LETTER_DIR="${AGI_LETTER_DIR:-$HOME/Work/bifrost/artifacts/letters}"
PUSH_URL="${AGI_PUSH_URL-http://127.0.0.1:8090/api/push}"
write_letter() { # runid status
  mkdir -p "$LETTER_DIR" 2>/dev/null || return 0
  python3 - "$1" "$2" "$SESSION" "$MODEL" "$LOG_DIR/outputs/$1.txt" "$LETTER_DIR" "$PUSH_URL" <<'PYEOF' || true
import hashlib, json, os, socket, sys, time, urllib.request
runid, status, session, model, out, ldir, push = sys.argv[1:8]
tree = os.environ.get("AGI_TREE") or socket.gethostname().split(".")[0]
body = ""
try:
    body = open(out, encoding="utf-8", errors="replace").read().strip()
except OSError:
    pass
ok = status == "OK"
if not body:
    body = f"{session}: run {runid} ended {status} — no result text (evidence in .agi-log/outputs/)."
body = "\n".join(body.splitlines()[:20])[:1200]            # ≤ one screen
arts = []
if os.path.exists(out):
    b = open(out, "rb").read()
    arts.append({"path": os.path.relpath(out, os.path.expanduser("~/Work/bifrost")) if out.startswith(os.path.expanduser("~/Work/bifrost")) else out,
                 "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)})
lid = f"agi-{runid}"
letter = {"v": 1, "id": lid, "thread": f"{tree}/{lid}", "from": f"{tree}/{session}", "to": tree,
          "author": "harness", "cause": os.environ.get("AGI_CAUSE", ""),
          "kind": "result" if ok else "blocked", "status": status, "body": body,
          "artifacts": arts, "model": model, "time": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
os.makedirs(ldir, exist_ok=True)
path = os.path.join(ldir, f"{lid}.json")
tmp = path + ".tmp"
json.dump(letter, open(tmp, "w"), indent=1); os.replace(tmp, path)
print(f"agi-run: letter {path}")
if push:
    try:
        req = urllib.request.Request(push, data=json.dumps({"letter": letter}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        r = urllib.request.urlopen(req, timeout=10)
        print(f"agi-run: push {push} -> {r.status} {r.read().decode()[:120]}")
    except Exception as e:
        print(f"agi-run: push FAILED ({e}) — letter stays on disk")
PYEOF
}

i=0
MAX_ATTEMPTS=$((RETRIES + 1))
RUNID_LAST=""
# LANE-WILL: even a wrapper killed mid-run (unit stop, reboot) leaves the FAILED stub behind.
# ...and then EXITS (station-sim case 10: the trap used to return into the stall loop, so a TERMed
# wrapper lived on); its setsid'd claude group goes down with it.
trap 'lane_will_finish KILLED "wrapper terminated mid-run"; [ -n "${CLAUDE_PID:-}" ] && kill -TERM -- "-$CLAUDE_PID" 2>/dev/null; exit 143' TERM INT
while :; do
  i=$((i + 1))
  RUNID="$(date -u +%Y%m%dT%H%M%SZ)-a$i-$$"
  RUNID_LAST="$RUNID"
  NOTE="-"
  run_attempt "$RUNID"

  if [ "$STALLED" = "1" ]; then
    if [ "$i" -lt "$MAX_ATTEMPTS" ]; then
      log_line "$RUNID" "ATTEMPT-STALL" "kill" "$(date '+%F %H:%M:%S%z')" "$DUR" \
        "no output growth ${STALL_SECS}s; retrying"
      echo "agi-run: [$SESSION] attempt $i stalled (no output for ${STALL_SECS}s) — killed, retrying" >&2
      continue
    fi
    log_line "$RUNID" "STALLED" "kill" "$(date '+%F %H:%M:%S%z')" "$DUR" \
      "no output growth ${STALL_SECS}s; killed; retry exhausted"
    write_letter "$RUNID" "STALLED"
    lane_will_finish STALLED "stalled twice, retry exhausted"
    echo "agi-run: [$SESSION] FAILED — stalled twice, retry exhausted. evidence: $LOG_DIR/outputs/$RUNID.{jsonl,err}" >&2
    exit 1
  fi

  if [ "$RC" -eq 0 ] && [ "$EXTRACT" -eq 0 ]; then
    [ "$i" -gt 1 ] && NOTE="recovered on retry after stall (attempt $i)"
    log_line "$RUNID" "OK" "0" "$(date '+%F %H:%M:%S%z')" "$DUR" "$NOTE"
    write_letter "$RUNID" "OK"
    lane_will_finish OK "lane landed"
    echo "agi-run: [$SESSION] OK in ${DUR}s — output: $LOG_DIR/outputs/$RUNID.txt"
    exit 0
  fi

  [ "$EXTRACT" -eq 3 ] && NOTE="no result event in stream"
  [ "$EXTRACT" -eq 4 ] && NOTE="claude reported is_error"
  log_line "$RUNID" "FAIL" "$RC" "$(date '+%F %H:%M:%S%z')" "$DUR" "$NOTE"
  write_letter "$RUNID" "FAIL"
  lane_will_finish FAIL "exit $RC, $NOTE"
  echo "agi-run: [$SESSION] FAILED (exit $RC, $NOTE). evidence: $LOG_DIR/outputs/$RUNID.{jsonl,err}" >&2
  exit 1
done
