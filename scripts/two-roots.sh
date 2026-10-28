#!/usr/bin/env bash
# two-roots — the TWO-ROOTS LAW (the user's order, 10-28): :443 (live, lk-pwa :8080) and :8443
# (the next slot, bifrost-sandbox :8090) ALWAYS serve DIFFERENT builds. The next slot is where the
# next evolution waits for the user's consent; the day it serves what live serves, there is nothing
# left to consent to. It collapsed once: v0.7.0-rc2 was the consent build on :8443 and promote.sh
# switched :443 to the same release (10-27) — both roots on build 2-tWDJZQP2Pr6PIGTVDsF.
#
# The single check both doors call (next-slot.sh on, promote.sh before/after a switch):
#   two-roots.sh check                    0 = different · 1 = COLLAPSED · 2 = a slot does not answer
#   two-roots.sh guard live|next <release-id|label|BUILD_ID>
#                                         would that build in that slot collapse the two? 0 = no, 1 = yes
#   two-roots.sh same <a> <b>             are two releases/builds one evolution? 0 = yes, 1 = no
# "Same build" = the same BUILD_ID, or two releases built from the same source commit (a rebuild of
# the same code is not the next evolution). Env overrides (tests): BIFROST_HOME, TWO_ROOTS_LIVE_URL,
# TWO_ROOTS_NEXT_URL.
set -uo pipefail
BIF="${BIFROST_HOME:-$HOME/.local/share/bifrost}"; RELS="$BIF/releases"
LIVE_URL="${TWO_ROOTS_LIVE_URL:-http://127.0.0.1:8080}"
NEXT_URL="${TWO_ROOTS_NEXT_URL:-http://127.0.0.1:8090}"

served() { curl -s -m 5 "$1/api/build" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null; }
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2" 2>/dev/null; }
# BUILD_ID -> the source commit of the release that carries it ("" = not a release, e.g. a worktree build)
source_of() {
  local r
  for r in "$RELS"/*/RELEASE.json; do
    [[ -f "$r" && "$(field "$r" build_id)" == "$1" ]] && { field "$r" source; return; }
  done
}
# release id | label | BUILD_ID -> BUILD_ID
to_build() {
  local q="$1" r
  [[ -f "$RELS/$q/RELEASE.json" ]] && { field "$RELS/$q/RELEASE.json" build_id; return; }
  for r in "$RELS"/*/RELEASE.json; do
    [[ -f "$r" && "$(field "$r" label)" == "$q" ]] && { field "$r" build_id; return; }
  done
  echo "$q"
}
same() {  # build_a build_b -> 0 if one evolution
  [[ -n "$1" && "$1" == "$2" ]] && return 0
  local sa sb; sa="$(source_of "$1")"; sb="$(source_of "$2")"
  [[ -n "$sa" && "$sa" == "$sb" ]]
}

case "${1:-check}" in
  check)
    lb="$(served "$LIVE_URL")"; nb="$(served "$NEXT_URL")"
    if [[ -z "$lb" || -z "$nb" ]]; then
      echo "TWO-ROOTS UNKNOWN: live ${lb:-no answer} · next ${nb:-no answer}"; exit 2
    fi
    if same "$lb" "$nb"; then
      echo "TWO-ROOTS COLLAPSED: :443 and :8443 serve one build ($lb${nb:+ / $nb}, source $(source_of "$lb")) — move the next slot: scripts/next-slot.sh on <next release> | off"
      exit 1
    fi
    echo "TWO-ROOTS OK: live $lb · next $nb"; exit 0 ;;
  guard)
    slot="${2:?live|next}"; want="$(to_build "${3:?release|label|BUILD_ID}")"
    case "$slot" in
      live) other="$(served "$NEXT_URL")"; oname=":8443 (next)" ;;
      next) other="$(served "$LIVE_URL")"; oname=":443 (live)" ;;
      *) echo "usage: two-roots.sh guard live|next <release>" >&2; exit 2 ;;
    esac
    if [[ -n "$other" ]] && same "$want" "$other"; then
      echo "TWO-ROOTS: $want in the $slot slot = what $oname serves ($other) — the two roots would collapse"
      exit 1
    fi
    exit 0 ;;
  same) same "$(to_build "${2:?a}")" "$(to_build "${3:?b}")" ;;
  *) echo "usage: two-roots.sh check | guard live|next <release> | same <a> <b>" >&2; exit 2 ;;
esac
