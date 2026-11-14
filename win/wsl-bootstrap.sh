#!/usr/bin/env bash
# wsl-bootstrap.sh — what launcher.bat runs inside WSL2: get the code, then join this PC to the tree.
#
#   wsl-bootstrap.sh --hub URL [--branch main] [--repo URL] [--qr-win 'C:\Users\me\Desktop\Veraldar-Join-QR.png']
#                    [--checkout DIR] [--rejoin] [-- more join.sh options]
#
# 1. checks what join.sh needs: git, python3, CA certificates — and, while no brain binary exists yet,
#    curl + a C toolchain + Rust to build one. Offers to install what is missing (sudo apt-get, rustup),
#    or prints the exact commands and stops.
# 2. clones the repo (sparse: root/ + trunk/scripts) into ~/veraldar/yggdrasil, or updates it (fast-forward
#    to the branch; local changes are left alone).
# 3. runs root/install/join.sh --hub URL, with the QR picture on the Windows Desktop (wslpath) and opened.
# Log: ~/.local/state/veraldar/bootstrap.log
set -euo pipefail

HUB='' BRANCH=${VERALDAR_BRANCH:-main} REPO_URL=${VERALDAR_REPO:-https://github.com/veraldar/yggdrasil.git}
QR_WIN='' CHECKOUT=${VERALDAR_CHECKOUT:-$HOME/veraldar/yggdrasil} REJOIN=''
while [ $# -gt 0 ]; do
  case $1 in
    --hub) HUB=${2:?}; shift ;;
    --branch) BRANCH=${2:?}; shift ;;
    --repo) REPO_URL=${2:?}; shift ;;
    --qr-win) QR_WIN=${2:?}; shift ;;
    --checkout) CHECKOUT=${2:?}; shift ;;
    --rejoin) REJOIN=--rejoin ;;
    --) shift; break ;;
    *) echo "wsl-bootstrap: unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

LOG_DIR=$HOME/.local/state/veraldar
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/bootstrap.log") 2>&1   # stdin stays the terminal: prompts still work
TEE=$!
echo "---- $(date '+%F %T') wsl-bootstrap: hub $HUB, $REPO_URL ($BRANCH)"
say()  { printf '[veraldar] %s\n' "$*"; }
die()  { printf '[veraldar] %s\n' "$*" >&2; exit "${2:-1}"; }
ask()  { [ -t 0 ] || return 1; local a; read -r -p "[veraldar] $1 [Y/n] " a; case $a in n*|N*) return 1 ;; esac; }
HUB=$(printf '%s' "$HUB" | tr -d '\r\n\t ')        # whatever Windows typed or stored around it
[ -n "$HUB" ] || die "no hub given (launcher.bat asks for it)" 64

# ---- 1. what join.sh needs
missing=()
command -v git >/dev/null || missing+=(git)
command -v python3 >/dev/null || missing+=(python3)
[ -s /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
# the root's WireGuard node (bifrost-net, the release binary) links libopus
# (no `| grep -q` under pipefail: grep quits at the first match and ldconfig dies of SIGPIPE)
case "$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null || true)" in *libopus.so.0*) ;; *) missing+=(libopus0) ;; esac
have_brain() {
  local a
  for a in "$@"; do [ "$a" = --brain-bin ] && return 0; done
  [ -n "${YGG_BINARY:-}" ] || [ -x "$HOME/.local/share/yggdrasil-root/bin/yggdrasil" ] \
    || [ -x "$CHECKOUT/root/target/release/yggdrasil" ] || [ -x "$HOME/.local/bin/yggdrasil" ] || command -v yggdrasil >/dev/null
}
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
NEED_RUST=0
if ! have_brain "$@"; then
  command -v cc >/dev/null || missing+=(build-essential)
  command -v pkg-config >/dev/null || missing+=(pkg-config)
  command -v curl >/dev/null || missing+=(curl)
  command -v cargo >/dev/null || NEED_RUST=1
fi
if [ ${#missing[@]} -gt 0 ]; then
  command -v apt-get >/dev/null || die "missing: ${missing[*]} — install them with your distribution's package manager, then run Veraldar again"
  cmd="sudo apt-get update && sudo apt-get install -y ${missing[*]}"
  say "this Linux needs: ${missing[*]}"
  if ask "Install them now? (sudo asks for your Linux password)"; then
    sudo apt-get update && sudo apt-get install -y "${missing[@]}"
  else
    die "run this in Ubuntu, then double-click Veraldar again:
      $cmd"
  fi
fi
if [ $NEED_RUST = 1 ]; then
  rustup_cmd="curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"
  say "the brain is built from source once; that needs Rust (user-level, no sudo, ~1 GB)"
  if ask "Install Rust with rustup now?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  else
    die "run this in Ubuntu, then double-click Veraldar again:
      $rustup_cmd"
  fi
fi

# ---- 2. the code
if [ ! -d "$CHECKOUT/.git" ]; then
  say "downloading $REPO_URL ($BRANCH) into $CHECKOUT"
  mkdir -p "$(dirname "$CHECKOUT")"
  git clone --quiet --depth 1 --branch "$BRANCH" --filter=blob:none --sparse "$REPO_URL" "$CHECKOUT" \
    || die "could not download $REPO_URL (branch $BRANCH) — check the internet connection and the BRANCH in launcher.bat"
  git -C "$CHECKOUT" sparse-checkout set root trunk/scripts
else
  say "updating $CHECKOUT ($BRANCH)"
  if git -C "$CHECKOUT" fetch --quiet --depth 1 origin "$BRANCH"; then
    if [ -z "$(git -C "$CHECKOUT" status --porcelain --untracked-files=no)" ]; then
      git -C "$CHECKOUT" checkout --quiet -B "$BRANCH" FETCH_HEAD
    else
      say "local changes in $CHECKOUT — not updating it"
    fi
  else
    say "could not reach $REPO_URL — using the copy already here"
  fi
fi
JOIN=$CHECKOUT/root/install/join.sh
[ -f "$JOIN" ] || die "branch $BRANCH of $REPO_URL has no root/install/join.sh — set BRANCH in launcher.bat to a branch that has it"

# ---- 3. join (the QR picture goes to the Windows Desktop and opens there)
QR_ARGS=()
if [ -n "$QR_WIN" ]; then
  QR_PNG=$(wslpath -u "$QR_WIN") || die "wslpath could not map $QR_WIN"
  mkdir -p "$(dirname "$QR_PNG")"
  QR_ARGS=(--qr-png "$QR_PNG" --open-qr)
fi
rc=0
bash "$JOIN" --hub "$HUB" ${QR_ARGS[@]+"${QR_ARGS[@]}"} ${REJOIN:+"$REJOIN"} "$@" || rc=$?
exec >&- 2>&-               # let tee finish writing before launcher.bat reads the exit code
wait "$TEE" 2>/dev/null || true
exit $rc
