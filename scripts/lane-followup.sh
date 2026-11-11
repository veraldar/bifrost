#!/usr/bin/env bash
# lane-followup — shared implementation of the better-loops law (no lane ends PARTIAL and stops).
# Called by watch-landings.sh (landing rows + retro sweep at start) and agi-run.sh (artifact delivery).
#   lane-followup.sh ARTIFACT.md | --sweep      — see scripts/lane_followup.py header
exec python3 "$(dirname "$(readlink -f "$0")")/lane_followup.py" "$@"
