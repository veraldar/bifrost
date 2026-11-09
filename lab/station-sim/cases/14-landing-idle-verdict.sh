#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 14: landing while MAIN is idle -> the post carries the AUTO-VERDICT marker; the mock brain
# logs exactly ONE owner-verdict event, within 2 polls of the landing.
case_init 14 "landing, MAIN idle -> one marked verdict request"
export FAKE_ARTIFACT="$CD/art/c14.md" FAKE_LANE=lane14
watcher_start; dispatch lane14 "$FAKE_ARTIFACT" 30
wait_for 30 '[ -f "$FAKE_ARTIFACT" ]'; mark
assert_invariant
V="$CD/brain/verdicts.log"
check "one-owner-verdict-event(got $(grep -c '' "$V" 2>/dev/null))" '[ "$(grep -c "" "$V" 2>/dev/null)" = 1 ]'
check "post-carries-marker" '[ "$(posts_matching "^AUTO-VERDICT REQUEST: LANE LANDED" 2xx)" = 1 ]'
SIG_SUMMARY="1 marked landing, 1 verdict event, lat ${SIG_LAT}s"
case_end
