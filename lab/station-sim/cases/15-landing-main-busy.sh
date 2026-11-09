#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 15: MAIN is mid-run (the brain holds the 2xx 40 s, behind run_lock) -> exactly ONE post
# lands and is delivered once. Old 20 s client timeout + 3-attempt burst = 3 identical posts.
# WATCH_SCRIPT=<old watch-landings.sh> runs the pre-fix comparison (expected to FAIL).
case_init 15 "landing, MAIN busy 40s -> one post (dup-wake regression)"
echo 40 >"$CD/brain/delay"
export FAKE_ARTIFACT="$CD/art/c15.md" FAKE_LANE=lane15
watcher_start; dispatch lane15 "$FAKE_ARTIFACT" 30
wait_for 30 '[ -f "$FAKE_ARTIFACT" ]'
wait_for 20 '[ "$(posts_matching "LANE LANDED")" -ge 1 ]'
sleep 50                                     # delay + >2 polls: any replay would have posted again
n=$(posts_matching "LANE LANDED")
check "exactly-one-post(got $n)" '[ "$n" = 1 ]'
check "delivered-once-2xx" '[ "$(posts_matching "LANE LANDED" 2xx)" = 1 ]'
check "pending-queue-empty" '[ ! -s "$STATUS.pending" ]'
SIG_SUMMARY="MAIN busy 40s: $n post(s)"
case_end
