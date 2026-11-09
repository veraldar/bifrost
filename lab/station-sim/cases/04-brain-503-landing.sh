#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 4: brain answers 503 while a landing line is posted -> pending queue -> brain back -> the
# line is delivered (2xx) exactly once, the queue drains.
case_init 04 "brain 503 during landing post"
export FAKE_ARTIFACT="$CD/art/c4.md" FAKE_LANE=lane4
brain_mode 503; watcher_start
dispatch lane4 "$FAKE_ARTIFACT" 30
wait_for 30 '[ -s "$STATUS.pending" ]'
check "line-was-refused-and-queued" '[ -s "$STATUS.pending" ]'
check "nothing-delivered-while-503" '[ "$(sig_count)" -eq 0 ]'
brain_mode ok; mark
assert_invariant 20
check "queue-drained" '[ ! -s "$STATUS.pending" ]'
SIG_SUMMARY="503 x3 -> pending -> delivered once after flip"
case_end
