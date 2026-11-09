#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 17: the same landing line while the brain 2xx-lags past the client timeout (scaled: 12 s hold vs
# POST_MAX_TIME=4 stands for >90 s vs 90) then recovers -> exactly ONE user message reaches MAIN,
# the registry holds the key once, pending is empty, and a watcher restart / a re-appended identical
# line / a hand-pended prefixed copy post nothing more. Exactly one AUTO-VERDICT marker per post.
case_init 17 "client timeout on a lagging brain -> one post, registry once"
export POST_MAX_TIME=4
echo 12 >"$CD/brain/delay"
LINE="lane17 DONE 2026-11-09T21:00:00+01:00 — artifacts/c17.md landed at commit abc1234def (branch c17-r1)"
watcher_start; sleep 1
printf '%s\n' "$LINE" >>"$STATUS"
wait_for 15 '[ "$(posts_matching "LANE LANDED")" -ge 1 ]'
sleep 16; brain_mode ok; echo 0 >"$CD/brain/delay"        # brain recovered
watcher_stop; sleep 1; watcher_start                          # restart: the old pending replay trigger
printf '%s\n' "${LINE/21:00:00/21:05:00}" >>"$STATUS"         # same landing, new timestamp
printf '%s\n' "AUTO-VERDICT REQUEST: LANE LANDED (auto-watch): $LINE" >>"$STATUS.pending"   # prefixed leftover
sleep 12
n=$(posts_matching "LANE LANDED")
check "exactly-one-user-message(got $n)" '[ "$n" = 1 ]'
check "one-marker-per-post" '[ "$(python3 -c "import json;print(sum(1 for l in open(\"$POSTS\") if json.loads(l)[\"text\"].count(\"AUTO-VERDICT REQUEST:\")!=1))")" = 0 ]'
check "registry-has-key-once" '[ "$(grep -c "" "$STATUS.delivered")" = 1 ]'
check "pending-empty" '[ ! -s "$STATUS.pending" ]'
SIG_SUMMARY="timeout then recover: $n post(s)"
case_end
