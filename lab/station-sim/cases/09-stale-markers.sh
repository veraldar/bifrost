#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 9: stale .pinged/.esc markers + an artifact that landed -> the watch closes the will AND
# removes the markers; the next same-name dispatch starts clean (its over-budget ping fires).
case_init 09 "stale markers + same-name redispatch"
export FAKE_ARTIFACT="$CD/art/c9.md" FAKE_LANE=lane9; echo x >"$CD/prompt.txt"
sleeper; old_will lane9 "$FAKE_ARTIFACT" "$SLEEP_PID"; touch "$WILLS/lane9.will.pinged" "$WILLS/lane9.will.pinged.esc"
printf done >"$FAKE_ARTIFACT"; watcher_start; sleep $((POLL * 2 + 1))
check "will+markers-removed-on-landing" '[ -z "$(ls -A "$WILLS")" ]'
rm -f "$FAKE_ARTIFACT"                                   # phase B: same name, new dispatch, over budget
echo sleep >"$CD/mode.claude"; FAKE_SLEEP=600 dispatch lane9 "$FAKE_ARTIFACT" 1
wait_for 10 '[ -n "$(will_file)" ]'; sed -i "s/^dispatched=.*/dispatched=$(date -Iseconds -d '-2 hours')/" "$WILLS/lane9.will"; mark
wait_for 10 '[ "$(posts_matching "STATION PING" 2xx)" -ge 1 ]'; settle
check "fresh-dispatch-ping-fires-once($(posts_matching "STATION PING" 2xx))" '[ "$(posts_matching "STATION PING" 2xx)" -eq 1 ]'
kill -KILL "$(tail -1 "$CD/fake.runs" | cut -d" " -f1)"; sleep $((POLL * 2 + 2))    # lane dies -> stub landing
check "no-rekick-after-stub(claude runs=$(rekicks))" '[ "$(rekicks)" -eq 1 ]'
check "no-leftover-wills/markers" '[ -z "$(ls -A "$WILLS")" ]'
SIG_SUMMARY="markers cleared; redispatch: 1 ping + 1 stub landing"
case_end
