#!/usr/bin/env bash
# backup.sh — incremental backup of this box to the Mac Studio over SSH.
#
# Coverage (req 10-02): opencode sessions/store, ~/Work/bifrost (gitignored
# secrets INCLUDED — .env files are the point), systemd user units, crontabs.
# Excludes rebuildable bulk only: node_modules, .next, .venv, edge/models.
#
# Layout on the Mac: ~/Backups/omarchy/<YYYY-MM-DD>/{store,state,config,work,work-root,systemd-user,meta}
# Incremental without --link-dest (Mac ships openrsync): each run hardlinks
# the previous snapshot (cp -Rl) then rsync --delete into the copy — unchanged
# files share inodes, changed files are replaced, deletions propagate.
# Idempotent: same-day re-runs update today's snapshot in place.
# Restore: see docs/backup.md.

set -euo pipefail

DEST_HOST="${BACKUP_DEST_HOST:-mac}"           # ssh alias, ~/.ssh/config
DEST_DIR="${BACKUP_DEST_DIR:-Backups/omarchy}" # relative to remote $HOME
KEEP="${BACKUP_KEEP:-14}"                      # snapshots to retain
STAGE="$(mktemp -d /tmp/backup-stage.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

log() { printf '[backup] %s\n' "$*"; }
fail() { printf '[backup] FAIL: %s\n' "$*" >&2; exit 1; }

# --- single-instance lock -----------------------------------------------------
exec 9>/run/user/$(id -u)/backup-mac.lock
flock -n 9 || fail "another backup is already running"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
rsh() { ssh "${SSH_OPTS[@]}" "$DEST_HOST" "$@"; }

rsh true || fail "cannot reach $DEST_HOST over ssh"
RHOME="$(rsh 'echo $HOME')"
RDEST="$RHOME/$DEST_DIR"
STAMP="$(date +%F)"
SNAP="$RDEST/$STAMP"
RSYNC=(rsync -rlptD --delete --exclude=.DS_Store)   # tree pushes (mirror source)
RSYNC_ADD=(rsync -rlptD --exclude=.DS_Store)        # additive pushes (db, meta)

# newest snapshot that is not today's → hardlink base (find: no shell globs)
PREV="$(rsh "find '$RDEST' -maxdepth 1 -mindepth 1 -type d ! -name '$STAMP' 2>/dev/null | sort | tail -1")"

log "destination: $DEST_HOST:$SNAP"
if [ -n "$PREV" ]; then log "incremental base: ${PREV##*/}"; else log "incremental base: none (full copy)"; fi

# --- consistent copy of the live opencode database ----------------------------
OC_DB="$HOME/.local/share/opencode/opencode.db"
if [ -f "$OC_DB" ]; then
  sqlite3 "$OC_DB" ".backup '$STAGE/opencode.db'" || fail "sqlite .backup failed"
  log "staged consistent opencode.db ($(du -h "$STAGE/opencode.db" | cut -f1))"
fi

# --- helpers -------------------------------------------------------------------
seed_from_prev() { # seed_from_prev <subdir>  — hardlink-clone yesterday's copy
  # Nest-safe: only seed when the dest subdir does NOT exist yet (same-day re-run
  # or earlier partial snapshot), and copy CONTENTS (trailing slashes) — a bare
  # `cp -Rl prev/sub snap/sub` onto an existing dir nests it as sub/sub.
  local sub="$1"
  [ -n "$PREV" ] || return 0
  rsh "if [ ! -d '$SNAP/$sub' ]; then mkdir -p '$SNAP/$sub' && cp -Rl '$PREV/$sub/' '$SNAP/$sub/'; fi" 2>/dev/null \
    || log "seed $sub: skipped (seed failed → full copy)"
}

# openrsync (macOS receiver) does not mkdir the dest root itself: it only
# creates dirs as a side effect of materializing directory entries from the
# file list — a dest holding just files (db/, meta/) fails with
# "open: No such file or directory" (rsync code 12). Pre-create every dest.
mkdest() { rsh "mkdir -p '$SNAP/$1'" || fail "cannot create $SNAP/$1 on $DEST_HOST"; }

push() { # push <local-src/> <remote-subdir> [excludes...]
  local src="$1" sub="$2"; shift 2
  local ex=() e
  for e in "$@"; do ex+=(--exclude="$e"); done
  seed_from_prev "$sub"
  mkdest "$sub"
  "${RSYNC[@]}" -e "ssh ${SSH_OPTS[*]}" "${ex[@]}" "$src" "$DEST_HOST:$SNAP/$sub/"
}

# --- the sets -------------------------------------------------------------------
# 1) opencode sessions/store: data dir mirrored (--delete) with the live db
#    trio excluded; the consistent staged copy lands separately in db/ —
#    OUTSIDE the mirrored tree (an in-tree db re-triggers --delete daily)
if [ -d "$HOME/.local/share/opencode" ]; then
  push "$HOME/.local/share/opencode/" "store" \
    opencode.db opencode.db-wal opencode.db-shm
  if [ -f "$STAGE/opencode.db" ]; then
    seed_from_prev "db"
    mkdest "db"
    mkdir -p "$STAGE/dbout" && mv "$STAGE/opencode.db" "$STAGE/dbout/"
    "${RSYNC_ADD[@]}" -e "ssh ${SSH_OPTS[*]}" "$STAGE/dbout/" "$DEST_HOST:$SNAP/db/"
  fi
fi
[ -d "$HOME/.local/state/opencode" ] && push "$HOME/.local/state/opencode/" "state"

# 2) opencode config (opencode.json, skills, tui.json; auth.json = tokens, wanted)
[ -d "$HOME/.config/opencode" ] && push "$HOME/.config/opencode/" "config"

# 3) ~/Work/bifrost — full tree INCLUDING gitignored secrets (.env*).
#    Only rebuildable bulk is excluded.
push "$HOME/Work/bifrost/" "work" \
  node_modules/ .next/ .venv/ __pycache__/ edge/models/ \
  test-results/ playwright-report/ .turbo/ *.pyc

# 4) systemd user units (lk-*, opencode-serve, voxtype, timers)
[ -d "$HOME/.config/systemd/user" ] && push "$HOME/.config/systemd/user/" "systemd-user" '.wants/'

# 5) ~/Work top-level loose files (AGENTS.md stub is NOT in git — docs/local.md)
mkdir -p "$STAGE/work-root"
find "$HOME/Work" -maxdepth 1 -type f \( -name '*.md' -o -name 'opencode.json' \) \
  -exec cp -p {} "$STAGE/work-root/" \; 2>/dev/null || true
[ -n "$(ls -A "$STAGE/work-root" 2>/dev/null)" ] && push "$STAGE/work-root/" "work-root"

# 6) meta: units/timers manifest + crontab dump
{
  echo "# backup manifest $(date -Is) host=$(hostname)"
  echo
  echo "## systemctl --user list-timers"
  systemctl --user list-timers --all --no-pager || true
  echo
  echo "## systemctl --user list-units (service,timer)"
  systemctl --user list-units --type=service,timer --all --no-pager || true
  echo
  echo "## crontab"
  if command -v crontab >/dev/null 2>&1 && crontab -l > "$STAGE/crontab.$$" 2>/dev/null; then
    cat "$STAGE/crontab.$$"; rm -f "$STAGE/crontab.$$"
  else
    echo "no user crontab (crontab not installed on this box; systemd timers are the scheduler)"
  fi
} > "$STAGE/manifest.txt"
mkdir -p "$STAGE/meta" && mv "$STAGE/manifest.txt" "$STAGE/meta/"
seed_from_prev "meta"
mkdest "meta"
"${RSYNC_ADD[@]}" -e "ssh ${SSH_OPTS[*]}" "$STAGE/meta/" "$DEST_HOST:$SNAP/meta/"

# --- prune old snapshots (BSD-safe) ---------------------------------------------
rsh "cd '$RDEST' 2>/dev/null && ls -1d */ 2>/dev/null | sort | awk 'NR>$KEEP' | sed 's:/$::' | while read -r d; do rm -rf \"\$d\"; done" || true

# --- verify + report --------------------------------------------------------------
rsh "test -d '$SNAP/store'"      || fail "verify: store/ missing on $DEST_HOST"
rsh "test -f '$SNAP/db/opencode.db'" || fail "verify: db/opencode.db missing"
rsh "test -d '$SNAP/work'"       || fail "verify: work/ missing on $DEST_HOST"
rsh "test -f '$SNAP/work/AGENTS.md'" || fail "verify: bifrost tree incomplete (AGENTS.md)"
rsh "test -f '$SNAP/meta/manifest.txt'" || fail "verify: meta/manifest.txt missing"
# nest detector: a snapshot set copied INTO itself (dest-path bug recurrence)
for sub in store state config work work-root systemd-user db meta; do
  rsh "test ! -e '$SNAP/$sub/$sub'" || fail "verify: NEST detected: $SNAP/$sub/$sub"
done
log "verified snapshot contents:"
rsh "ls -1 '$SNAP' | sed 's/^/  - /'"
log "snapshot size: $(rsh "du -sh '$SNAP' | cut -f1")   all snapshots: $(rsh "du -sh '$RDEST' | cut -f1")"
log "DONE"
