#!/usr/bin/env bash
# agi-chain.sh — THE chain format: "when lane X is done, launch lane Y" — and it STOPS.
# (S4; replaces the hand-rolled prompts/chain-*.sh waiters. No eternal waiters.)
#
# Usage:
#   agi-chain.sh -w UPSTREAM[,UPSTREAM…] [-t EXPIRY_SECS] [--any] -- agi-run args…
#   agi-chain.sh -w ONBOARD-GAPS -t 2700 -- -s ONBOARD-BUILD -m opus -f prompts/onboard-build.txt
#
# Behaviour:
#   - waits until the LATEST agi-run row of every UPSTREAM session is terminal
#       default: all must be OK  → launch;  FAIL/STALLED/DEAD → STOP (exit 4), never launch on red
#       --any:   any terminal state launches (a chain that cleans up after a failure)
#   - EXPIRY (default 2700 s = 45 min): nothing terminal by then → STOP (exit 3). The waiter
#     can never outlive it: it runs in its own transient unit with RuntimeMaxSec=EXPIRY+120
#     as the backstop, outside the caller's cgroup like every lane.
#   - every stop writes one CHAIN-STOP row to the agi log (visible in agi-status), so a
#     chain that did not fire says why instead of vanishing.
#   - each poll reaps dead lanes (agi-status.sh --reap), so a killed upstream reads DEAD, not RUNNING.
#   - launches the downstream via agi-run.sh (AGI_DETACH=1: the chain's job ends at launch).
# Env: AGI_LOG_DIR, AGI_CHAIN_POLL (30 s), AGI_CHAIN_SYSTEMD=0 (run in place — tests only).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${AGI_LOG_DIR:-$HOME/Work/bifrost/.agi-log}"
LOG="$LOG_DIR/log.tsv"
POLL="${AGI_CHAIN_POLL:-30}"
EXPIRY=2700; WAIT=""; ANY=0
ORIG=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    -w) WAIT="$2"; shift 2 ;;
    -t) EXPIRY="$2"; shift 2 ;;
    --any) ANY=1; shift ;;
    --) shift; break ;;
    -h|*) sed -n '2,20p' "$0"; exit 2 ;;
  esac
done
[ -z "$WAIT" ] || [ $# -eq 0 ] && { echo "agi-chain: need -w UPSTREAM and '-- agi-run args'" >&2; exit 2; }

# the downstream's own session name (for the stop row)
DOWN="chain"; prev=""
for a in "$@"; do [ "$prev" = "-s" ] && DOWN="$a"; prev="$a"; done

if [ "${AGI_CHAIN_SYSTEMD:-1}" = "1" ] && [ -z "${AGI_IN_UNIT:-}" ] && command -v systemd-run >/dev/null 2>&1; then
  _envs=(); for _v in AGI_LOG_DIR AGI_BIN AGI_CHAIN_POLL AGI_PUSH_URL AGI_LETTER_DIR AGI_STALL_SECS AGI_SYSTEMD; do
    [ -n "${!_v:-}" ] && _envs+=("--setenv=$_v=${!_v}"); done
  exec systemd-run --user --quiet --collect --unit="agi-chain-${DOWN//[^A-Za-z0-9_.-]/-}-$$" \
    --description="agi chain → $DOWN (waits on $WAIT, expires ${EXPIRY}s)" -p "RuntimeMaxSec=$((EXPIRY + 120))" \
    --working-directory="$PWD" --setenv=AGI_IN_UNIT=1 --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
    "${_envs[@]}" -- "$0" "${ORIG[@]}"
fi

stop_row() { # code reason
  mkdir -p "$LOG_DIR"
  ( flock 9; printf '%s\t%s\t%s\t-\t%s\t%s\t-\t%s\tCHAIN-STOP\t-\t%s\n' "CHAIN-$(date -u +%Y%m%dT%H%M%SZ)-$$" "$(date +%F)" "$DOWN" \
      "$(date '+%F %H:%M:%S%z')" "$(date '+%F %H:%M:%S%z')" "$1" "$2" >>"$LOG" ) 9>"$LOG_DIR/.lock"
  echo "agi-chain: [$DOWN] STOP — $2" >&2
}

latest_status() { # session → status of its newest row ('' if none)
  [ -f "$LOG" ] || return 0
  tac "$LOG" | awk -F'\t' -v s="$1" '$3==s {print $9; exit}'
}

deadline=$(( $(date +%s) + EXPIRY ))
IFS=',' read -ra UP <<<"$WAIT"
while :; do
  AGI_LOG_DIR="$LOG_DIR" "$HERE/agi-status.sh" --reap >/dev/null 2>&1
  pending=0; red=""
  for u in "${UP[@]}"; do
    st="$(latest_status "$u")"
    case "$st" in
      OK) ;;
      ""|RUNNING) pending=1 ;;
      *) [ "$ANY" = 1 ] || red="$u=$st" ;;
    esac
  done
  if [ -n "$red" ]; then stop_row 4 "upstream not green ($red) — downstream NOT launched"; exit 4; fi
  [ "$pending" = 0 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then stop_row 3 "expired after ${EXPIRY}s still waiting on $WAIT — downstream NOT launched"; exit 3; fi
  sleep "$POLL"
done
echo "agi-chain: [$DOWN] upstream $WAIT done — launching" >&2
AGI_DETACH=1 AGI_IN_UNIT= exec "$HERE/agi-run.sh" "$@"
