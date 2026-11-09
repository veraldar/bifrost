#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 2: wrapper SIGTERM mid-claude (unit stop: systemd TERMs the claude too) -> TERM trap writes the
# stub + status line -> one signal, NO re-kick (stub counts as artifact).
case_init 02 "wrapper SIGTERM mid-claude"
export FAKE_ARTIFACT="$CD/art/c2.md" FAKE_LANE=lane2
echo sleep >"$CD/mode.claude"; watcher_start
dispatch lane2 "$FAKE_ARTIFACT" 30
wait_for 10 '[ -s "$CD/fake.runs" ]'; sleep 1
mark; kill -TERM "$DISP_PID" "$(cut -d" " -f1 "$CD/fake.runs" | head -1)" 2>/dev/null
assert_invariant
check "stub-written" 'grep -q "LANE FAILED" "$FAKE_ARTIFACT"'
check "no-rekick(claude runs=$(rekicks))" '[ "$(rekicks)" -eq 1 ]'
SIG_SUMMARY="TERM-trap stub -> LANE LANDED FAILED-STUB, no rekick"
case_end
