#!/usr/bin/env bash
# root-store-backup — snapshot the yggdrasil root's store (~/.local/share/yggdrasil) and PROVE
# the snapshot restores: unpack it into a scratch dir, boot the frozen root binary on it
# (loopback scratch port, a dead upstream — no model call), compare the session count.
# STABLE v0.7 row: "one supervised, backed-up store". T13 of docs/reviews/v07-reflection-and-plan.md.
#
#   scripts/root-store-backup.sh            backup + restore proof (exit 0 = restorable)
#   scripts/root-store-backup.sh --list     the snapshots on disk
#
# Restore for real (the store is the user's MAIN): stop lk-yggdrasil, move the store aside,
# `tar -xzf <snapshot> -C ~/.local/share`, start lk-yggdrasil. Never while a run is in flight.
set -euo pipefail
STORE="${YGG_STORE:-$HOME/.local/share/yggdrasil}"
DEST="$HOME/.local/state/bifrost-backup/root-store"
BIN="$(systemctl --user show lk-yggdrasil -p ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
PORT=14196
mkdir -p "$DEST"
[[ "${1:-}" == "--list" ]] && { ls -lh "$DEST"; exit 0; }
[[ -x "$BIN" ]] || { echo "[backup] FAIL: root binary '$BIN' not executable"; exit 1; }

snap="$DEST/yggdrasil-$(date +%Y%m%dT%H%M%S).tgz"
# a consistent-enough copy: the store is one json file per session, written whole
tar -czf "$snap" --exclude='trash-*' -C "$(dirname "$STORE")" "$(basename "$STORE")"
want=$(find "$STORE/session" -maxdepth 1 -name '*.json' | wc -l)
echo "[backup] $snap ($(du -h "$snap" | cut -f1), $want session files)"

tmp=$(mktemp -d); trap 'kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT
tar -xzf "$snap" -C "$tmp"
YGG_DATA_DIR="$tmp/$(basename "$STORE")" YGG_LISTEN=127.0.0.1:$PORT YGG_PROJECT_DIR="$tmp" \
  YGG_UPSTREAM_BASE_URL=http://127.0.0.1:9/v1 YGG_UPSTREAM_MODEL=none "$BIN" >"$tmp/boot.log" 2>&1 & pid=$!
for _ in $(seq 50); do curl -sf -m 1 http://127.0.0.1:$PORT/session >/dev/null && break; sleep 0.1; done
got=$(curl -sf -m 5 http://127.0.0.1:$PORT/session | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
if [[ "$got" == "$want" ]]; then
  echo "[backup] RESTORE PROVEN: the frozen root booted on the copy and lists $got/$want sessions"
else
  echo "[backup] FAIL: restored copy lists ${got:-nothing} sessions, want $want"; cat "$tmp/boot.log"; exit 1
fi
