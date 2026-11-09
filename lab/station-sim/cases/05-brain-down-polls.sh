#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 5: brain DOWN for 3+ polls while a live lane is over budget -> ping queued, marker NOT burned;
# brain up -> the ping is delivered exactly once.
case_init 05 "brain down 3 polls, then up"
export FAKE_ARTIFACT="$CD/art/c5.md"
sleeper; old_will lane5 "$FAKE_ARTIFACT" "$SLEEP_PID"; echo "x" >"$CD/prompt.txt"
brain_stop; watcher_start; sleep $((POLL * 4 + 1))
check "marker-not-burned-while-down" '[ ! -e "$WILLS/lane5.will.pinged" ]'
check "ping-queued-durably" 'grep -q "STATION PING" "$STATUS.pending"'
brain_start; mark
wait_for 12 '[ "$(sig_count)" -ge 1 ]'; settle
check "exactly-one-ping-delivered(got $(sig_count))" '[ "$(sig_count)" -eq 1 ]'
check "ping-within-4-polls(lat=$(sig_latency))" 'awk "BEGIN{exit !($(sig_latency) <= 8.5)}"'
check "queue-drained" '[ ! -s "$STATUS.pending" ]'
printf done >"$FAKE_ARTIFACT"; sleep $((POLL + 1))   # lane lands -> will + markers closed
check "no-leftover-wills/markers" '[ -z "$(ls -A "$WILLS")" ]'
SIG_SUMMARY="down 4 polls -> pending ping -> delivered once"
case_end
