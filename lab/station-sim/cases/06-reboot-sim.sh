#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 6: reboot: brain down, a landing line is queued and a lane is over budget; watcher killed, the
# /tmp bits (status file, wake json) wiped but wills+pending kept; brain + watcher back ->
# pending flushed once, will scanned, no duplicate pings.
case_init 06 "reboot sim (watcher killed, /tmp wiped)"
export FAKE_ARTIFACT="$CD/art/c6.md" FAKE_LANE=lane6; echo x >"$CD/prompt.txt"
sleeper; old_will lane6 "$FAKE_ARTIFACT" "$SLEEP_PID"
brain_stop; watcher_start; sleep 2
printf 'otherlane DONE %s — landed before the reboot\n' "$(date -Iseconds)" >>"$STATUS"; sleep $((POLL * 3))
check "pending-holds-landing" 'grep -q otherlane "$STATUS.pending"'
kill -KILL -- "-$WATCH_PID"; rm -f "$STATUS" "$WAKE_JSON"
brain_start; watcher_start; mark
wait_for 14 '[ "$(sig_count)" -ge 2 ]'; settle
check "landing-delivered-exactly-once($(posts_matching otherlane 2xx))" '[ "$(posts_matching otherlane 2xx)" -eq 1 ]'
check "ping-delivered-exactly-once($(posts_matching "STATION PING" 2xx))" '[ "$(posts_matching "STATION PING" 2xx)" -eq 1 ]'
check "total-terminal=2(got $(sig_count))" '[ "$(sig_count)" -eq 2 ]'
check "queue-drained" '[ ! -s "$STATUS.pending" ]'
printf done >"$FAKE_ARTIFACT"; sleep $((POLL + 1))
check "no-leftover-wills/markers" '[ -z "$(ls -A "$WILLS")" ]'
SIG_SUMMARY="pending flushed once + 1 ping, no dups"
case_end
