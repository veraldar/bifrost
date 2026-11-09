#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 7: two "[MAIN]" sessions (+ a newer non-MAIN one) -> newest-updated [MAIN] is the one target.
case_init 07 "two [MAIN] sessions"
cat >"$CD/brain/sessions.json" <<'J'
[{"id":"ses_old","title":"[MAIN]","time":{"updated":5}},{"id":"ses_new","title":"[MAIN]","time":{"updated":9}},{"id":"ses_other","title":"scratch","time":{"updated":99}}]
J
export FAKE_ARTIFACT="$CD/art/c7.md" FAKE_LANE=lane7
watcher_start; dispatch lane7 "$FAKE_ARTIFACT"; mark
assert_invariant
check "all-posts-to-ses_new" '[ "$(grep -c "\"sid\": \"ses_new\"" "$POSTS")" -eq "$(grep -c "" "$POSTS")" ]'
SIG_SUMMARY="LANE LANDED -> ses_new only"
case_end
