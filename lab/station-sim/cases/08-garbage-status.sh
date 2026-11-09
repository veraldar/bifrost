#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 8: garbage / truncated status lines -> watcher survives, no wake on garbage; a valid line after
# them still produces exactly one signal.
case_init 08 "garbage/truncated status line"
watcher_start; sleep 1
printf '\000\001\002garbage\n' >>"$STATUS"; sleep $((POLL * 2 + 1))
printf '   \n' >>"$STATUS"; sleep $((POLL * 2 + 1))
printf 'lane-will FAILED-STU' >>"$STATUS"; sleep $((POLL * 2 + 1))     # truncated, no newline
check "watcher-alive" 'kill -0 "$WATCH_PID"'
check "no-wake-on-garbage(posts=$(grep -c "" "$POSTS"))" '[ "$(grep -c "" "$POSTS")" -eq 0 ]'
printf '\nlane8 DONE %s — real landing\n' "$(date -Iseconds)" >>"$STATUS"; mark
assert_invariant
check "watcher-still-alive" 'kill -0 "$WATCH_PID"'
SIG_SUMMARY="0 posts on garbage, 1 on the valid line"
case_end
