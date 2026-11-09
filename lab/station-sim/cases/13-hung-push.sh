#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 13: claude OK but the auto-push hangs (fake git) -> the 120 s push timeout must free the
# wrapper; the OK/stub/status path then completes. Slow case (~125 s).
case_init 13 "hung git push (120 s cap)"
R="$CD/work/repo"; mkdir -p "$R" "$CD/bin"; git -C "$R" init -q -b main; git -C "$R" -c user.email=s@s -c user.name=sim commit -q --allow-empty -m init; git -C "$R" remote add origin "$CD/nowhere.git"
REALGIT=$(command -v git)
printf '#!/usr/bin/env bash\n[ "$1" = -C ] && [ "$3" = push ] && exec sleep 1000\nexec %s "$@"\n' "$REALGIT" >"$CD/bin/git"; chmod +x "$CD/bin/git"
export PATH="$CD/bin:$PATH" AGI_AUTO_PUSH=1 FAKE_LANE=lane13 FAKE_ARTIFACT="$CD/art/c13.md"; DISPATCH_CWD="$R"
watcher_start; t0=$(date +%s); dispatch lane13 "$FAKE_ARTIFACT" 30; mark
wait_for 140 '! kill -0 "$DISP_PID" 2>/dev/null'; dt=$(( $(date +%s) - t0 ))
check "wrapper-exits-within-130s(dt=${dt}s)" '[ "$dt" -le 130 ] && [ "$dt" -ge 100 ]'
assert_invariant 160
check "artifact-present" '[ -f "$FAKE_ARTIFACT" ]'
SIG_SUMMARY="push capped at 120 s (dt=${dt}s) -> lane OK landing"
case_end
