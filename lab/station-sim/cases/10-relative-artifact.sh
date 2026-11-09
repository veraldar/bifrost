#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 10: relative -a dispatched from a subdir -> the will stores an ABSOLUTE path; the watcher
# (cwd=$HOME) finds the artifact when it lands: no false over-budget ping.
case_init 10 "relative -a path from a subdir"
mkdir -p "$CD/work/sub"; DISPATCH_CWD="$CD/work/sub"; export FAKE_LANE=lane10 FAKE_ARTIFACT="$CD/work/sub/art/r10.md"
mkdir -p "$CD/work/sub/art"; echo sleep >"$CD/mode.claude"
(cd "$HOME" && watcher_start)
dispatch lane10 art/r10.md 1
wait_for 10 '[ -n "$(will_file)" ]'
check "will-stores-absolute-path" 'grep -q "^artifact=/" "$WILLS/lane10.will"'
sed -i "s/^dispatched=.*/dispatched=$(date -Iseconds -d '-2 hours')/" "$WILLS/lane10.will"   # over budget: only a MISSED artifact would ping
printf done >"$FAKE_ARTIFACT"; printf 'lane10 DONE %s — landed\n' "$(date -Iseconds)" >>"$STATUS"; mark
assert_invariant
check "no-false-ping($(posts_matching "STATION PING"))" '[ "$(posts_matching "STATION PING")" -eq 0 ]'
SIG_SUMMARY="abs will path; landing found from $HOME; 0 false pings"
case_end
