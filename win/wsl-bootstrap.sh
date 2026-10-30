#!/usr/bin/env bash
# wsl-bootstrap.sh — the INNER LOGIC of win/launcher.bat, as a plain bash script.
#
# The .bat's contract (see launcher.bat, proven on Linux — win-qr-sim2):
#   1. --ports BASE   stage the stack on BASE..BASE+4 (app/root/mock/trunk+media)
#   2. --qr-dir DIR   write the pair-QR png into DIR — on Windows that is the
#                     user's Desktop, mounted via /mnt/c/Users/<u>/Desktop
#   3. write join-url.txt next to this script — the exact URL the QR encodes —
#      so the .bat can `start` it in the default browser after we exit 0.
# Everything heavy is delegated to the ONE existing layman bootstrap:
#   lab/layman-deploy/impl/layman-bootstrap.sh --stage --ports --qr-dir
set -euo pipefail

say()  { echo "[veraldar] $*"; }
fail() { echo "[veraldar] FAIL: $*" >&2; exit 1; }

# locate this script (before cd) — join-url.txt + bootstrap.log land next to it
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SELF_DIR/bootstrap.log"
JOIN_FILE="$SELF_DIR/join-url.txt"

# defaults: dev-checkout twin of the installed layout
QR_DIR="/tmp/win-qr-sim2/desktop"
PORT_BASE="${VERALDAR_PORT_BASE:-8195}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --qr-dir) QR_DIR="${2:?}"; shift ;;
    --ports)  PORT_BASE="${2:?}"; shift ;;
    *) fail "unknown arg: $1" ;;
  esac
  shift
done

exec > >(tee -a "$LOG_FILE") 2>&1   # every line lands in bootstrap.log — the .bat points the user at it on failure

say "ports $PORT_BASE..$((PORT_BASE+4)) · qr-dir $QR_DIR · log $LOG_FILE"
mkdir -p "$QR_DIR"

# payload source (repo with the prebuilt stack + lab/layman-deploy/impl):
#   VERALDAR_REPO_ROOT set -> use that tree, STAGE mode (dev twin / this sim: fast)
#   else (installed .bat)  -> clone the repo shallow into ~/bifrost (WSL home),
#                             FRESH mode — the real layman first-run path.
MODE_ARGS=(--stage)
if [[ -n "${VERALDAR_REPO_ROOT:-}" ]]; then
  ROOT="$VERALDAR_REPO_ROOT"
else
  ROOT="${BIFROST_DIR:-$HOME/bifrost}"
  if [[ ! -d "$ROOT/.git" ]]; then
    say "no checkout at $ROOT — cloning (first run: adds ~5-10 min for the build)"
    git clone --depth 1 https://github.com/veraldar/bifrost.git "$ROOT" \
      || fail "clone failed (git missing? run: sudo apt install -y git curl)"
  fi
  MODE_ARGS=(--fresh-install)
fi
cd "$ROOT"
[[ -f lab/layman-deploy/impl/layman-bootstrap.sh ]] || fail "layman bootstrap missing under $ROOT"

# ---- the ONE delegated call: stage up + pair minted + QR png into $QR_DIR ----
bash lab/layman-deploy/impl/layman-bootstrap.sh "${MODE_ARGS[@]}" --ports "$PORT_BASE" --qr-dir "$QR_DIR"

# ---- the contract's deliverable: join-url.txt = the QR payload, byte-exact ----
QR_TXT="$QR_DIR/pair-qr.txt"
[[ -f "$QR_TXT" ]] || fail "bootstrap wrote no QR payload at $QR_TXT"
printf '%s' "$(cat "$QR_TXT")" > "$JOIN_FILE"
say "join URL -> $JOIN_FILE : $(cat "$JOIN_FILE")"
say "QR png   -> $QR_DIR/pair-qr.png"
exit 0
