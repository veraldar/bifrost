#!/usr/bin/env bash
# wsl-bootstrap.sh — the INNER LOGIC of the Windows install, run inside WSL2.
#
# Driven by win/veraldar.ps1 (both entry paths: Veraldar-Setup.exe's desktop tile
# -> launcher.bat -> veraldar.ps1, and the one-paste line -> veraldar.ps1), as root
# inside the dedicated "Veraldar" distro (Ubuntu 24.04 rootfs, wsl --import'ed):
#
#   1. first run: apt-get update + the few packages a bare Ubuntu lacks (non-interactive,
#      waits out the first-boot apt lock — no Ubuntu-terminal prompts, ever)
#   2. node 24 (official tarball) + rust (rustup, minimal) under $VERALDAR_HOME — no
#      docker, nothing from PATH assumed
#   3. the source: blobless clone of github.com/veraldar/bifrost (once; --update refreshes)
#   4. build once per source rev: the app (npm ci + next build), the root and the trunk
#      (cargo build --release --locked of lab/yggdrasil and lab/bifrost-net)
#   5. stage: the bundled lab/layman-deploy/impl/layman-bootstrap.sh --stage against that
#      tree, PLAIN runner (no systemd needed): mock + root + app + trunk on BASE..BASE+4
#   6. QR png -> every --desktop folder (Windows paths are fine: OneDrive Desktop,
#      %USERPROFILE%\Desktop, spaces) as Veraldar-Pair-QR.png; join-url.txt,
#      join-url-local.txt, versions.txt, ready -> --out-dir (veraldar.ps1 polls `ready`)
#   7. --hold: stay up until the window closes / Ctrl+C, then stop the stage
#
# Usage: wsl-bootstrap.sh [--out-dir DIR] [--desktop DIR]… [--ports BASE] [--ip LAN_IP]
#                         [--ref REF] [--repo URL] [--update] [--hold] [--down]
#        (--qr-dir DIR / --print-qr-file PATH: the v0.1 launcher contract, still accepted)
# Dev twin (no WSL): VERALDAR_REPO_ROOT=<built checkout> skips clone + build.
# Exit 0 = stack up + QR delivered. Nonzero = the failing step is the last FAIL line.
set -euo pipefail

say()  { echo "[veraldar] $*"; }
fail() { echo "[veraldar] FAIL: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
step() { echo; echo "[veraldar] ==== $* ===="; }

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
VHOME="${VERALDAR_HOME:-$HOME/.veraldar}"
OUT_DIR=""
DESKTOPS=()
QR_EXACT=""          # --print-qr-file (v0.1 contract): one exact png path
PORT_BASE="${VERALDAR_PORT_BASE:-8195}"
ADV_IP=""
UPDATE=0; HOLD=0; DOWN=0
REPO_URL="${VERALDAR_REPO_URL:-https://github.com/veraldar/bifrost.git}"
REPO_REF="${VERALDAR_REF:-main}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="${2:?}"; shift ;;
    --desktop|--qr-dir) DESKTOPS+=("${2:?}"); shift ;;
    --print-qr-file) QR_EXACT="${2:?}"; shift ;;
    --ports) PORT_BASE="${2:?}"; shift ;;
    --ip) ADV_IP="${2:-}"; shift ;;
    --ref) REPO_REF="${2:?}"; shift ;;
    --repo) REPO_URL="${2:?}"; shift ;;
    --update) UPDATE=1 ;;
    --hold) HOLD=1 ;;
    --down) DOWN=1 ;;
    *) fail "unknown arg: $1" ;;
  esac
  shift
done

# Windows path (C:\Users\me\OneDrive - Org\Desktop, C:/x) -> the WSL automount path.
# wslpath when WSL provides it; the /mnt/<drive>/ rule otherwise (dev twin, containers).
to_linux() {
  local p="$1"
  if [[ "$p" =~ ^[A-Za-z]:[\\/] ]]; then
    if have wslpath; then wslpath -u "$p" && return; fi
    local d; d="$(printf '%s' "${p:0:1}" | tr 'A-Z' 'a-z')"
    p="${p:2}"; p="${p//\\//}"
    printf '/mnt/%s%s\n' "$d" "$p"
  else
    printf '%s\n' "$p"
  fi
}

[[ -n "$OUT_DIR" ]] || OUT_DIR="$SELF_DIR"
OUT_DIR="$(to_linux "$OUT_DIR")"
mkdir -p "$OUT_DIR" "$VHOME"
LOG_FILE="$OUT_DIR/bootstrap.log"
STAGE_DIR="$VHOME/stage"
QR_HOME="$VHOME/qr"

# the layman bootstrap: the copy shipped next to this script (installer / one-paste)
# wins over the clone's — the Windows path must not depend on what GitHub main carries.
LAYMAN_SRC="$SELF_DIR/layman-bootstrap.sh"
LAYMAN="$VHOME/layman-bootstrap.sh"
stage_down() {
  [[ -f "$LAYMAN" ]] || return 0
  LAYMAN_STAGE_DIR="$STAGE_DIR" LAYMAN_RUNNER="${LAYMAN_RUNNER:-plain}" bash "$LAYMAN" --down || true
}
if (( DOWN )); then stage_down; exit 0; fi

exec > >(tee -a "$LOG_FILE") 2>&1   # every line lands in bootstrap.log (veraldar.ps1 quotes it on failure)
rm -f "$OUT_DIR/ready"
say "$(date -u +%FT%TZ) · ports $PORT_BASE..$((PORT_BASE+4)) · home $VHOME · log $LOG_FILE"

# ---------- 1. system packages (first run; root in the Veraldar distro) ----------
SUDO=""
if (( EUID != 0 )); then have sudo && sudo -n true 2>/dev/null && SUDO="sudo -n"; fi
PKGS=(ca-certificates curl git python3 rsync openssl iproute2 xz-utils qrencode
      build-essential pkg-config cmake libopus-dev libssl-dev)
MISSING=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
if ((${#MISSING[@]})); then
  step "1/5 system packages (first run: ~2-4 min)"
  if (( EUID != 0 )) && [[ -z "$SUDO" ]]; then
    fail "missing packages: ${MISSING[*]} — run once: sudo apt-get update && sudo apt-get install -y ${MISSING[*]}"
  fi
  export DEBIAN_FRONTEND=noninteractive
  APT=(-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get "${APT[@]}" update -q \
    || fail "apt-get update failed — is the PC online? (WSL uses the Windows network)"
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get "${APT[@]}" install -y -q --no-install-recommends "${MISSING[@]}" \
    || fail "apt-get install failed: ${MISSING[*]}"
else
  say "1/5 system packages: present"
fi

# ---------- 2. node 24 + rust, user-level (no PATH / docker assumptions) ----------
case "$(uname -m)" in
  x86_64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;; *) fail "unsupported CPU: $(uname -m)" ;;
esac
NODE_DIR="$VHOME/node"
if [[ -n "${VERALDAR_REPO_ROOT:-}" ]] && have node; then :; elif [[ ! -x "$NODE_DIR/bin/node" ]]; then
  step "2/5 node 24 (official tarball)"
  SUMS="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)" || fail "cannot reach nodejs.org"
  LINE="$(printf '%s\n' "$SUMS" | grep " node-v24[0-9.]*-linux-$NARCH.tar.xz\$" | head -1)"
  [[ -n "$LINE" ]] || fail "no node 24 linux-$NARCH tarball listed on nodejs.org"
  NSHA="${LINE%% *}"; NFILE="${LINE##* }"
  curl -fsSL -o "$VHOME/$NFILE" "https://nodejs.org/dist/latest-v24.x/$NFILE" || fail "node download failed"
  echo "$NSHA  $VHOME/$NFILE" | sha256sum -c --quiet - || fail "node tarball checksum mismatch"
  rm -rf "$NODE_DIR.tmp"; mkdir -p "$NODE_DIR.tmp"
  tar -xJf "$VHOME/$NFILE" -C "$NODE_DIR.tmp" --strip-components=1
  rm -rf "$NODE_DIR"; mv "$NODE_DIR.tmp" "$NODE_DIR"; rm -f "$VHOME/$NFILE"
fi
export PATH="$NODE_DIR/bin:$PATH"
if [[ -n "${VERALDAR_REPO_ROOT:-}" ]]; then :; elif ! have cargo; then
  [[ -f "$HOME/.cargo/env" ]] && . "$HOME/.cargo/env"
  if ! have cargo; then
    step "2/5 rust (rustup, minimal profile)"
    curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --no-modify-path \
      || fail "rustup install failed"
    . "$HOME/.cargo/env"
  fi
fi
say "2/5 node $(node --version)$(have cargo && echo " · $(cargo --version)")"

# ---------- 3. source ----------
checkout_ref() { # branch (origin/<ref>), tag or sha — always detached, -f drops the build's version stamp
  local t="$REPO_REF"
  git -C "$SRC" rev-parse -q --verify "origin/$REPO_REF^{commit}" >/dev/null && t="origin/$REPO_REF"
  git -C "$SRC" checkout -q -f --detach "$t"
}
if [[ -n "${VERALDAR_REPO_ROOT:-}" ]]; then
  SRC="$VERALDAR_REPO_ROOT"
  say "3/5 source: $SRC (VERALDAR_REPO_ROOT — dev twin, no clone/build)"
else
  SRC="${VERALDAR_SRC:-$VHOME/bifrost}"
  if [[ ! -d "$SRC/.git" ]]; then
    step "3/5 source: clone $REPO_URL ($REPO_REF)"
    rm -rf "$SRC"
    # blobless, NOT shallow: the app's prebuild stamps its version from `git describe --tags`
    # (a --depth 1 clone yields a bare sha there -> npm "Invalid version"); history+tags ~1 MB
    git clone -q --filter=blob:none --no-checkout "$REPO_URL" "$SRC" || fail "clone failed: $REPO_URL"
    checkout_ref || fail "no branch/tag/commit '$REPO_REF' in $REPO_URL"
  elif (( UPDATE )); then
    step "3/5 source: update to $REPO_REF"
    git -C "$SRC" fetch -q --tags origin || fail "update failed (git fetch $REPO_URL)"
    checkout_ref || fail "no branch/tag/commit '$REPO_REF' in $REPO_URL"
  fi
  say "3/5 source: $SRC @ $(git -C "$SRC" rev-parse --short HEAD)"
fi
REV="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"

# ---------- 4. build once per source rev ----------
built() { [[ -f "$SRC/.veraldar-built-$1" && "$(cat "$SRC/.veraldar-built-$1")" == "$REV" ]]; }
if [[ -z "${VERALDAR_REPO_ROOT:-}" ]]; then
  if ! built app || [[ ! -f "$SRC/pwa/.next/BUILD_ID" ]]; then
    step "4/5 build the app (npm ci + next build — first run ~5 min)"
    (cd "$SRC/pwa" && npm ci --no-audit --no-fund --loglevel=error && npm run build) || fail "app build failed (output above)"
    echo "$REV" > "$SRC/.veraldar-built-app"
  fi
  for crate in yggdrasil bifrost-net; do
    part=root; [[ $crate == bifrost-net ]] && part=trunk
    if ! built "$crate" || [[ ! -x "$SRC/lab/$crate/target/release/$crate" ]]; then
      step "4/5 build the $part (lab/$crate, cargo --release — first run ~3-8 min)"
      cargo build --release --locked --manifest-path "$SRC/lab/$crate/Cargo.toml" || fail "$crate build failed (output above)"
      echo "$REV" > "$SRC/.veraldar-built-$crate"
    fi
  done
fi
say "4/5 built: app $(cat "$SRC/pwa/.next/BUILD_ID" 2>/dev/null || echo '?') · root + trunk binaries present"

# ---------- 5. stage: mock + root + app + trunk, plain runner ----------
step "5/5 start the stack (ports $PORT_BASE-$((PORT_BASE+4)))"
if [[ -f "$LAYMAN_SRC" ]]; then tr -d '\r' < "$LAYMAN_SRC" > "$LAYMAN"
else cp "$SRC/lab/layman-deploy/impl/layman-bootstrap.sh" "$LAYMAN"; fi
# the IP the phone dials: the Windows side passes its LAN NIC. In mirrored networking it is
# also an address of THIS distro; in NAT mode it is not — say so (the phone cannot reach us).
if [[ -n "$ADV_IP" ]] && have ip && ! ip -4 -o addr show | grep -q " $ADV_IP/"; then
  say "WARN: $ADV_IP is not on this WSL's interfaces — WSL runs in NAT mode, so the PHONE cannot"
  say "      reach this PC (the PC browser still works). Fix: networkingMode=mirrored in"
  say "      %USERPROFILE%\\.wslconfig, then 'wsl --shutdown' and start Veraldar again."
fi
rm -rf "$QR_HOME"; mkdir -p "$QR_HOME"
LAYMAN_REPO_ROOT="$SRC" LAYMAN_STAGE_DIR="$STAGE_DIR" LAYMAN_RUNNER="${LAYMAN_RUNNER:-plain}" \
LAYMAN_ADVERTISE_IP="$ADV_IP" \
  bash "$LAYMAN" --stage --ports "$PORT_BASE" --qr-dir "$QR_HOME" || fail "stack did not come up (output above)"

# ---------- deliver: QR png to every Desktop, URLs + versions for the Windows side ----------
JOIN_URL="$(cat "$QR_HOME/pair-qr.txt" 2>/dev/null)" || fail "bootstrap wrote no QR payload"
PNG="$QR_HOME/pair-qr.png"
if [[ ! -s "$PNG" ]]; then
  have qrencode && qrencode -o "$PNG" -s 8 -m 2 "$JOIN_URL" || fail "QR png could not be rendered"
fi
IP_IN_URL="$(printf '%s' "$JOIN_URL" | sed -E 's#^http://([^:/]+):.*#\1#')"
LOCAL_URL="${JOIN_URL//http:\/\/$IP_IN_URL:/http://localhost:}"
LOCAL_URL="${LOCAL_URL//http%3A%2F%2F$IP_IN_URL%3A/http%3A%2F%2Flocalhost%3A}"
printf '%s' "$JOIN_URL"  > "$OUT_DIR/join-url.txt"
printf '%s' "$LOCAL_URL" > "$OUT_DIR/join-url-local.txt"
VERSIONS="app $(node -p 'require(process.argv[1]).version' "$SRC/pwa/package.json" 2>/dev/null || echo '?') ($(cat "$SRC/pwa/.next/BUILD_ID")) · root $(grep -m1 '^version' "$SRC/lab/yggdrasil/Cargo.toml" | cut -d'"' -f2) · trunk $(grep -m1 '^version' "$SRC/lab/bifrost-net/Cargo.toml" | cut -d'"' -f2) · src $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?')"
printf '%s\n' "$VERSIONS" > "$OUT_DIR/versions.txt"

DELIVERED=()
[[ -n "$QR_EXACT" ]] && { QR_EXACT="$(to_linux "$QR_EXACT")"; mkdir -p "$(dirname "$QR_EXACT")"; cp "$PNG" "$QR_EXACT" && DELIVERED+=("$QR_EXACT"); }
for d in "${DESKTOPS[@]}"; do
  d="$(to_linux "$d")"
  mkdir -p "$d" 2>/dev/null || true
  if cp "$PNG" "$d/Veraldar-Pair-QR.png" 2>/dev/null; then DELIVERED+=("$d/Veraldar-Pair-QR.png")
  else say "WARN: could not write the QR into $d"; fi
done
cp "$PNG" "$OUT_DIR/Veraldar-Pair-QR.png" && DELIVERED+=("$OUT_DIR/Veraldar-Pair-QR.png")
date -u +%FT%TZ > "$OUT_DIR/ready"

say "-------------------------------------------------------------"
say "Veraldar is UP"
say "  versions: $VERSIONS"
say "  phone   : scan Veraldar-Pair-QR.png (phone on the SAME Wi-Fi as this PC)"
say "  join URL: $JOIN_URL"
say "  this PC : $LOCAL_URL"
for f in "${DELIVERED[@]}"; do say "  QR png  : $f"; done
say "-------------------------------------------------------------"

if (( HOLD )); then
  # window closed = SIGHUP and tee may already be gone: stop the stack FIRST, print nothing after
  trap 'trap - EXIT; trap "" PIPE; stage_down >/dev/null 2>&1; rm -f "$OUT_DIR/ready"; exit 0' EXIT HUP INT TERM
  say "keep this window open — closing it (or Ctrl+C) stops Veraldar."
  while :; do
    sleep 30 & wait $! || true   # `wait` returns at once on HUP/INT/TERM (a bare sleep would delay the trap ≤30 s)
    curl -sf -o /dev/null "http://127.0.0.1:$PORT_BASE/" || say "WARN: the app on :$PORT_BASE stopped answering (log: $STAGE_DIR.run/)"
  done
fi
exit 0
