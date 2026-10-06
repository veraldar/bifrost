#!/usr/bin/env bash
# agi-run.sh — THE fleet delegation wrapper. Every lab `claude -p` run goes through here.
# Fleet rule 10-04 (docs/lab-playbook.md): an unmeasured delegation did not happen.
#
# Usage:
#   agi-run.sh -s SESSION [-m MODEL] [-f PROMPT_FILE] ["PROMPT TEXT"]
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
set -u

usage() { sed -n '2,10p' "$0"; exit 2; }

SESSION="unknown"
MODEL="${AGI_MODEL:-sonnet}"
PROMPT_FILE=""
PROMPT=""
while getopts "s:m:f:h" opt; do
  case "$opt" in
    s) SESSION="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    f) PROMPT_FILE="$OPTARG" ;;
    h|*) usage ;;
  esac
done
shift $((OPTIND-1))
[ $# -gt 0 ] && PROMPT="$1"
if [ -z "$PROMPT" ] && [ -n "$PROMPT_FILE" ]; then PROMPT="$(cat "$PROMPT_FILE")"; fi
if [ -z "$PROMPT" ] && [ ! -t 0 ]; then PROMPT="$(cat)"; fi
[ -z "$PROMPT" ] && { echo "agi-run: no prompt given (arg, -f FILE, or stdin)" >&2; exit 2; }

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
      "$start_iso" "-" "-" "-" "RUNNING" "$LOG_DIR/outputs/$runid.txt" "-" >>"$LOG"
  ) 9>"$LOCK"

  setsid "$BIN" -p "$PROMPT" \
    --dangerously-skip-permissions \
    --model "$MODEL" \
    --output-format stream-json --verbose \
    >"$out" 2>"$err" &
  local pid=$!

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

i=0
MAX_ATTEMPTS=$((RETRIES + 1))
while :; do
  i=$((i + 1))
  RUNID="$(date -u +%Y%m%dT%H%M%SZ)-a$i-$$"
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
    echo "agi-run: [$SESSION] FAILED — stalled twice, retry exhausted. evidence: $LOG_DIR/outputs/$RUNID.{jsonl,err}" >&2
    exit 1
  fi

  if [ "$RC" -eq 0 ] && [ "$EXTRACT" -eq 0 ]; then
    [ "$i" -gt 1 ] && NOTE="recovered on retry after stall (attempt $i)"
    log_line "$RUNID" "OK" "0" "$(date '+%F %H:%M:%S%z')" "$DUR" "$NOTE"
    echo "agi-run: [$SESSION] OK in ${DUR}s — output: $LOG_DIR/outputs/$RUNID.txt"
    exit 0
  fi

  [ "$EXTRACT" -eq 3 ] && NOTE="no result event in stream"
  [ "$EXTRACT" -eq 4 ] && NOTE="claude reported is_error"
  log_line "$RUNID" "FAIL" "$RC" "$(date '+%F %H:%M:%S%z')" "$DUR" "$NOTE"
  echo "agi-run: [$SESSION] FAILED (exit $RC, $NOTE). evidence: $LOG_DIR/outputs/$RUNID.{jsonl,err}" >&2
  exit 1
done
