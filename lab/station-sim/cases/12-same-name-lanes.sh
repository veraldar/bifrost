#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 12: two lanes, same name + artifact; the first exits while the second is still running ->
# the dying first lane must not stub over the live lane (artifact missing + pid alive = wait).
case_init 12 "two same-name lanes, first exits"
export FAKE_LANE=lane12 FAKE_ARTIFACT="$CD/art/c12.md"; watcher_start
echo sleep >"$CD/mode.claude"
FAKE_SLEEP=6 dispatch lane12 "$FAKE_ARTIFACT" 30; A_PID=$DISP_PID
wait_for 10 '[ -s "$CD/fake.runs" ]'; sleep 1
FAKE_SLEEP=600 dispatch lane12 "$FAKE_ARTIFACT" 30; B_PID=$DISP_PID
wait_for 20 '! kill -0 "$A_PID" 2>/dev/null'; sleep $((POLL * 3))
check "live-lane-B-not-stubbed-over (artifact absent)" '[ ! -e "$FAKE_ARTIFACT" ]'
check "live-lane-B-will-intact" '[ -f "$WILLS/lane12.will" ] && grep -q "^pid=$B_PID" "$WILLS/lane12.will"'
check "no-rekick-of-live-lane(claude runs=$(rekicks))" '[ "$(rekicks)" -eq 2 ]'
check "no-landing-line-for-live-lane($(sig_count))" '[ "$(sig_count)" -eq 0 ]'
printf done >"$FAKE_ARTIFACT"; printf 'lane12 DONE %s — B landed\n' "$(date -Iseconds)" >>"$STATUS"; mark   # B finishes for real
kill -TERM "$(tail -1 "$CD/fake.runs" | cut -d" " -f1)" 2>/dev/null
wait_for 12 '[ "$(sig_count)" -ge 1 ]'; settle
check "one-terminal-signal-after-B-lands($(sig_count))" '[ "$(sig_count)" -eq 1 ]'
check "no-leftover-wills/markers" '[ -z "$(ls -A "$WILLS")" ]'
SIG_SUMMARY="A exits; B live: no stub, no rekick; B lands -> 1 signal"
case_end
