#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 3: fake claude SIGKILLed mid-run -> wrapper FAIL path -> stub + landing line.
case_init 03 "claude SIGKILL mid-run"
export FAKE_ARTIFACT="$CD/art/c3.md" FAKE_LANE=lane3
echo sleep >"$CD/mode.claude"; watcher_start
dispatch lane3 "$FAKE_ARTIFACT" 30
wait_for 10 '[ -s "$CD/fake.runs" ]'; sleep 1
mark; kill -KILL "$(cut -d" " -f1 "$CD/fake.runs" | head -1)"
assert_invariant
check "stub-written" 'grep -q "LANE FAILED" "$FAKE_ARTIFACT"'
check "no-rekick(claude runs=$(rekicks))" '[ "$(rekicks)" -eq 1 ]'
SIG_SUMMARY="FAIL path stub -> LANE LANDED FAILED-STUB"
case_end
