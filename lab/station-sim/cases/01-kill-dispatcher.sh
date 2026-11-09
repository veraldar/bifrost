#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 1: dispatcher (outer agi-run) SIGKILLed right after the will is written -> dead-pid will ->
# watch re-kicks ONCE -> the re-kicked fake claude lands the artifact.
case_init 01 "dispatcher SIGKILL pre-unit-start"
export FAKE_ARTIFACT="$CD/art/c1.md" FAKE_LANE=lane1
echo sleep >"$CD/mode.claude"; watcher_start
dispatch lane1 "$FAKE_ARTIFACT" 30
wait_for 10 '[ -n "$(will_file)" ] && [ -s "$CD/fake.runs" ]'
kill -KILL "$DISP_PID"; kill -TERM "$(cut -d" " -f1 "$CD/fake.runs" | head -1)" 2>/dev/null   # dispatcher + its orphan claude
echo write >"$CD/mode.claude"; mark
assert_invariant 20
check "exactly-one-rekick(claude runs=$(rekicks))" '[ "$(rekicks)" -eq 2 ]'
check "artifact-landed" '[ -f "$FAKE_ARTIFACT" ]'
SIG_SUMMARY="rekick x1 -> LANE LANDED"
case_end
