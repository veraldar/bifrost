#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 11: artifact dir unwritable -> the stub cannot be written: that must be LOUD in the log, the
# FAILED-STUB status line still lands (owner is told), and the will is closed.
case_init 11 "unwritable artifact dir"
mkdir -p "$CD/ro"; chmod 555 "$CD/ro"; export FAKE_LANE=lane11 FAKE_ARTIFACT="$CD/ro/c11.md"
echo write-nolog >"$CD/mode.claude"; watcher_start
dispatch lane11 "$FAKE_ARTIFACT" 30; mark
assert_invariant
check "status-line-FAILED-STUB" 'grep -q "FAILED-STUB lane11" "$STATUS"'
check "stub-failure-LOUD-in-log" 'grep -rqiE "STUB WRITE FAILED" "$CD/spawn.log" "$CD/log"'
chmod 755 "$CD/ro"
SIG_SUMMARY="FAILED-STUB line lands; will closed; stub write failure loud?"
case_end
