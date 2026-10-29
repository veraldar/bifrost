#!/usr/bin/env bash
# push-audit.sh — one JSONL row per repo/worktree: unpushed-commit and unpushed-branch counts.
# Appends to ~/.local/share/bifrost/bench/push-audit.jsonl (the bench ledger dir, rule-eval's home).
# Works WITHOUT network: counts against the local remote-tracking refs (as of last fetch).
# Handles worktrees (bifrost-sandbox) as first-class: their own HEAD branch is what's audited.
# Run by push-audit.timer (nightly) or by hand any time. Exit 0 always — an audit must never fail a timer.
set -u
LEDGER_DIR="$HOME/.local/share/bifrost/bench"
LEDGER="$LEDGER_DIR/push-audit.jsonl"
mkdir -p "$LEDGER_DIR"

now=$(date -u +%FT%TZ)

# One row per path. Worktrees share the parent repo's refs — for them we audit the
# checked-out branch specifically (the meaningful per-worktree number).
repos=(
  "$HOME/Work/bifrost"
  "$HOME/Work/lab/yggdrasil"
  "$HOME/Work/bifrost-sandbox"
)

for repo in "${repos[@]}"; do
  name=$(basename "$repo")
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    printf '{"ts":"%s","repo":"%s","status":"missing","unpushed_commits":-1,"unpushed_branches":-1}\n' "$now" "$name" >>"$LEDGER"
    continue
  fi
  if [ -f "$repo/.git" ]; then
    # --- worktree: audit its HEAD branch against remotes ---
    branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
    tip=$(git -C "$repo" rev-parse HEAD)
    if git -C "$repo" branch -r --contains "$tip" 2>/dev/null | grep -q .; then
      uc=0
    else
      # commits on HEAD's branch not reachable from any remote ref
      uc=$(git -C "$repo" rev-list --count "$tip" --not --remotes 2>/dev/null || echo 0)
    fi
    printf '{"ts":"%s","repo":"%s","kind":"worktree","branch":"%s","status":"ok","unpushed_commits":%s,"unpushed_branches":%s}\n' \
      "$now" "$name" "$branch" "$uc" "$([ "$uc" -eq 0 ] && echo 0 || echo 1)" >>"$LEDGER"
    continue
  fi
  # --- standalone repo ---
  remotes_exist=$(git -C "$repo" for-each-ref --format='%(refname)' refs/remotes | head -1)
  if [ -z "$remotes_exist" ]; then
    total=$(git -C "$repo" rev-list --all --count)
    printf '{"ts":"%s","repo":"%s","kind":"repo","status":"no-remote","unpushed_commits":%s,"unpushed_branches":%s}\n' \
      "$now" "$name" "$total" "$(git -C "$repo" for-each-ref refs/heads | wc -l)" >>"$LEDGER"
    continue
  fi
  unpushed_commits=$(git -C "$repo" rev-list --count --all --not --remotes 2>/dev/null || echo 0)
  unpushed_branches=0
  while read -r b; do
    tip=$(git -C "$repo" rev-parse "$b" 2>/dev/null) || continue
    if ! git -C "$repo" branch -r --contains "$tip" 2>/dev/null | grep -q .; then
      unpushed_branches=$((unpushed_branches+1))
    fi
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads)
  printf '{"ts":"%s","repo":"%s","kind":"repo","status":"ok","unpushed_commits":%s,"unpushed_branches":%s}\n' \
    "$now" "$name" "$unpushed_commits" "$unpushed_branches" >>"$LEDGER"
done

tail -4 "$LEDGER"
