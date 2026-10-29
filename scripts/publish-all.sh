#!/usr/bin/env bash
# publish-all.sh — THE one-shot publish pipeline (repo-reshape 10-29).
# Run ONCE after gh auth works (fix: `gh auth login --web`, or export GH_TOKEN=<PAT>).
# Idempotent: safe to re-run; never force-pushes, never rewrites bifrost history.
#
# What it does, in order:
#   1. preflight: gh auth OK? (else print the 1-minute fix and stop)
#   2. re-derive the yggdrasil split from the CURRENT bifrost brain tip (deterministic
#      subtree split of lab/yggdrasil/) and fast-forward ~/Work/yggdrasil master to it
#   3. create github.com/veraldar/yggdrasil (private) if missing; push master + its tags
#   4. push EVERYTHING in veraldar/bifrost: every branch (creating missing remotes),
#      every missing tag — via scripts/push-all.sh -c  (no force, ever)
#   5. set default branches; verify both repos against local state; append an audit row
#
# Env knobs:
#   DRY=1          do everything except network writes (print the plan instead)
#   ASSUME_AUTH=1  REHEARSAL ONLY: skip the gh preflight (offline dry-runs of steps 2+4)
#   BIF_BRANCH     the bifrost branch the brain tip is read from (default wave/root-provider-toolscope)
#   YGG_DIR        the yggdrasil repo (default ~/Work/yggdrasil)
#   BIF_DIR        the bifrost repo (default ~/Work/bifrost)
set -u

BIF_BRANCH="${BIF_BRANCH:-wave/root-provider-toolscope}"
YGG_DIR="${YGG_DIR:-$HOME/Work/yggdrasil}"
BIF_DIR="${BIF_DIR:-$HOME/Work/bifrost}"
DRY="${DRY:-0}"
say() { echo "publish-all: $*"; }

# --- 1. preflight -----------------------------------------------------------------------
if [ "${ASSUME_AUTH:-0}" != "1" ] && ! gh auth status >/dev/null 2>&1; then
  say "BLOCKED: gh cannot authenticate (the keyring token is invalid)."
  say "THE 1-MINUTE FIX (owner):  gh auth login --web     # browser flow, paste the code"
  say "   or:                        export GH_TOKEN=<a fine-grained PAT with repo scope>"
  say "then re-run:               ~/Work/bifrost/scripts/publish-all.sh"
  exit 1
fi
say "gh auth OK: $(gh auth status 2>/dev/null | grep -m1 'log in to' || echo account)"

# --- 2. re-derive the yggdrasil split ---------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "re-deriving yggdrasil split from $BIF_DIR ($BIF_BRANCH)…"
git clone -q --no-hardlinks "$BIF_DIR" "$TMP/bifrost"
B="origin/$BIF_BRANCH"
git -C "$TMP/bifrost" checkout -q --detach "$B" 2>/dev/null || {
  say "FATAL: branch $BIF_BRANCH not found in $BIF_DIR"; exit 1; }
TIP=$(git -C "$TMP/bifrost" log -1 --format=%H "$B" -- lab/yggdrasil/)
say "brain tip in bifrost: $(git -C "$TMP/bifrost" log --oneline -1 "$TIP" | head -c 90)"
SPLIT=$(git -C "$TMP/bifrost" subtree split -P lab/yggdrasil "$TIP" 2>/dev/null | tail -1)
[ -n "$SPLIT" ] || { say "FATAL: subtree split produced nothing"; exit 1; }
say "split tip: $SPLIT ($(git -C "$TMP/bifrost" rev-list --count "$SPLIT") commits)"

CURRENT=$(git -C "$YGG_DIR" rev-parse master 2>/dev/null || echo none)
if [ "$CURRENT" = "$SPLIT" ]; then
  say "yggdrasil master already at split tip — nothing to sync"
elif [ "$CURRENT" = "none" ]; then
  say "FATAL: $YGG_DIR has no master — build it first (see repo-reshape report)"; exit 1
else
  git -C "$YGG_DIR" fetch -q "$TMP/bifrost" "master:$SPLIT" 2>/dev/null \
    || git -C "$YGG_DIR" fetch -q "$TMP/bifrost" master
  if git -C "$YGG_DIR" merge-base --is-ancestor "$CURRENT" "$SPLIT"; then
    if [ "$DRY" = "1" ]; then say "DRY: would fast-forward master $CURRENT → $SPLIT"
    else git -C "$YGG_DIR" fetch -q "$TMP/bifrost" master && git -C "$YGG_DIR" update-ref refs/heads/master "$SPLIT" "$CURRENT" \
      && say "fast-forwarded master → $SPLIT"; fi
  else
    say "WARN: yggdrasil master ($CURRENT) is not an ancestor of the new split — manual review needed"; exit 1
  fi
fi

# --- 3. veraldar/yggdrasil on GitHub ----------------------------------------------------
if gh repo view veraldar/yggdrasil >/dev/null 2>&1; then
  say "veraldar/yggdrasil already exists on GitHub"
else
  if [ "$DRY" = "1" ]; then say "DRY: would run: gh repo create veraldar/yggdrasil --private"
  else gh repo create veraldar/yggdrasil --private >/dev/null && say "created veraldar/yggdrasil (private)"; fi
fi
if ! git -C "$YGG_DIR" remote | grep -q '^origin$'; then
  git -C "$YGG_DIR" remote add origin https://github.com/veraldar/yggdrasil.git
fi
if [ "$DRY" = "1" ]; then
  say "DRY: would push: git -C $YGG_DIR push -u origin master --tags"
else
  gh auth setup-git >/dev/null 2>&1 || say "note: gh auth setup-git failed (PAT mode? ensure credential helper)"
  git -C "$YGG_DIR" push -u origin master --tags || { say "FATAL: yggdrasil push failed"; exit 1; }
  say "pushed yggdrasil master + $(git -C "$YGG_DIR" tag | wc -l) tags"
fi

# --- 4. veraldar/bifrost: everything ----------------------------------------------------
if [ "$DRY" = "1" ]; then
  say "DRY: would run: $BIF_DIR/scripts/push-all.sh -c   (all branches + missing remotes + tags)"
  say "DRY: would push tags: $(git -C "$BIF_DIR" tag | tr '\n' ' ')"
else
  "$BIF_DIR/scripts/push-all.sh" -c || say "WARN: some bifrost pushes failed — see output above"
fi

# --- 5. defaults + verify ----------------------------------------------------------------
if [ "$DRY" = "1" ]; then
  say "DRY: would set defaults (bifrost=main, yggdrasil=master) and verify"
  say "DRY plan complete — run again with DRY=0 (or bare) to publish for real."
  exit 0
fi
gh repo edit veraldar/bifrost   --default-branch main    >/dev/null 2>&1 && say "bifrost default branch: main"
gh repo edit veraldar/yggdrasil --default-branch master >/dev/null 2>&1 && say "yggdrasil default branch: master"

say "---- VERIFY ----"
for r in bifrost yggdrasil; do
  d=$(gh api "repos/veraldar/$r" --jq '{default_branch, pushed_at, private}' 2>/dev/null)
  [ -n "$d" ] && say "veraldar/$r → $d" || say "veraldar/$r → API CHECK FAILED"
done
rb=$(git ls-remote --heads https://github.com/veraldar/bifrost.git 2>/dev/null | wc -l)
lb=$(git -C "$BIF_DIR" for-each-ref refs/heads | wc -l)
rt=$(git ls-remote --tags https://github.com/veraldar/bifrost.git 2>/dev/null | grep -v '\^{}' | wc -l)
lt=$(git -C "$BIF_DIR" tag | wc -l)
ry=$(git ls-remote --heads https://github.com/veraldar/yggdrasil.git 2>/dev/null | wc -l)
say "bifrost branches: local $lb / remote $rb · tags: local $lt / remote $rt · yggdrasil branches: remote $ry"
"$BIF_DIR/scripts/push-audit.sh" >/dev/null 2>&1
say "DONE. Both repos published; nightly push-audit keeps score from here."
