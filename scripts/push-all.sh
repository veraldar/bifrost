#!/usr/bin/env bash
# push-all.sh — push every branch that has (or should have) a remote counterpart + report stragglers.
# Part of the repo-reshape pipeline (10-29). Safe to run any time; never force-pushes;
# never creates branches that exist only as worktrees-with-no-upstream unless -c is given.
#
# Usage:
#   push-all.sh            # bifrost repo: push every branch with an upstream + report stragglers
#   push-all.sh -c         # ALSO create missing remotes (origin/<branch>) for local-only branches
#   push-all.sh -c -r <url># create remotes on a different remote (default origin)
#   push-all.sh --all-repos# bifrost AND ~/Work/yggdrasil (and any repo listed in scripts/push-repos.txt)
#
# What counts as a straggler: a local branch with NO upstream (never pushed or forgotten)
# or whose upstream is behind (a[head N] state). The report is the deliverable; the push is the cure.
set -u

CREATE=0
REMOTE=origin
ALL_REPOS=0
while getopts "cr:h" opt; do
  case "$opt" in
    c) CREATE=1 ;;
    r) REMOTE="$OPTARG" ;;
    h) sed -n '2,12p' "$0"; exit 0 ;;
    *) sed -n '2,12p' "$0"; exit 2 ;;
  esac
done

if [ "${ALL_REPOS:-0}" = "1" ] || [ "${1:-}" = "--all-repos" ]; then
  DIRS="$PWD $(cat "$(dirname "$0")/push-repos.txt" 2>/dev/null || true)"
else
  DIRS="$PWD"
fi

RC=0
for DIR in $DIRS; do
  [ -d "$DIR/.git" ] || continue
  echo "=== repo: $DIR ==="
  (cd "$DIR" || continue
   git remote | grep -q . || { echo "  (no remote configured — local-only repo, listed as straggler)"; exit 0; }
   git fetch --prune "$REMOTE" 2>&1 | sed 's/^/  /'
   pushed=0; failed=0
   # 1) branches WITH an upstream: push if ahead
   while read -r b; do
     ahead=$(git rev-list --count "@{upstream}..$b" 2>/dev/null || echo "?")
     if [ "$ahead" = "?" ]; then continue; fi
     if [ "$ahead" -gt 0 ]; then
       if git push "$REMOTE" "$b" 2>&1 | sed 's/^/  /'; then
         echo "  pushed: $b (+$ahead)"
         pushed=$((pushed+1))
       else
         echo "  PUSH FAILED: $b" >&2
         failed=$((failed+1)); RC=1
       fi
     fi
   done < <(git for-each-ref --format='%(refname:short)' refs/heads)
   # 2) stragglers: no upstream
   stragglers=""
   while read -r b; do
     if ! git config "branch.$b.remote" >/dev/null 2>&1; then
       # skip the detached/scratch noise: a worktree checkout with no commits of its own is still a straggler (reported)
       stragglers="$stragglers $b"
       if [ "$CREATE" = "1" ]; then
         if git push -u "$REMOTE" "$b" 2>&1 | sed 's/^/  /'; then
           echo "  created remote: $REMOTE/$b"
           pushed=$((pushed+1))
         else
           echo "  CREATE FAILED: $b" >&2
           failed=$((failed+1)); RC=1
         fi
       fi
     fi
   done < <(git for-each-ref --format='%(refname:short)' refs/heads)
   # 3) tags: push any tag the remote lacks (never deletes, never forces)
   while read -r t; do
     if ! git ls-remote --tags "$REMOTE" "refs/tags/$t" | grep -q .; then
       git push "$REMOTE" "refs/tags/$t" >/dev/null 2>&1 \
         && { echo "  pushed tag: $t"; pushed=$((pushed+1)); } \
         || { echo "  TAG PUSH FAILED: $t" >&2; failed=$((failed+1)); RC=1; }
     fi
   done < <(git tag --list)
   echo "  summary: $pushed pushed, $failed failed"
   if [ -n "$stragglers" ]; then echo "  stragglers (no upstream): $(echo $stragglers | sed 's/^ *//; s/ /, /g')"; else echo "  stragglers: none"; fi
  )
done
exit $RC
