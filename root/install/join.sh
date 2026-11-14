#!/usr/bin/env bash
# join.sh — make THIS machine (Linux, WSL2 Ubuntu, macOS) a root of an existing tree. No sudo, no docker.
#
#   ./join.sh --hub https://tree.example.org    ask the hub; a QR appears; scan it with your paired phone, approve
#   ./join.sh                                   re-run: keeps the join, refreshes files, makes sure it all runs
#   ./join.sh --rejoin --hub URL                join again (a new root id); the old join stays if this one fails
#   ./join.sh --stop                            stop this root's services (the join is kept)
#
# This machine only DIALS OUT: its brain listens on loopback, root-dial.py carries it to the trunk through
# the hub's public access point (wss). Nothing here needs an open port, a public IP or a certificate.
# Brain calls with the other roots ride this root's own WireGuard node (bifrost-net wg): its key is made
# here (mode 600), the phone shows the key's fingerprint next to the code, and approving pins it.
#
#   --hub URL             the hub your phone is paired with (needed for the first join only)
#   --name NAME           this root's name in the tree (default: the hostname)
#   --dir DIR             everything this root keeps (default ~/.local/share/yggdrasil-root)
#   --upstream-env FILE   the model: YGG_UPSTREAM_BASE_URL / _API_KEY / _MODEL / _STYLE lines. Default: the
#                         same variables from the environment; asked for when run in a terminal. Kept on re-runs.
#   --qr-png FILE         where the QR picture goes (default DIR/join-qr.png)   --open-qr   show it on screen
#   --brain-bin FILE      use this yggdrasil binary (default: DIR/bin, the repo's build, ~/.local/bin, PATH,
#                         else cargo build --release in root/)           --build   rebuild with cargo anyway
#   --net-bin FILE        use this bifrost-net binary (the tunnel's node; default: DIR/bin, the repo's build,
#                         ~/.local/bin, PATH, else the release on Linux/WSL x86_64 — checked against
#                         SHA256SUMS — or cargo build --release in trunk/ on macOS, about 3-5 minutes)
#   --brain-port P / --peer-port P   loopback ports (first join: 4180/4181, or the next free pair); the peer
#                         port is the node's door (tcp) and its udp, the brain port the dialer's udp too
#   --project-dir DIR     where the brain's tools work (default: your home)
#   --supervisor auto|systemd|launchd|nohup   auto = launchd on macOS, systemd --user when it answers, else a
#                         nohup loop (logs in DIR/log; re-run join.sh after a reboot)
#   --no-start            write everything, start nothing
#   --cacert FILE         trust this CA for the hub (tests with a self-signed hub ONLY)
#
# Exit: 0 joined and running · 3 refused on the phone · 4 the request expired · 64 usage · 1 anything else.
set -euo pipefail
umask 077

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit "${2:-1}"; }
usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; }

HUB='' NAME='' DIR='' UPSTREAM_FILE='' QR_PNG='' OPEN_QR='' BRAIN_BIN=${YGG_BINARY:-} BUILD=0 BRAIN_PORT='' PEER_PORT='' NET_BIN=''
PROJECT_DIR='' SUPERVISOR=auto START=1 CACERT='' REJOIN=0 STOP=0
need() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 64; }
while [ $# -gt 0 ]; do
  case $1 in
    --hub) need "$@"; HUB=$2; shift ;;
    --name) need "$@"; NAME=$2; shift ;;
    --dir) need "$@"; DIR=$2; shift ;;
    --upstream-env) need "$@"; UPSTREAM_FILE=$2; shift ;;
    --qr-png) need "$@"; QR_PNG=$2; shift ;;
    --open-qr) OPEN_QR=1 ;;
    --brain-bin) need "$@"; BRAIN_BIN=$2; shift ;;
    --net-bin) need "$@"; NET_BIN=$2; shift ;;
    --build) BUILD=1 ;;
    --brain-port) need "$@"; BRAIN_PORT=$2; shift ;;
    --peer-port) need "$@"; PEER_PORT=$2; shift ;;
    --project-dir) need "$@"; PROJECT_DIR=$2; shift ;;
    --supervisor) need "$@"; SUPERVISOR=$2; shift ;;
    --no-start) START=0 ;;
    --cacert) need "$@"; CACERT=$2; shift ;;
    --rejoin) REJOIN=1 ;;
    --stop) STOP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" 64 ;;
  esac
  shift
done
case $SUPERVISOR in auto|systemd|launchd|nohup) ;; *) die "--supervisor: auto, systemd, launchd or nohup" 64 ;; esac

# ------------------------------------------------------------------------------- the machine
case $(uname -s) in
  Darwin) OS=macos ;;
  Linux) if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then OS=wsl; else OS=linux; fi ;;
  *) die "unsupported system $(uname -s): Linux, WSL2 or macOS" ;;
esac
pkg_hint() { # what to run to get the named packages (Debian names)
  if [ $OS = macos ]; then echo "xcode-select --install   (or: brew install $*)"
  elif command -v apt-get >/dev/null; then echo "sudo apt-get update && sudo apt-get install -y $*"
  elif command -v dnf >/dev/null; then echo "sudo dnf install -y $*"
  elif command -v pacman >/dev/null; then echo "sudo pacman -S --needed $*"
  else echo "install: $*"; fi
}
PY=$(command -v python3 || true)
if [ -z "$PY" ] || ! "$PY" -c 'import ssl, json, urllib.request, zlib, fcntl' 2>/dev/null; then
  die "python3 (with ssl) is needed — $(pkg_hint python3 ca-certificates)"
fi

DIR=${DIR:-$HOME/.local/share/yggdrasil-root}
case $DIR in /*) ;; *) DIR=$PWD/$DIR ;; esac
case $DIR$PY in *[!A-Za-z0-9/._+@:,~-]*) die "paths with spaces or special characters are not supported: $DIR" 64 ;; esac
CONF=$DIR/root.conf
BIN=$DIR/bin
HELPER=$BIN/rootjoin.py
LOG=$DIR/log
RUN=$DIR/run

confget() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | tail -1 || true; }
CHANGED=0
put() { # put FILE MODE < content — replace FILE only when the content differs; sets CHANGED
  local tmp; tmp=$(mktemp "$1.XXXXXX"); cat >"$tmp"; chmod "$2" "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; else mv -f "$tmp" "$1"; CHANGED=1; fi
}
copy() { # copy SRC DEST MODE
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 0; fi
  cp "$1" "$2.new.$$"; chmod "$3" "$2.new.$$"; mv -f "$2.new.$$" "$2"; CHANGED=1
}
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
proc_args() { if [ -r "/proc/$1/cmdline" ]; then tr '\0' ' ' <"/proc/$1/cmdline"; else ps -p "$1" -o args= 2>/dev/null; fi; }

# ------------------------------------------------------------------------------- supervisors
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
AGENT_DIR=$HOME/Library/LaunchAgents
UNITS=(yggdrasil-root-brain.service yggdrasil-root-dial.service)
LABEL=org.veraldar.yggdrasil-root
systemd_sees() { # the user manager answers AND reads the unit dir we write to
  local real; real=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true); real=${real:-$HOME}
  [ "$UNIT_DIR" = "$real/.config/systemd/user" ] && command -v systemctl >/dev/null \
    && systemctl --user show-environment >/dev/null 2>&1
}
pick_supervisor() {
  case $SUPERVISOR in
    systemd|launchd|nohup) echo "$SUPERVISOR" ;;
    auto) if [ $OS = macos ]; then echo launchd; elif systemd_sees; then echo systemd; else echo nohup; fi ;;
  esac
}
supervise_pid() { # the running nohup supervisor of THIS dir, if any
  local p; p=$(cat "$RUN/supervise.pid" 2>/dev/null || true)
  pid_alive "$p" && proc_args "$p" | grep -q "$BIN/supervise" && echo "$p" || true
}
stop_services() { # stop whatever supervisor this dir used
  local sup p u; sup=$(confget SUPERVISOR); u=("${UNITS[@]}")
  [ -f "$UNIT_DIR/yggdrasil-root-wg.service" ] && u+=(yggdrasil-root-wg.service)
  case $sup in
    systemd) systemctl --user disable --now "${u[@]}" yggdrasil-root-refill.timer >/dev/null 2>&1 || true ;;
    launchd) for s in brain dial refill wg; do launchctl bootout "gui/$(id -u)/$LABEL.$s" 2>/dev/null || true; done ;;
  esac
  p=$(supervise_pid)
  if [ -n "$p" ]; then
    kill -TERM "$p" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pid_alive "$p" || break; sleep 0.5; done
  fi
  say "stopped${sup:+ ($sup)}"
}

if [ $STOP = 1 ]; then
  [ -f "$CONF" ] || die "nothing here to stop: $CONF missing"
  stop_services
  h=$(cat "$RUN/hold.pid" 2>/dev/null || true); if pid_alive "$h"; then kill "$h"; fi; rm -f "$RUN/hold.pid"
  exit 0
fi

# ------------------------------------------------------------------------------- what we join
mkdir -p "$DIR" "$BIN" "$LOG" "$RUN" "$DIR/data"
chmod 700 "$DIR"
cp "$HERE/rootjoin.py" "$HELPER.new.$$" && chmod 755 "$HELPER.new.$$" && mv -f "$HELPER.new.$$" "$HELPER"
JOINED=0; [ -f "$DIR/root.json" ] && JOINED=1
if [ $JOINED = 1 ]; then SAVED_HUB=$("$PY" "$HELPER" get --state "$DIR" hub); else SAVED_HUB=$("$PY" "$HELPER" get --state "$DIR" pending_hub); fi
OLD_SUP=$(confget SUPERVISOR)
HUB=${HUB%/}
if [ -z "$HUB" ]; then
  HUB=$SAVED_HUB
  [ -n "$HUB" ] || die "first join: pass --hub https://<your hub>  (the address your phone uses)" 64
fi
case $HUB in http://*|https://*) ;; *) die "--hub must start with https:// (got $HUB)" 64 ;; esac
case $HUB in *[!A-Za-z0-9:/._~%@+-]*) die "--hub: unexpected characters in $HUB" 64 ;; esac
if [ $JOINED = 1 ] && [ $REJOIN = 0 ] && [ -n "$SAVED_HUB" ] && [ "$HUB" != "$SAVED_HUB" ]; then
  die "already joined to $SAVED_HUB — to join $HUB instead, add --rejoin" 64
fi
HOSTN=${HOSTNAME:-$(uname -n)}; HOSTN=${HOSTN%%.*}
[ -n "$NAME" ] || NAME=$(confget NAME)
[ -n "$NAME" ] || NAME=$(printf '%s' "$HOSTN" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-48)
[ -n "$PROJECT_DIR" ] || PROJECT_DIR=$(confget PROJECT_DIR); PROJECT_DIR=${PROJECT_DIR:-$HOME}
[ -d "$PROJECT_DIR" ] || die "--project-dir $PROJECT_DIR: not a directory"
[ -n "$CACERT" ] || CACERT=$(confget CACERT)
if [ -n "$CACERT" ]; then
  case $CACERT in /*) ;; *) CACERT=$PWD/$CACERT ;; esac
  [ -r "$CACERT" ] || die "--cacert $CACERT: not readable"
fi
QR_PNG=${QR_PNG:-$DIR/join-qr.png}

port_free() { "$PY" -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1])))' "$1" 2>/dev/null; }
[ -n "$BRAIN_PORT" ] || BRAIN_PORT=$(confget BRAIN_PORT)
[ -n "$PEER_PORT" ] || PEER_PORT=$(confget PEER_PORT)
if [ -z "$BRAIN_PORT" ] || [ -z "$PEER_PORT" ]; then # first run: 4180/4181, or the next free pair
  p=4180
  while [ $p -lt 4300 ]; do
    if port_free $p && port_free $((p + 1)); then break; fi
    p=$((p + 2))
  done
  BRAIN_PORT=${BRAIN_PORT:-$p}; PEER_PORT=${PEER_PORT:-$((p + 1))}
fi
case $BRAIN_PORT$PEER_PORT in *[!0-9]*) die "ports must be numbers" 64 ;; esac

# --------------------------------------------------------------------------- 1. brain binary
find_brain() {
  local c
  if [ -n "$BRAIN_BIN" ]; then echo "$BRAIN_BIN"; return; fi
  [ $BUILD = 1 ] && return 0
  for c in "$BIN/yggdrasil" "$REPO/root/target/release/yggdrasil" "$HOME/.local/bin/yggdrasil" "$(command -v yggdrasil || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  return 0   # none found: the caller builds one (a failing $(…) would end the script under set -e)
}
SRC=$(find_brain)
if [ -z "$SRC" ]; then
  # shellcheck disable=SC1091
  command -v cargo >/dev/null || { [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"; } || true
  if ! command -v cargo >/dev/null || ! command -v cc >/dev/null; then
    die "no yggdrasil binary here, and no Rust to build one. Install, then re-run:
      $(pkg_hint build-essential pkg-config | sed 's/xcode-select --install.*/xcode-select --install/')
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && . ~/.cargo/env
    (or pass --brain-bin /path/to/yggdrasil built elsewhere for this OS/CPU)"
  fi
  [ -f "$REPO/root/Cargo.toml" ] || die "no root/Cargo.toml in $REPO to build the brain from"
  say "building the brain (cargo build --release in $REPO/root — a few minutes the first time)"
  cargo build --release --manifest-path "$REPO/root/Cargo.toml"
  SRC=$REPO/root/target/release/yggdrasil
fi
[ -x "$SRC" ] || die "brain binary not found or not executable: $SRC"
[ "$SRC" = "$BIN/yggdrasil" ] || copy "$SRC" "$BIN/yggdrasil" 755
DIAL_SRC=$REPO/trunk/scripts/root-dial.py
[ -f "$DIAL_SRC" ] || die "missing $DIAL_SRC (the dialer) — is this a full checkout?"
copy "$DIAL_SRC" "$BIN/root-dial.py" 755

# ---------------------------------------------------------------- 1b. the tunnel's node binary
# bifrost-net runs this root's WireGuard node: a given binary, the one installed before, the repo's build,
# ~/.local/bin or PATH; else the release (Linux/WSL x86_64: bifrost-net-<ver>-linux-x86_64, checked against
# the release's SHA256SUMS) or, on macOS and other CPUs, cargo build --release in trunk/.
ARCH=$(uname -m); case $ARCH in amd64) ARCH=x86_64 ;; arm64) ARCH=aarch64 ;; esac
RELEASES=${JOIN_RELEASES:-https://github.com/veraldar/yggdrasil/releases}
find_net() {
  local c
  if [ -n "$NET_BIN" ]; then echo "$NET_BIN"; return; fi
  for c in "$BIN/bifrost-net" "$REPO/trunk/target/release/bifrost-net" "$HOME/.local/bin/bifrost-net" "$(command -v bifrost-net || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  return 0   # none found: the release, or a build
}
NET_SRC=$(find_net)
if [ -z "$NET_SRC" ] && [ $OS != macos ] && [ "$ARCH" = x86_64 ]; then
  say "downloading bifrost-net (this root's WireGuard node) from $RELEASES/latest/download, checked against SHA256SUMS"
  "$PY" "$HELPER" fetch-net --base "$RELEASES/latest/download" --arch "$ARCH" --out "$BIN/bifrost-net.dl" ${CACERT:+--cacert "$CACERT"} \
    || die "no bifrost-net: pass --net-bin FILE (cargo build --release in trunk/ makes one)"
  NET_SRC=$BIN/bifrost-net.dl
fi
if [ -z "$NET_SRC" ]; then
  # shellcheck disable=SC1091
  command -v cargo >/dev/null || { [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"; } || true
  [ -f "$REPO/trunk/Cargo.toml" ] || die "no bifrost-net here and no trunk/ to build it from: pass --net-bin FILE"
  command -v cargo >/dev/null || die "no bifrost-net binary for $OS/$ARCH, and no Rust to build one: install Rust (rustup.rs) or pass --net-bin FILE"
  # libopus: Homebrew's through pkg-config (brew install opus pkg-config), else built from source with cmake
  if ! command -v cmake >/dev/null && ! { command -v pkg-config >/dev/null && pkg-config --exists opus; }; then
    die "building bifrost-net needs cmake, or opus + pkg-config (libopus): $(pkg_hint cmake)"
  fi
  say "building bifrost-net (cargo build --release in $REPO/trunk — about 3-5 minutes the first time)"
  # CMake >= 4 refuses the bundled libopus' old minimum version without this (older CMake ignores it)
  CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build --release --manifest-path "$REPO/trunk/Cargo.toml"
  NET_SRC=$REPO/trunk/target/release/bifrost-net
fi
[ -x "$NET_SRC" ] || die "bifrost-net not found or not executable: $NET_SRC"
[ "$NET_SRC" = "$BIN/bifrost-net" ] || copy "$NET_SRC" "$BIN/bifrost-net" 755
rm -f "$BIN/bifrost-net.dl"
NET_OUT=$("$BIN/bifrost-net" 2>&1 || true)   # usage (exit 2) when it runs; the loader's error when it cannot
case $NET_OUT in # the Linux build links libopus
  *'error while loading shared libraries'*) die "bifrost-net cannot start: ${NET_OUT%%$'\n'*} — $(pkg_hint libopus0)" ;;
esac

# ------------------------------------------------------------------------------ 2. upstream
UP_ARGS=() UP_TMP=
cleanup() { [ -n "$UP_TMP" ] && rm -f "$UP_TMP"; return 0; }
trap cleanup EXIT
if [ -n "$UPSTREAM_FILE" ]; then
  [ -r "$UPSTREAM_FILE" ] || die "--upstream-env $UPSTREAM_FILE: not readable"
  UP_ARGS=(--upstream "$UPSTREAM_FILE")
elif [ -z "${YGG_UPSTREAM_BASE_URL:-}" ] && ! grep -q '^YGG_UPSTREAM_BASE_URL=.' "$DIR/brain.env" 2>/dev/null; then
  if [ -t 0 ]; then # interactive: ask once; the key is read without echo and only ever written to brain.env
    echo "This root needs a model to think with (any OpenAI- or Anthropic-compatible API)."
    read -r -p "  Base URL [https://api.openai.com/v1]: " u; u=${u:-https://api.openai.com/v1}
    s=openai; case $u in *anthropic*) s=anthropic ;; esac
    read -r -p "  Dialect openai|anthropic [$s]: " a; s=${a:-$s}
    read -r -p "  Model [gpt-4o-mini]: " m; m=${m:-gpt-4o-mini}
    read -r -s -p "  API key (not shown; empty for a local server): " k; echo
    UP_TMP=$(mktemp "$DIR/.upstream.XXXXXX")
    printf 'YGG_UPSTREAM_BASE_URL=%s\nYGG_UPSTREAM_STYLE=%s\nYGG_UPSTREAM_MODEL=%s\nYGG_UPSTREAM_API_KEY=%s\n' "$u" "$s" "$m" "$k" >"$UP_TMP"
    unset k
    UP_ARGS=(--upstream "$UP_TMP")
  else
    die "no model upstream. Pass --upstream-env FILE with lines like
      YGG_UPSTREAM_BASE_URL=https://api.openai.com/v1
      YGG_UPSTREAM_API_KEY=sk-...
      YGG_UPSTREAM_MODEL=gpt-4o-mini
    (YGG_UPSTREAM_STYLE=anthropic for an Anthropic-shaped API), or export those variables." 64
  fi
fi
brain_env() { # write DIR/brain.env: the upstream now; plus the join's lines once joined
  local rc=0 out
  out=$("$PY" "$HELPER" brain-env --state "$DIR" --out "$DIR/brain.env" --listen "127.0.0.1:$BRAIN_PORT" \
    --data "$DIR/data" --project "$PROJECT_DIR" --peer-port "$PEER_PORT" ${UP_ARGS[@]+"${UP_ARGS[@]}"}) || rc=$?
  [ $rc = 5 ] && die "no model upstream: pass --upstream-env FILE (see --help)" 64
  [ $rc = 0 ] || die "could not write $DIR/brain.env"
  if [ "$out" = changed ]; then CHANGED=1; fi
}
brain_env   # before the join: a bad upstream fails here, and a resumed join remembers it
write_conf() { # write_conf HUB SUPERVISOR — the settings re-runs read (no secrets)
  {
    echo "# yggdrasil-root — written by join.sh; re-runs read it (pass an option to change a value)"
    echo "HUB=$1"; echo "NAME=$NAME"; echo "BRAIN_PORT=$BRAIN_PORT"; echo "PEER_PORT=$PEER_PORT"
    echo "PROJECT_DIR=$PROJECT_DIR"; echo "CACERT=$CACERT"; echo "SUPERVISOR=$2"
  } | put "$CONF" 600
}
write_conf "$HUB" "$OLD_SUP"   # so an interrupted join resumes with the same name, ports and CA

# ------------------------------------------------------------------------ 2b. the tunnel's key
# Made here, mode 600; only the public half leaves (the phone shows its fingerprint next to the code, and
# approving pins it). A join again gets a fresh key, kept apart until it is approved (the old join keeps
# its own). A root that joined before the tunnel has no key: it joins again, with one.
if [ $JOINED = 1 ] && [ $REJOIN = 0 ] && [ -z "$("$PY" "$HELPER" get --state "$DIR" wg_pub)" ]; then
  say "this root joined before the tunnel: joining again with a WireGuard key — approve it on the phone"
  REJOIN=1
fi
KEYFILE=$DIR/wg.key; [ $JOINED = 1 ] && [ $REJOIN = 1 ] && KEYFILE=$DIR/wg-next.key
WG_PUB=$("$BIN/bifrost-net" wg-key "$KEYFILE" 2>/dev/null | sed -n 's/^public_key = "\(.*\)"$/\1/p')
[ -n "$WG_PUB" ] || die "could not make the WireGuard key ($KEYFILE) with $BIN/bifrost-net"
if [ $JOINED = 1 ] && [ $REJOIN = 0 ] && [ "$("$PY" "$HELPER" get --state "$DIR" wg_pub)" != "$WG_PUB" ]; then
  say "this root's WireGuard key is not the one the hub pinned: joining again with it — approve it on the phone"
  REJOIN=1
fi

# --------------------------------------------------------------------------------- 3. join
if [ $JOINED = 1 ] && [ $REJOIN = 0 ]; then
  say "already joined: root $("$PY" "$HELPER" get --state "$DIR" root_id) of $HUB (no new join; --rejoin to join again)"
else
  [ $REJOIN = 1 ] && [ $JOINED = 1 ] && say "rejoin: asking $HUB for a new join (the current one stays until this is approved)"
  rc=0 NEW_FLAG=; [ $REJOIN = 1 ] && NEW_FLAG=--new
  "$PY" "$HELPER" join --state "$DIR" --hub "$HUB" --name "$NAME" --os "$OS" --host "$HOSTN" --wg-pub "$WG_PUB" \
    --qr-png "$QR_PNG" ${OPEN_QR:+--open-qr} ${CACERT:+--cacert "$CACERT"} $NEW_FLAG || rc=$?
  case $rc in
    0) CHANGED=1
       if [ "$KEYFILE" != "$DIR/wg.key" ]; then mv -f "$KEYFILE" "$DIR/wg.key"; mv -f "$KEYFILE.pub" "$DIR/wg.key.pub"; fi ;;
    3|4|130) exit $rc ;;
    *) die "join failed (exit $rc)" ;;
  esac
fi
ROOT_ID=$("$PY" "$HELPER" get --state "$DIR" root_id)
HUB=$("$PY" "$HELPER" get --state "$DIR" hub)
HUB_NAME=$("$PY" "$HELPER" get --state "$DIR" hub_name); HUB_NAME=${HUB_NAME:-hub}   # the hub brain's root name
TUNNEL=$("$PY" "$HELPER" get --state "$DIR" tunnel)   # 1 = the approval granted the WireGuard tunnel
WG_AGENT='' WG_LOOP=''
if [ "$TUNNEL" = 1 ]; then
  UNITS+=(yggdrasil-root-wg.service) WG_AGENT=' wg' WG_LOOP="loop wg '$BIN/run-wg'"
fi
SUP=$(pick_supervisor)
[ -n "$OLD_SUP" ] && [ "$OLD_SUP" != "$SUP" ] && stop_services
write_conf "$HUB" "$SUP"

# ---------------------------------------------------------------------------- 4. brain env
brain_env
if [ "$TUNNEL" = 1 ]; then # this root's WireGuard node: its door + udp on the peer port, the dialer's udp on the brain port
  out=$("$PY" "$HELPER" wg-config --state "$DIR" --out "$DIR/wg.toml" --brain-port "$BRAIN_PORT" --peer-port "$PEER_PORT") \
    || die "could not write $DIR/wg.toml"
  [ "$out" = changed ] && CHANGED=1
else
  warn "the hub granted no WireGuard tunnel (it runs no node): brain calls with other roots use the old plaintext path"
fi

# ----------------------------------------------------------------------- 5. the run scripts
DIAL=$("$PY" "$HELPER" dial --state "$DIR")
dget() { printf '%s\n' "$DIAL" | sed -n "s/^$1=//p"; }
D_TLS=$(dget TLS) D_HOST=$(dget HOST) D_PORT=$(dget PORT) D_PATH=$(dget PATH)
[ "$D_TLS" = 1 ] || warn "the hub gave a plaintext ws:// root link — the dialer allows that only to private addresses"
BRAIN_URL=http://127.0.0.1:$BRAIN_PORT
CA_LINE=; [ -n "$CACERT" ] && CA_LINE="export SSL_CERT_FILE='$CACERT'   # trust the test hub's CA (--cacert)"
TLS_FLAG=; [ "$D_TLS" = 1 ] && TLS_FLAG='--tls '
SETSID=$(command -v setsid || true)
# the tunnel's datagrams ride the dialer's link (opaque); without a tunnel, the old plaintext peer port
if [ "$TUNNEL" = 1 ]; then PEER_FLAGS="--wg-udp 127.0.0.1:$BRAIN_PORT --wg-node 127.0.0.1:$PEER_PORT"; else PEER_FLAGS="--peer-port $PEER_PORT"; fi

put "$BIN/run-brain" 755 <<EOF
#!/bin/sh
# yggdrasil-root: the brain, with $DIR/brain.env (generated by join.sh)
while IFS= read -r l || [ -n "\$l" ]; do   # KEY=value lines, taken literally (no expansion)
  # shellcheck disable=SC2163
  case \$l in ''|'#'*) ;; *=*) export "\$l" ;; esac
done < '$DIR/brain.env'
cd "\$YGG_PROJECT_DIR" 2>/dev/null || cd || exit 1
exec '$BIN/yggdrasil'
EOF
put "$BIN/run-dialer" 755 <<EOF
#!/bin/sh
# yggdrasil-root: top up the single-use link tokens (< 5 left), then dial the trunk (generated by join.sh)
'$PY' '$HELPER' refill --state '$DIR' || echo "refill failed — dialing with the tokens left" >&2
$CA_LINE
exec '$PY' '$BIN/root-dial.py' $TLS_FLAG--host '$D_HOST' --port $D_PORT --path '$D_PATH' --token-file '$DIR/link-tokens' --brain '$BRAIN_URL' $PEER_FLAGS --probe-exec '$PY $HELPER probe $BRAIN_URL/root'
EOF
if [ "$TUNNEL" = 1 ]; then
put "$BIN/run-wg" 755 <<EOF
#!/bin/sh
# yggdrasil-root: this root's WireGuard node — brain calls with the other roots ride it; its key never
# leaves $DIR/wg.key (generated by join.sh)
exec '$BIN/bifrost-net' wg -c '$DIR/wg.toml'
EOF
fi
put "$BIN/supervise" 755 <<EOF
#!/bin/sh
# yggdrasil-root: keeps the brain, the dialer and the 5-minute token refill alive without systemd/launchd
# (generated by join.sh; started with nohup; logs in $LOG)
echo \$\$ > '$RUN/supervise.pid'
pids=
loop() { # loop NAME CMD... — restart CMD 5 s after it exits
  name=\$1; shift
  ( child=
    trap '[ -n "\$child" ] && kill "\$child" 2>/dev/null; exit 0' TERM INT HUP
    while :; do
      "\$@" >>"$LOG/\$name.log" 2>&1 &
      child=\$!; wait "\$child"; rc=\$?
      echo "\$(date '+%F %T') \$name exited (\$rc), restarting in 5 s" >>"$LOG/\$name.log"
      sleep 5 & child=\$!; wait "\$child"
    done ) &
  pids="\$pids \$!"
}
loop brain '$BIN/run-brain'
$WG_LOOP
loop dial '$BIN/run-dialer'
loop refill '$PY' '$HELPER' refill --state '$DIR' --every 300
trap 'kill \$pids 2>/dev/null; rm -f "$RUN/supervise.pid"; exit 0' TERM INT HUP
wait
EOF

case $SUP in
  systemd) START_CMD="systemctl --user start ${UNITS[*]} yggdrasil-root-refill.timer"
           STOP_CMD="systemctl --user stop ${UNITS[*]} yggdrasil-root-refill.timer" ;;
  launchd) START_CMD="for s in brain dial refill$WG_AGENT; do launchctl kickstart gui/\$(id -u)/$LABEL.\$s; done"
           STOP_CMD="for s in brain dial refill$WG_AGENT; do launchctl bootout gui/\$(id -u)/$LABEL.\$s; done" ;;
  nohup)   START_CMD="p=\$(cat '$RUN/supervise.pid' 2>/dev/null); if [ -z \"\$p\" ] || ! kill -0 \"\$p\" 2>/dev/null; then nohup $SETSID '$BIN/supervise' >/dev/null 2>&1 </dev/null & fi"
           STOP_CMD="p=\$(cat '$RUN/supervise.pid' 2>/dev/null); [ -n \"\$p\" ] && kill \"\$p\"" ;;
esac
put "$BIN/start" 755 <<EOF
#!/bin/sh
# yggdrasil-root: start the services if they are not running ($SUP). --hold: then stay alive
# (the Windows keepalive runs this inside WSL so WSL does not shut the root down). Generated by join.sh.
$START_CMD
[ "\${1:-}" = --hold ] || exit 0
h=\$(cat '$RUN/hold.pid' 2>/dev/null)
if [ -n "\$h" ] && kill -0 "\$h" 2>/dev/null; then exit 0; fi
echo \$\$ > '$RUN/hold.pid'
[ "\$(uname -s)" = Linux ] && exec sleep infinity
while :; do sleep 3600; done
EOF
put "$BIN/stop" 755 <<EOF
#!/bin/sh
# yggdrasil-root: stop the services ($SUP) and the WSL keepalive hold, if any. Generated by join.sh.
$STOP_CMD
h=\$(cat '$RUN/hold.pid' 2>/dev/null); [ -n "\$h" ] && kill "\$h" 2>/dev/null; rm -f '$RUN/hold.pid'
exit 0
EOF

# ---------------------------------------------------------------------- 6. supervisor + start
start_systemd() {
  mkdir -p "$UNIT_DIR"
  put "$UNIT_DIR/yggdrasil-root-brain.service" 644 <<EOF
# yggdrasil-root: this machine's brain, root $ROOT_ID of $HUB (generated by join.sh)
[Unit]
Description=yggdrasil root brain ($ROOT_ID)

[Service]
Type=exec
ExecStart=$BIN/run-brain
Restart=on-failure
RestartSec=3
RestartPreventExitStatus=2
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
  put "$UNIT_DIR/yggdrasil-root-dial.service" 644 <<EOF
# yggdrasil-root: dials the trunk at $D_HOST:$D_PORT$D_PATH, refilling link tokens first (generated by join.sh)
[Unit]
Description=yggdrasil root dialer ($ROOT_ID -> $D_HOST)
After=yggdrasil-root-brain.service
Wants=yggdrasil-root-brain.service
StartLimitIntervalSec=0

[Service]
Type=exec
ExecStart=$BIN/run-dialer
Restart=always
RestartSec=10
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
  if [ "$TUNNEL" = 1 ]; then
  put "$UNIT_DIR/yggdrasil-root-wg.service" 644 <<EOF
# yggdrasil-root: this root's WireGuard node — brain calls with the other roots (generated by join.sh)
[Unit]
Description=yggdrasil root WireGuard node ($ROOT_ID)
StartLimitIntervalSec=0

[Service]
Type=exec
ExecStart=$BIN/run-wg
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
  fi
  put "$UNIT_DIR/yggdrasil-root-refill.service" 644 <<EOF
# yggdrasil-root: top up the link tokens when fewer than 5 are left (generated by join.sh)
[Unit]
Description=yggdrasil root link-token refill ($ROOT_ID)

[Service]
Type=oneshot
ExecStart=$PY $HELPER refill --state $DIR
EOF
  put "$UNIT_DIR/yggdrasil-root-refill.timer" 644 <<EOF
# yggdrasil-root: every 5 minutes (generated by join.sh)
[Unit]
Description=yggdrasil root link-token refill, every 5 minutes

[Timer]
OnActiveSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
  [ $START = 1 ] || return 0
  systemctl --user daemon-reload
  systemctl --user enable "${UNITS[@]}" yggdrasil-root-refill.timer >/dev/null
  if [ $CHANGED = 1 ]; then systemctl --user restart "${UNITS[@]}"; else systemctl --user start "${UNITS[@]}"; fi
  systemctl --user start yggdrasil-root-refill.timer
  if command -v loginctl >/dev/null && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
    loginctl enable-linger "$(id -un)" 2>/dev/null \
      || warn "could not enable lingering: the root runs only while you are logged in (sudo loginctl enable-linger $(id -un))"
  fi
}
plist() { # plist NAME KEEPALIVE(true|false) EXTRA-XML ARG...
  local name=$1 keep=$2 extra=$3 a; shift 3
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<!-- yggdrasil-root: generated by join.sh -->\n<plist version="1.0">\n<dict>\n'
    printf '  <key>Label</key><string>%s.%s</string>\n  <key>ProgramArguments</key>\n  <array>\n' "$LABEL" "$name"
    for a in "$@"; do printf '    <string>%s</string>\n' "$a"; done
    printf '  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><%s/>\n%b' "$keep" "$extra"
    printf '  <key>ThrottleInterval</key><integer>10</integer>\n'
    printf '  <key>StandardOutPath</key><string>%s/%s.log</string>\n  <key>StandardErrorPath</key><string>%s/%s.log</string>\n' "$LOG" "$name" "$LOG" "$name"
    printf '</dict>\n</plist>\n'
  } | put "$AGENT_DIR/$LABEL.$name.plist" 644
}
start_launchd() {
  mkdir -p "$AGENT_DIR"
  local s dom; dom=gui/$(id -u)
  plist brain true '' "$BIN/run-brain"
  plist dial true '' "$BIN/run-dialer"
  [ "$TUNNEL" = 1 ] && plist wg true '' "$BIN/run-wg"
  plist refill false '  <key>StartInterval</key><integer>300</integer>\n' "$PY" "$HELPER" refill --state "$DIR"
  [ $START = 1 ] || return 0
  for s in brain dial refill$WG_AGENT; do
    if launchctl print "$dom/$LABEL.$s" >/dev/null 2>&1; then
      [ $CHANGED = 0 ] && continue
      launchctl bootout "$dom/$LABEL.$s" 2>/dev/null || true
    fi
    launchctl bootstrap "$dom" "$AGENT_DIR/$LABEL.$s.plist"
  done
}
start_nohup() {
  [ $START = 1 ] || return 0
  local p; p=$(supervise_pid)
  if [ -n "$p" ] && [ $CHANGED = 0 ]; then say "supervisor already running (pid $p)"; return 0; fi
  if [ -n "$p" ]; then kill -TERM "$p" 2>/dev/null || true; for _ in 1 2 3 4 5 6 7 8 9 10; do pid_alive "$p" || break; sleep 0.5; done; fi
  rm -f "$RUN/supervise.pid"
  nohup ${SETSID:+"$SETSID"} "$BIN/supervise" >/dev/null 2>&1 </dev/null &
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$RUN/supervise.pid" ] && break; sleep 0.2; done
  say "supervisor started (pid $(cat "$RUN/supervise.pid" 2>/dev/null || echo '?'), logs in $LOG)"
  [ $OS = wsl ] || warn "no systemd user session: after a reboot, run join.sh again (or $BIN/start) to bring the root back"
}
case $SUP in
  systemd) start_systemd ;;
  launchd) start_launchd ;;
  nohup) start_nohup ;;
esac

# ---------------------------------------------------------------------------- 7. the result
if [ $START = 1 ]; then
  up=0
  for _ in $(seq 1 "${JOIN_BRAIN_WAIT:-30}"); do "$PY" "$HELPER" probe "$BRAIN_URL/root" 2>/dev/null && { up=1; break; }; sleep 0.5; done
  if [ $up = 1 ]; then say "brain up on $BRAIN_URL"; else warn "the brain is not answering on $BRAIN_URL yet — see the log ($SUP)"; fi
fi
cat <<EOF

  root      $ROOT_ID  ($NAME on $OS) of $HUB
  home      the hub brain "$HUB_NAME" ($(if [ "$TUNNEL" = 1 ]; then echo "inside WireGuard: http://127.0.0.1:$PEER_PORT/_wg/local; the other roots: /_wg/<root>"; else echo "YGG_PEERS $HUB_NAME=http://127.0.0.1:$PEER_PORT/local, plaintext"; fi): reports go home there)
  tunnel    $(if [ "$TUNNEL" = 1 ]; then echo "bifrost-net wg on 127.0.0.1:$PEER_PORT · key $DIR/wg.key (mode 600)"; else echo "none: the hub runs no WireGuard node"; fi)
  services  $SUP: brain $BRAIN_URL · dialer -> $([ "$D_TLS" = 1 ] && echo wss || echo ws)://$D_HOST:$D_PORT$D_PATH · token refill every 5 min
  files     $DIR  (root.json, link-tokens, brain.env: mode 600)
  logs      $(case $SUP in systemd) echo "journalctl --user -u yggdrasil-root-brain -u yggdrasil-root-dial -f" ;; *) echo "$LOG/" ;; esac)
  stop      $0 --stop     re-run: $0 (keeps this join)
EOF
