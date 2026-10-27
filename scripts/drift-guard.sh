#!/usr/bin/env bash
# drift-guard.sh — CROSS-LINE PARITY (fleet rule 10-27, docs/lab-playbook.md)
#
# The 10-27 lesson: the 10-02 hands-free mic guards and the 'dialects' theme
# retune existed on main/live (v0.6.x) but NEVER shipped on lab/sandbox (v0.7)
# — the branch forked from ab00e73 (10-01) before they were committed, and no
# tool ever compared product lines. The user experienced it as "fixed, came
# back". This guard inventories known class-fixes across product worktrees.
#
#   usage: scripts/drift-guard.sh [worktree ...]
#          (default: ~/Work/bifrost ~/Work/bifrost-sandbox — register a new
#           product line here the day it forks)
#
# A probe is a greppable symbol in a file. A line missing a probe is either a
# NEW drift (port the fix, per law 1) or a KNOWN-GAP (named below, until ported).
# exit 0 = no unexpected drift · exit 1 = unexpected drift or broken manifest.
set -u

# name|file|extended-regex|known-missing (comma-separated root basenames, '-')
# A known-missing entry is a NAMED, REVIEWED divergence (comment says why) —
# never silence. Review these rows at every fleet pass: a gap stays named only
# until someone ports it.
FIXES='
# first-turn-tap: the sandbox keeps first-turn logic in the session page
# (first === practice/sent/mic); main puts the door on the front page
# (tree-door) and every session opens keyboard (10-02 fix #3). Same user
# behavior, different structure — reviewed 10-27, HF-CLICK report §6.
first-turn-tap|pwa/app/session/[slug]/page.tsx|first-turn: tap — released, nothing sent|bifrost
ghost-click-guard|pwa/app/session/[slug]/page.tsx|freeGhostGuardRef|-
tap-arm-reinterpret|pwa/app/session/[slug]/page.tsx|pttDownAtRef|-
# theme-dialects: ported to lab/sandbox 10-27 (be67d66, THEME-PORT report).
# Probe is a value (the aether dialect ground), not the header comment.
theme-dialects|pwa/styles/tokens.css|oz-bg: #07080e|-
# the 10-06 voice-outage fixes (79d53f1/c6a1b2d/232b25c) on the live agent never reached the
# v0.7 agent (lane2/merge) — found 10-27 by RULER-V07, ported onto release/v0.7 by 3-way merge.
# DRAINED 10-27 (DRAIN-DRIFT): lab/sandbox now carries all four (139109f, verbatim from release/v0.7 ca990ca).
# KNOWN-GAP lane2-merge only: its agent/ tree is not what ships (rc1 = release/v0.7);
# lane2-merge/agent still SERVES the next slot (lk-agent-ygg) until the next slot runs a release.
agent-load-inf|agent/agent.py|load_threshold=float\("inf"\)|lane2-merge
agent-ordered-yield|agent/agent.py|yielding \(ordered|lane2-merge
agent-split-brain|agent/agent.py|BRAIN MISMATCH|lane2-merge
agent-loopback-http|agent/agent.py|AGENT_HTTP_HOST|lane2-merge
# pwa fixes on trunk after the fork (ab00e73), found 10-27 by RULER-V07 diffing live v0.6.1 vs rc1.
# PORTED onto release/v0.7 (rc2): the TTS generation lock (6405ead, the stutter fix) + the 300 s
# headersTimeout (40c6037, runs > 5 min died mid-flight). PORTED to lab/sandbox 10-27
# (b2000b0). agent-rearm / artifact-black-page / bifrost-auth-declared are PORTED to lab/sandbox 10-27
# (3b6e932, 676e42e, e156a71) and stay a NAMED gap on release/v0.7 only (frozen line; the user decides its fate):
#   agent-rearm (49a61e6: re-dispatch the agent into an agent-less ready room — client + a route
#   the fork never had), artifact-black-page (547cb89: md opened directly gets the black page),
#   bifrost-auth-declared (7572aaa: BIFROST_AUTH replaces the IS_VERCEL_PREVIEW guard; tailnet-only
#   box, no exposure change). artifact-meta (56730fa) + device pairing (9c0425e) are features, not fixes.
tts-generation-lock|pwa/app/api/tts/stream/route.ts|withTtsGenerationLock|-
oc-headers-timeout|pwa/lib/oc.ts|headersTimeout|-
agent-rearm|pwa/app/session/[slug]/page.tsx|api/dispatch|release-v07
artifact-black-page|pwa/app/api/artifact/[name]/route.ts|sec-fetch-dest|release-v07
bifrost-auth-declared|pwa/app/api/token/route.ts|BIFROST_AUTH|release-v07
'

ROOTS=("$@")
[ ${#ROOTS[@]} -eq 0 ] && ROOTS=("$HOME/Work/bifrost" "$HOME/Work/bifrost-sandbox")
# the release line (rc1 is frozen from it) is a product line the day it exists
[ $# -eq 0 ] && [ -d "$HOME/Work/release-v07" ] && ROOTS+=("$HOME/Work/release-v07")

bad=0
printf '%-22s %-24s %-22s %s\n' "FIX" "WORKTREE" "BRANCH" "STATE"
printf -- '--------------------------------------------------------------------------------\n'
while IFS='|' read -r name file regex known; do
  [ -z "${name:-}" ] && continue
  case "$name" in \#*) continue ;; esac
  for root in "${ROOTS[@]}"; do
    label="$(basename "$root")"
    branch="$(git -C "$root" branch --show-current 2>/dev/null || echo '?')"
    if [ ! -f "$root/$file" ]; then
      printf '%-22s %-24s %-22s %s\n' "$name" "$label" "$branch" "NO-FILE ($file)"
      bad=$((bad + 1)); continue
    fi
    if grep -qE "$regex" "$root/$file" 2>/dev/null; then
      printf '%-22s %-24s %-22s %s\n' "$name" "$label" "$branch" "OK"
    elif [ ",${known%%,*}," != ",-," ] && printf '%s' "$known" | tr ',' '\n' | grep -qx "$label"; then
      printf '%-22s %-24s %-22s %s\n' "$name" "$label" "$branch" "KNOWN-GAP"
    else
      printf '%-22s %-24s %-22s %s\n' "$name" "$label" "$branch" "MISSING  <-- drift"
      bad=$((bad + 1))
    fi
  done
done <<<"$FIXES"

echo
if [ "$bad" -eq 0 ]; then
  echo "drift-guard: clean (any KNOWN-GAP above is a named, pending port)"
  exit 0
fi
echo "drift-guard: $bad unexpected drift — port the fix (law 1) or name the gap in the manifest"
exit 1
