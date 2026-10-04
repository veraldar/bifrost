#!/usr/bin/env bash
# Install bifrost as systemd user services — native, no docker, no root. Idempotent: safe to re-run.
#
#   ./install.sh                  FULL STACK (default): brain + app + bridge + voice + livekit + agent,
#                                 then enable, (re)start what changed, and health-check every piece
#   ./install.sh --no-start       full stack, but enable/start nothing
#   ./install.sh --direct         full stack on a box WITHOUT a systemd user session (containers, WSL):
#                                 runs each unit's own command with nohup; logs in ~/.local/state/bifrost/log/
#   ./install.sh --skip voice,agent   leave components out: brain app bridge voice livekit agent
#   ./install.sh --brain-only [--now] the brain alone, as before (it starts only with --now)
#
# Config, created once (mode 600) and never overwritten — install.sh re-reads them on every run:
#   ~/.config/bifrost/bifrost.env       the stack: ports, LAN IP, pairing, voice, LIVEKIT_MODE=binary|cloud
#   ~/.config/yggdrasil/yggdrasil.env   the brain: your OpenAI/Anthropic-compatible upstream + key
# Seed either from the environment on the first run, e.g.
#   YGG_UPSTREAM_BASE_URL=https://api.openai.com/v1 YGG_UPSTREAM_API_KEY=sk-… ./install.sh
# Every file, unit, env key NAME and network call is listed in ~/.config/bifrost/install-manifest.txt.
# Paths: BIN_DIR (~/.local/bin), XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, BIFROST_ROOT (the repo).
set -euo pipefail
trap 'printf "\033[1;31mxx\033[0m  install.sh stopped at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

MODE=full NOW=0 START=1 DIRECT=0 SKIP=,
while [ $# -gt 0 ]; do
  case $1 in
    --brain-only) MODE=brain ;;
    --now) NOW=1 ;;
    --no-start) START=0 ;;
    --direct) DIRECT=1 ;;
    --skip) shift; SKIP="$SKIP${1:-},," ;;
    --skip=*) SKIP="$SKIP${1#--skip=}," ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

HERE=$(cd "$(dirname "$0")" && pwd)
CRATE=$(dirname "$HERE")
BIN_DIR=${BIN_DIR:-$HOME/.local/bin}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
CONF_DIR=$CONFIG_HOME/yggdrasil
UNIT_DIR=$CONFIG_HOME/systemd/user
DATA_DIR=$DATA_HOME/yggdrasil
ENV_FILE=$CONF_DIR/yggdrasil.env
UNIT=$UNIT_DIR/yggdrasil.service

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }
# same FILE FILE: identical content (cmp is not on every minimal box)
same() { [ -f "$1" ] && [ -f "$2" ] && [ "$(sha256sum <"$1")" = "$(sha256sum <"$2")" ]; }
# envset FILE KEY VALUE: replace the first uncommented KEY= line, or append it (values pass through ENVIRON: no escapes)
envset() {
  local tmp; tmp=$(mktemp "$1.XXXXXX")
  K=$2 V=$3 awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]} index($0, k"=")==1 {if(!d){print k"="v; d=1}; next} {print} END{if(!d) print k"="v}' "$1" >"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$1"
}
envget() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -1 || true; }

# The user manager reads only the REAL home's ~/.config/systemd/user, whatever $HOME/XDG say here.
REAL_HOME=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true); REAL_HOME=${REAL_HOME:-$HOME}
SYSTEMD_SEES=0
if [ "$UNIT_DIR" = "$REAL_HOME/.config/systemd/user" ] && systemctl --user show-environment >/dev/null 2>&1; then
  SYSTEMD_SEES=1
fi

# ---------------------------------------------------------------------------------------- brain
install_brain() {
  local SRC
  if [ -n "${YGG_BINARY:-}" ]; then
    SRC=$YGG_BINARY
  elif [ -x "$HERE/yggdrasil" ]; then
    SRC=$HERE/yggdrasil
  else
    if ! command -v cargo >/dev/null; then
      # shellcheck disable=SC1091
      [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    fi
    command -v cargo >/dev/null || die "no prebuilt yggdrasil and no cargo. Put the binary next to install.sh, or install Rust (pacman -S rust) and re-run"
    say "building release binary (cargo build --release --locked)"
    cargo build --release --locked --manifest-path "$CRATE/Cargo.toml"
    SRC=$CRATE/target/release/yggdrasil
    NET+=("crates.io (cargo build of yggdrasil)")
  fi
  [ -x "$SRC" ] || die "binary not found or not executable: $SRC"

  mkdir -p "$BIN_DIR" "$CONF_DIR" "$UNIT_DIR" "$DATA_DIR/session"
  chmod 700 "$CONF_DIR" "$DATA_DIR"
  install_bin "$SRC" yggdrasil yggdrasil.service

  # env file: create once. Your upstream URL and key survive re-runs. YGG_* in the environment seed it.
  if [ -e "$ENV_FILE" ]; then
    say "config  $ENV_FILE (kept)"
  else
    sed "s|@DATA@|$DATA_DIR|" "$HERE/yggdrasil.env.example" >"$ENV_FILE.new"
    chmod 600 "$ENV_FILE.new"
    for k in YGG_UPSTREAM_BASE_URL YGG_UPSTREAM_API_KEY YGG_UPSTREAM_MODEL YGG_UPSTREAM_STYLE YGG_MAX_TOKENS YGG_LISTEN; do
      [ -n "${!k:-}" ] && envset "$ENV_FILE.new" "$k" "${!k}"
    done
    mv "$ENV_FILE.new" "$ENV_FILE"
    say "config  $ENV_FILE (new$(grep -q '^YGG_UPSTREAM_BASE_URL=.' "$ENV_FILE" || echo '; set YGG_UPSTREAM_BASE_URL'))"
  fi
  FILES+=("$BIN_DIR/yggdrasil  755  brain binary" "$ENV_FILE  600  brain config (upstream URL + key)" "$DATA_DIR/  700  brain session store")

  # unit: regenerated from the template, replaced only if the content changed.
  sed -e "s|@BIN@|$BIN_DIR/yggdrasil|" -e "s|@ENV@|$ENV_FILE|" "$HERE/yggdrasil.service" >"$UNIT.new"
  place_unit "$UNIT.new" "$UNIT"
  say "data    $DATA_DIR"
}

# ------------------------------------------------------------------------- brain-only (as before)
if [ $MODE = brain ]; then
  NET=() FILES=() CHANGED=" "
  install_bin() { # src name — copy then rename, so a running binary is replaced atomically
    if same "$1" "$BIN_DIR/$2"; then say "binary  $BIN_DIR/$2 (unchanged)"
    else install -m 755 "$1" "$BIN_DIR/.$2.new"; mv -f "$BIN_DIR/.$2.new" "$BIN_DIR/$2"
      say "binary  $BIN_DIR/$2 ($(du -h "$BIN_DIR/$2" | cut -f1)) — restart the service to pick it up"; fi
  }
  place_unit() { if same "$1" "$2"; then rm -f "$1"; say "unit    $2 (unchanged)"; else mv -f "$1" "$2"; say "unit    $2"; fi; }
  install_brain
  [ $SYSTEMD_SEES = 1 ] && systemctl --user daemon-reload
  if [ $NOW = 1 ]; then
    [ $SYSTEMD_SEES = 1 ] || { echo "--now: the user manager does not read $UNIT_DIR (or has no session bus); not starting" >&2; exit 1; }
    grep -q '^YGG_UPSTREAM_BASE_URL=.' "$ENV_FILE" || { echo "--now: set YGG_UPSTREAM_BASE_URL in $ENV_FILE first" >&2; exit 1; }
    systemctl --user enable yggdrasil.service
    systemctl --user restart yggdrasil.service
    say "service enabled and (re)started"
  fi
  LISTEN=$(envget "$ENV_FILE" YGG_LISTEN); LISTEN=${LISTEN:-127.0.0.1:4096}
  case :$PATH: in *:"$BIN_DIR":*) ;; *) echo "note: $BIN_DIR is not on your PATH (the service doesn't need it)";; esac
  cat <<EOF

Next steps:
  1. Set your upstream:   \$EDITOR $ENV_FILE
       YGG_UPSTREAM_BASE_URL=https://api.openai.com/v1   (any OpenAI-compatible /v1)
       YGG_UPSTREAM_API_KEY=sk-...                       YGG_UPSTREAM_MODEL=gpt-4o-mini
  2. Start it:            systemctl --user enable --now yggdrasil
                          (already running? systemctl --user restart yggdrasil)
  3. Check it:            curl -s http://$LISTEN/session
  4. Point bifrost at it: set OPENCODE_URL=http://$LISTEN in BOTH
                            bifrost/pwa/.env.local   (phone UI proxy)
                            bifrost/agent/.env       (voice agent)
                          then: systemctl --user restart lk-pwa lk-agent
  (or run ./install.sh without --brain-only: it installs and wires the whole stack)
  Logs: journalctl --user -u yggdrasil -f
EOF
  exit 0
fi

# ==================================================================================== FULL STACK
LIVEKIT_VERSION=${LIVEKIT_VERSION:-1.13.7}
BF_CONF=$CONFIG_HOME/bifrost
BF_DATA=$DATA_HOME/bifrost
BF_STATE=$STATE_HOME/bifrost
BF_ENV=$BF_CONF/bifrost.env
MANIFEST=$BF_CONF/install-manifest.txt
RUN_DIR=$BF_STATE/run
LOG_DIR=$BF_STATE/log
NET=() FILES=() UNITS=() OFF=() SOFT=() CHANGED=" "

ROOT=${BIFROST_ROOT:-}
if [ -z "$ROOT" ]; then d=$HERE; while [ "$d" != / ]; do [ -f "$d/pwa/package.json" ] && { ROOT=$d; break; }; d=$(dirname "$d"); done; fi
[ -n "$ROOT" ] && [ -f "$ROOT/pwa/package.json" ] || die "bifrost repo not found above $HERE (set BIFROST_ROOT=/path/to/bifrost)"

on() { case ,$SKIP, in *,"$1",*) return 1 ;; esac; return 0; }
need_libs() { # binary — every shared library it links must be on this box (a clean Arch lacks libopus)
  local miss; miss=$(ldd "$1" 2>/dev/null | sed -n 's/^[[:space:]]*\([^ ]*\) => not found.*/\1/p' | tr '\n' ' ' || true)
  [ -z "$miss" ] && return 0
  case $miss in *libopus*) die "$(basename "$1") needs libopus — Arch: sudo pacman -S opus · Debian/Ubuntu: sudo apt install libopus0 · Fedora: sudo dnf install opus — then re-run" ;; esac
  die "$(basename "$1") needs shared libraries this box lacks: $miss— install them, then re-run"
}
rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
install_bin() { # src name unit — copy then rename, so a running binary is replaced atomically
  if same "$1" "$BIN_DIR/$2"; then say "binary  $BIN_DIR/$2 (unchanged)"
  else install -m 755 "$1" "$BIN_DIR/.$2.new"; mv -f "$BIN_DIR/.$2.new" "$BIN_DIR/$2"
    say "binary  $BIN_DIR/$2 ($(du -h "$BIN_DIR/$2" | cut -f1))"; CHANGED="$CHANGED$3 "; fi
}
place_unit() { # new target — units are 644 and hold no secrets
  local u; u=$(basename "$2"); chmod 644 "$1"
  if same "$1" "$2"; then rm -f "$1"; say "unit    $2 (unchanged)"; else mv -f "$1" "$2"; say "unit    $2"; CHANGED="$CHANGED$u "; fi
  UNITS+=("$u")
}
place_secret() { # new target unit what — generated config, mode 600, restart the unit when it changed
  chmod 600 "$1"
  if same "$1" "$2"; then rm -f "$1"; say "config  $2 (unchanged)"; else mv -f "$1" "$2"; say "config  $2"; CHANGED="$CHANGED$3 "; fi
  FILES+=("$2  600  $4")
}
unit_from() { # template unit — fill the @…@ placeholders
  sed -e "s|@BIN@|$BIN_DIR|g" -e "s|@CONF@|$BF_CONF|g" -e "s|@STATE@|$BF_STATE|g" -e "s|@PWA@|$ROOT/pwa|g" \
      -e "s|@NODE@|${NODE:-node}|g" -e "s|@VOICE@|$BF_DATA/voice|g" -e "s|@AGENT@|$ROOT/agent|g" \
      -e "s|@AGENTVENV@|$BF_DATA/agent/venv|g" -e "s|@LAN@|$LAN|g" "$HERE/$1" >"$UNIT_DIR/$1.new"
  place_unit "$UNIT_DIR/$1.new" "$UNIT_DIR/$1"
}
soft() { SOFT+=("$1: $2"); warn "$1 skipped — $2"; OFF+=("bifrost-$1.service"); }
need_python() { # sets PY, or fails soft for component $1
  PY=$(command -v python3 || true)
  if [ -z "$PY" ] || ! "$PY" -c 'import sys, venv, ensurepip; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
    soft "$1" "needs python ≥ 3.10 with venv (Arch: sudo pacman -S python · Debian/Ubuntu: sudo apt install python3-venv), then re-run"
    return 1
  fi
}

say "bifrost full stack from $ROOT"
mkdir -p "$BIN_DIR" "$UNIT_DIR" "$BF_CONF" "$BF_DATA" "$BF_STATE" "$RUN_DIR" "$LOG_DIR"
chmod 700 "$BF_CONF" "$BF_STATE"

# ---------------------------------------------------------------------- stack config (bifrost.env)
if [ -e "$BF_ENV" ]; then say "config  $BF_ENV (kept)"
else install -m 600 "$HERE/bifrost.env.example" "$BF_ENV.new"; mv "$BF_ENV.new" "$BF_ENV"; say "config  $BF_ENV (new)"; fi
chmod 600 "$BF_ENV"
for k in $(sed -n 's/^#\{0,1\}\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$HERE/bifrost.env.example" | sort -u); do
  [ -n "${!k:-}" ] && [ "$(envget "$BF_ENV" "$k")" != "${!k}" ] && { envset "$BF_ENV" "$k" "${!k}"; say "config  $k from the environment → bifrost.env"; }
done
cfg() { local v; v=$(envget "$BF_ENV" "$1"); printf '%s' "${v:-${2:-}}"; }
[ -n "$(cfg BIFROST_ADMIN_TOKEN)" ] || envset "$BF_ENV" BIFROST_ADMIN_TOKEN "admin-$(rand 32)"
FILES+=("$BF_ENV  600  stack config (edit this, then re-run install.sh)")

LAN=$(cfg BIFROST_LAN_IP)
[ -n "$LAN" ] || LAN=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
[ -n "$LAN" ] || LAN=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$LAN" ] || { warn "no LAN address found — phones cannot reach this box; set BIFROST_LAN_IP"; LAN=127.0.0.1; }
APP_HOST=$(cfg BIFROST_APP_HOST 0.0.0.0) APP_PORT=$(cfg BIFROST_APP_PORT 8082)
BRIDGE_PORT=$(cfg BIFROST_BRIDGE_PORT 7890) MEDIA_PORT=$(cfg BIFROST_MEDIA_PORT 7891)
VOICE_PORT=$(cfg BIFROST_VOICE_PORT 8000) AGENT_PORT=$(cfg AGENT_HTTP_PORT 8081)
LK_MODE=$(cfg LIVEKIT_MODE binary) LK_PORT=$(cfg LIVEKIT_PORT 7880)
LK_TCP=$(cfg LIVEKIT_TCP_PORT 7881) LK_UDP=$(cfg LIVEKIT_UDP_PORT 7882)
SPEACHES=$(cfg SPEACHES_URL "http://127.0.0.1:$VOICE_PORT/v1")
case $SPEACHES in http://127.0.0.1:*|http://localhost:*) VOICE_LOCAL=1 ;; *) VOICE_LOCAL=0 ;; esac
case $LK_MODE in
  binary)
    [ -n "$(cfg LIVEKIT_API_KEY)" ] || envset "$BF_ENV" LIVEKIT_API_KEY "API$(rand 12)"
    [ -n "$(cfg LIVEKIT_API_SECRET)" ] || envset "$BF_ENV" LIVEKIT_API_SECRET "$(rand 48)"
    LK_PHONE=$(cfg LIVEKIT_URL "ws://$LAN:$LK_PORT") LK_LOCAL=ws://127.0.0.1:$LK_PORT LK_API=http://127.0.0.1:$LK_PORT ;;
  cloud)
    LK_PHONE=$(cfg LIVEKIT_URL) LK_LOCAL=$LK_PHONE LK_API=$(printf '%s' "$LK_PHONE" | sed 's|^ws|http|') ;;
  *) die "LIVEKIT_MODE=$LK_MODE in $BF_ENV — use binary or cloud" ;;
esac
LK_KEY=$(cfg LIVEKIT_API_KEY) LK_SECRET=$(cfg LIVEKIT_API_SECRET)
if [ "$LK_MODE" = cloud ] && { [ -z "$LK_PHONE" ] || [ -z "$LK_KEY" ] || [ -z "$LK_SECRET" ]; }; then
  warn "LIVEKIT_MODE=cloud needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in $BF_ENV — voice stays off until set"
fi

# ---------------------------------------------------------------------------- preflight: ports
# A port held by our own running unit is fine (re-run); anything else is failure mode #1.
ours() { # unit — is it ours and running?
  [ $SYSTEMD_SEES = 1 ] && systemctl --user is-active --quiet "$1" && return 0
  [ -f "$RUN_DIR/$1.pid" ] && kill -0 "$(cat "$RUN_DIR/$1.pid")" 2>/dev/null
}
BUSY=()
check_port() { # proto port unit
  command -v ss >/dev/null || return 0
  ours "$3" && return 0
  local who; who=$(ss -Hln"$1"p "sport = :$2" 2>/dev/null | head -1 | grep -o 'users:.*' || true)
  if [ -n "$(ss -Hln"$1" "sport = :$2" 2>/dev/null | head -1)" ]; then BUSY+=("$1/$2 (wanted by $3) is taken ${who:-(owner hidden: another user)}"); fi
}
BRAIN_LISTEN=$(envget "$ENV_FILE" YGG_LISTEN); BRAIN_LISTEN=${BRAIN_LISTEN:-${YGG_LISTEN:-127.0.0.1:4100}}
on brain && check_port t "${BRAIN_LISTEN##*:}" yggdrasil.service
on app && check_port t "$APP_PORT" bifrost-app.service
on bridge && { check_port t "$BRIDGE_PORT" bifrost-bridge.service; check_port u "$MEDIA_PORT" bifrost-bridge.service; }
on voice && [ $VOICE_LOCAL = 1 ] && check_port t "$VOICE_PORT" bifrost-voice.service
on livekit && [ "$LK_MODE" = binary ] && { check_port t "$LK_PORT" bifrost-livekit.service; check_port t "$LK_TCP" bifrost-livekit.service; check_port u "$LK_UDP" bifrost-livekit.service; }
on agent && check_port t "$AGENT_PORT" bifrost-agent.service
if [ ${#BUSY[@]} -gt 0 ]; then
  for b in "${BUSY[@]}"; do warn "port $b"; done
  die "pick free ports in $BF_ENV (BIFROST_APP_PORT, BIFROST_BRIDGE_PORT, BIFROST_MEDIA_PORT, BIFROST_VOICE_PORT, LIVEKIT_*_PORT, AGENT_HTTP_PORT; the brain's is YGG_LISTEN in $ENV_FILE), then re-run. Nothing was installed."
fi

# ------------------------------------------------------------------------------------- 1. brain
if on brain; then install_brain; fi
BRAIN_LISTEN=$(envget "$ENV_FILE" YGG_LISTEN); BRAIN_LISTEN=${BRAIN_LISTEN:-127.0.0.1:4100}
BRAIN_URL=http://$BRAIN_LISTEN

# ------------------------------------------------------------------------------------ 2. bridge
if on bridge; then
  if [ -n "${BRIDGE_BINARY:-}" ]; then SRC=$BRIDGE_BINARY
  elif [ -x "$HERE/bifrost-net" ]; then SRC=$HERE/bifrost-net
  elif [ -x "$ROOT/lab/bifrost-net/target/release/bifrost-net" ]; then SRC=$ROOT/lab/bifrost-net/target/release/bifrost-net
  else
    command -v cargo >/dev/null || { [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"; }
    command -v cargo >/dev/null || die "no prebuilt bifrost-net and no cargo. Put the binary next to install.sh, or install Rust (pacman -S rust) and re-run"
    say "building the bridge (cargo build --release --locked)"
    cargo build --release --locked --manifest-path "$ROOT/lab/bifrost-net/Cargo.toml"
    SRC=$ROOT/lab/bifrost-net/target/release/bifrost-net
    NET+=("crates.io (cargo build of bifrost-net)")
  fi
  need_libs "$SRC"
  install_bin "$SRC" bifrost-net bifrost-bridge.service
  FILES+=("$BIN_DIR/bifrost-net  755  bridge binary")
  KEY=$(sed -n 's/^private_key = "\(.*\)"/\1/p' "$BF_CONF/bridge.toml" 2>/dev/null | head -1 || true)
  [ -n "$KEY" ] || KEY=$("$BIN_DIR/bifrost-net" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
  [ -n "$KEY" ] || die "bifrost-net keygen produced no key"
  cat >"$BF_CONF/bridge.toml.new" <<TOML
# GENERATED by install.sh from bifrost.env (the private key is kept across runs). Mode 600.
[node]
name = "$(uname -n)"
private_key = "$KEY"

[bridge]
http = "0.0.0.0:$BRIDGE_PORT"
media = "$LAN:$MEDIA_PORT"
tokens_file = "$BF_STATE/devices.json"
candidates = ["$LAN"]
dtls_cert_file = "$BF_STATE/bridge-dtls.json"
public_url = "http://$LAN:$BRIDGE_PORT"
TOML
  place_secret "$BF_CONF/bridge.toml.new" "$BF_CONF/bridge.toml" bifrost-bridge.service "bridge config (node private key)"
  unit_from bifrost-bridge.service
  FILES+=("$BF_STATE/devices.json  600  paired devices (app + bridge share it; created on first pair)"
          "$BF_STATE/bridge-dtls.json  600  bridge DTLS identity (created on first start)")
fi

# ------------------------------------------------------------------------------------- 3. app
if on app; then
  NODE=$(command -v node || true)
  [ -n "$NODE" ] || die "node not found — install Node.js ≥ 20 (Arch: sudo pacman -S nodejs npm) and re-run"
  command -v npm >/dev/null || die "npm not found (Arch: sudo pacman -S npm)"
  PWA=$ROOT/pwa
  if [ "${BIFROST_REBUILD:-0}" = 1 ] || [ ! -f "$PWA/.next/BUILD_ID" ] || [ ! -d "$PWA/node_modules" ] ||
     [ -n "$(cd "$PWA" && find app components hooks lib styles public middleware.ts next.config.ts package.json package-lock.json server.mjs -newer .next/BUILD_ID -print -quit 2>/dev/null)" ]; then
    say "app     npm install + npm run build in $PWA (takes a few minutes)"
    (cd "$PWA" && npm install --no-audit --no-fund && npm run build) || die "app build failed (output above)"
    NET+=("registry.npmjs.org (npm install for the app)")
    CHANGED="${CHANGED}bifrost-app.service "
  else
    say "app     $PWA/.next is current (BIFROST_REBUILD=1 forces a rebuild)"
  fi
  {
    echo "# GENERATED by install.sh from bifrost.env — edit that file and re-run install.sh. Mode 600."
    echo "PORT=$APP_PORT"
    echo "HOST=$APP_HOST"
    echo "NODE_ENV=production"
    echo "OPENCODE_URL=$BRAIN_URL"
    echo "BIFROST_AUTH=$(cfg BIFROST_AUTH devices)"
    echo "BIFROST_ADMIN_TOKEN=$(cfg BIFROST_ADMIN_TOKEN)"
    echo "BIFROST_DEVICES_FILE=$BF_STATE/devices.json"
    echo "BIFROST_BRIDGE_URL=http://127.0.0.1:$BRIDGE_PORT"
    echo "BIFROST_PUBLIC_URL=http://$LAN:$APP_PORT"
    echo "SPEACHES_URL=$SPEACHES"
    echo "LIVEKIT_URL=$LK_PHONE"
    echo "LIVEKIT_API_URL=$LK_API"
    echo "LIVEKIT_API_KEY=$LK_KEY"
    echo "LIVEKIT_API_SECRET=$LK_SECRET"
    for k in TTS_MODEL TTS_MODEL_EN TTS_VOICE_EN TTS_MODEL_FR TTS_VOICE_FR VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
      v=$(cfg "$k"); [ -n "$v" ] && echo "$k=$v"
    done
  } >"$BF_CONF/app.env.new"
  place_secret "$BF_CONF/app.env.new" "$BF_CONF/app.env" bifrost-app.service "app env (generated: admin token, LiveKit secret)"
  unit_from bifrost-app.service
fi

# ------------------------------------------------------------------------------------- 4. voice
if on voice; then
  if [ $VOICE_LOCAL = 0 ]; then
    say "voice   SPEACHES_URL=$SPEACHES is a remote speech server — the local one is not installed"
    curl -sf -m 4 "$SPEACHES/models" >/dev/null || warn "voice: $SPEACHES/models does not answer from here (yet)"
    NET+=("$SPEACHES/models (reachability probe)")
    OFF+=("bifrost-voice.service")
  elif need_python voice; then
    V=$BF_DATA/voice
    mkdir -p "$V"
    for f in voice_server.py get_models.sh requirements.txt; do
      install -m 644 "$ROOT/edge/$f" "$V/.$f.new"
      if same "$V/.$f.new" "$V/$f"; then rm -f "$V/.$f.new"; else mv -f "$V/.$f.new" "$V/$f"; CHANGED="${CHANGED}bifrost-voice.service "; fi
    done
    chmod 755 "$V/get_models.sh"
    [ -x "$V/venv/bin/python" ] || "$PY" -m venv "$V/venv"
    VOICE_OK=1
    if ! same "$V/requirements.txt" "$V/venv/.installed-requirements"; then
      say "voice   pip install sherpa-onnx + server deps into $V/venv"
      NET+=("pypi.org (pip: voice server deps — sherpa-onnx, fastapi, uvicorn, numpy)")
      if "$V/venv/bin/pip" install --disable-pip-version-check -q -r "$V/requirements.txt"; then
        cp "$V/requirements.txt" "$V/venv/.installed-requirements"
      else VOICE_OK=0; soft voice "pip could not install its deps (output above) — fix and re-run"; fi
    else say "voice   venv deps current"; fi
  fi
  if [ $VOICE_LOCAL = 1 ] && [ "${VOICE_OK:-0}" = 1 ]; then
    printf '# GENERATED by install.sh from bifrost.env.\nEDGE_PORT=%s\nEDGE_MODELS=%s\n' "$VOICE_PORT" "$V/models" >"$BF_CONF/voice.env.new"
    place_secret "$BF_CONF/voice.env.new" "$BF_CONF/voice.env" bifrost-voice.service "voice env (generated)"
    unit_from bifrost-voice.service
    FILES+=("$V/  755  voice server + venv; models/ fills on first start (~200 MB)")
    NET+=("github.com/k2-fsa/sherpa-onnx/releases (bifrost-voice FIRST START: whisper-tiny.en, silero VAD, piper fr+en voices)")
  fi
fi

# ----------------------------------------------------------------------------------- 5. livekit
if on livekit && [ "$LK_MODE" = binary ]; then
  case $(uname -m) in x86_64|amd64) LK_ARCH=amd64 ;; aarch64|arm64) LK_ARCH=arm64 ;; *) LK_ARCH= ;; esac
  if [ -n "${LIVEKIT_BINARY:-}" ]; then LK_SRC=$LIVEKIT_BINARY
  elif [ -x "$HERE/livekit-server" ]; then LK_SRC=$HERE/livekit-server
  elif [ -x "$BIN_DIR/livekit-server" ] && "$BIN_DIR/livekit-server" --version 2>/dev/null | grep -q " $LIVEKIT_VERSION\$"; then LK_SRC=$BIN_DIR/livekit-server
  elif [ -z "$LK_ARCH" ]; then die "no livekit-server build for $(uname -m) — set LIVEKIT_MODE=cloud in $BF_ENV"
  else
    T=$(mktemp -d); REL=https://github.com/livekit/livekit/releases/download/v$LIVEKIT_VERSION
    TGZ=livekit_${LIVEKIT_VERSION}_linux_$LK_ARCH.tar.gz
    say "livekit download $REL/$TGZ"
    curl -fsSL --retry 3 -o "$T/$TGZ" "$REL/$TGZ" && curl -fsSL --retry 3 -o "$T/checksums.txt" "$REL/checksums.txt" ||
      die "livekit-server download failed — check the network, or set LIVEKIT_MODE=cloud in $BF_ENV"
    (cd "$T" && grep " $TGZ\$" checksums.txt | sha256sum -c --quiet -) || die "livekit-server checksum mismatch — refusing to install"
    tar -xzf "$T/$TGZ" -C "$T" livekit-server
    LK_SRC=$T/livekit-server
    NET+=("github.com/livekit/livekit/releases v$LIVEKIT_VERSION (livekit-server $LK_ARCH, sha256 checked against checksums.txt)")
  fi
  install_bin "$LK_SRC" livekit-server bifrost-livekit.service
  [ -n "${T:-}" ] && rm -rf "$T"
  FILES+=("$BIN_DIR/livekit-server  755  LiveKit server v$LIVEKIT_VERSION")
  cat >"$BF_CONF/livekit.yaml.new" <<YAML
# GENERATED by install.sh (LIVEKIT_MODE=binary) from bifrost.env. Mode 600: holds the API secret.
port: $LK_PORT
bind_addresses:
  - 0.0.0.0
rtc:
  tcp_port: $LK_TCP
  udp_port: $LK_UDP
  use_external_ip: false
keys:
  $LK_KEY: $LK_SECRET
logging:
  level: info
YAML
  place_secret "$BF_CONF/livekit.yaml.new" "$BF_CONF/livekit.yaml" bifrost-livekit.service "LiveKit config (API key + secret)"
  unit_from bifrost-livekit.service
else
  OFF+=("bifrost-livekit.service")
fi

# ------------------------------------------------------------------------------------- 6. agent
AGENT_GO=0
if on agent; then
  if [ -z "$LK_PHONE" ] || [ -z "$LK_KEY" ]; then soft agent "LiveKit is not configured (LIVEKIT_MODE=cloud without URL/key)"
  elif need_python agent; then
    AGENT_GO=1
    AV=$BF_DATA/agent/venv
    mkdir -p "$BF_DATA/agent"
    [ -x "$AV/bin/python" ] || "$PY" -m venv "$AV"
    if ! same "$ROOT/agent/pyproject.toml" "$AV/.installed-pyproject"; then
      say "agent   installing livekit-agents into $AV (a few minutes)"
      NET+=("pypi.org (pip/uv: livekit-agents + plugins)")
      AGENT_DEPS=0
      if command -v uv >/dev/null; then
        (cd "$ROOT/agent" && UV_PROJECT_ENVIRONMENT=$AV uv sync --frozen --no-dev) && AGENT_DEPS=1
      else
        mapfile -t DEPS < <(sed -n '/^dependencies = \[/,/^\]/p' "$ROOT/agent/pyproject.toml" | sed -n 's/^ *"\(.*\)",\{0,1\}$/\1/p')
        [ ${#DEPS[@]} -gt 0 ] && "$AV/bin/pip" install --disable-pip-version-check -q "${DEPS[@]}" && AGENT_DEPS=1
      fi
      if [ $AGENT_DEPS = 1 ]; then
        NET+=("huggingface.co + github (agent.py download-files: silero VAD, turn-detector)")
        (cd "$ROOT/agent" && "$AV/bin/python" agent.py download-files) || warn "agent: model pre-download failed — it retries on start"
        cp "$ROOT/agent/pyproject.toml" "$AV/.installed-pyproject"
        CHANGED="${CHANGED}bifrost-agent.service "
      fi
      [ $AGENT_DEPS = 1 ] || { AGENT_GO=0; soft agent "pip could not install livekit-agents (output above) — fix and re-run"; }
    else say "agent   venv deps current"; fi
  fi
  if [ $AGENT_GO = 1 ]; then
    {
      echo "# GENERATED by install.sh from bifrost.env — edit that file and re-run install.sh. Mode 600."
      echo "LIVEKIT_URL=$LK_LOCAL"
      echo "LIVEKIT_API_KEY=$LK_KEY"
      echo "LIVEKIT_API_SECRET=$LK_SECRET"
      echo "OPENCODE_URL=$BRAIN_URL"
      echo "SPEACHES_URL=$SPEACHES"
      echo "AGENT_HTTP_PORT=$AGENT_PORT"
      for k in STT_MODEL TTS_MODEL TTS_VOICE VOICE_MODEL; do v=$(cfg "$k"); [ -n "$v" ] && echo "$k=$v"; done
    } >"$BF_CONF/agent.env.new"
    place_secret "$BF_CONF/agent.env.new" "$BF_CONF/agent.env" bifrost-agent.service "agent env (generated: LiveKit secret)"
    unit_from bifrost-agent.service
    FILES+=("$AV/  755  voice agent venv")
  fi
fi

# ----------------------------------------------------------------------------- start everything
BRAIN_READY=0; grep -q '^YGG_UPSTREAM_BASE_URL=.' "$ENV_FILE" 2>/dev/null && BRAIN_READY=1
STARTED=()
run_direct() { # unit — run the unit's own ExecStartPre/ExecStart with its environment, under nohup
  local u=$1 f=$UNIT_DIR/$1 wd=$HOME cmd= line k v
  local -a envs=() files=() pre=()
  while IFS= read -r line; do
    case $line in
      WorkingDirectory=*) wd=${line#*=} ;; Environment=*) envs+=("${line#*=}") ;;
      EnvironmentFile=*) files+=("${line#*=}") ;; ExecStartPre=*) pre+=("${line#*=}") ;; ExecStart=*) cmd=${line#*=} ;;
    esac
  done <"$f"
  [ -f "$RUN_DIR/$u.pid" ] && kill -- "-$(cat "$RUN_DIR/$u.pid")" 2>/dev/null && sleep 1
  (
    for e in "${envs[@]}"; do export "${e?}"; done
    for ef in "${files[@]}"; do
      while IFS= read -r line; do
        case $line in ''|\#*) continue ;; esac
        k=${line%%=*} v=${line#*=}
        [[ $k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && export "$k=$v"
      done <"$ef"
    done
    cd "$wd"
    local full=
    for p in "${pre[@]}"; do full="$full$p && "; done
    setsid nohup sh -c "${full}exec $cmd" >>"$LOG_DIR/$u.log" 2>&1 </dev/null &
    echo $! >"$RUN_DIR/$u.pid"
  )
}
if [ $START = 1 ]; then
  if [ $SYSTEMD_SEES = 1 ] && [ $DIRECT = 0 ]; then
    systemctl --user daemon-reload
    for u in "${OFF[@]}"; do
      [ -f "$UNIT_DIR/$u" ] && { systemctl --user disable --now "$u" >/dev/null 2>&1 || true; say "stopped $u (not part of this install)"; }
    done
    for u in "${UNITS[@]}"; do
      [ $u = yggdrasil.service ] && [ $BRAIN_READY = 0 ] && { warn "brain not started: set YGG_UPSTREAM_BASE_URL (+ YGG_UPSTREAM_API_KEY) in $ENV_FILE, then: systemctl --user restart yggdrasil"; systemctl --user enable -q "$u"; continue; }
      systemctl --user enable -q "$u"
      if ! systemctl --user is-active --quiet "$u" || [[ $CHANGED == *" $u "* ]]; then
        systemctl --user restart --no-block "$u"; say "start   $u"; STARTED+=("$u")
      else say "running $u (unchanged)"; fi
    done
  elif [ $DIRECT = 1 ]; then
    for u in "${OFF[@]}"; do [ -f "$RUN_DIR/$u.pid" ] && kill -- "-$(cat "$RUN_DIR/$u.pid")" 2>/dev/null; rm -f "$RUN_DIR/$u.pid"; done
    for u in "${UNITS[@]}"; do
      [ $u = yggdrasil.service ] && [ $BRAIN_READY = 0 ] && { warn "brain not started: set YGG_UPSTREAM_BASE_URL in $ENV_FILE and re-run"; continue; }
      if ours "$u" && [[ $CHANGED != *" $u "* ]]; then say "running $u (unchanged, pid $(cat "$RUN_DIR/$u.pid"))"
      else run_direct "$u"; say "start   $u (nohup, pid $(cat "$RUN_DIR/$u.pid"), log $LOG_DIR/$u.log)"; STARTED+=("$u"); fi
    done
  else
    warn "no systemd user session here (failure mode #2 in README.md) — the units are written but nothing was started."
    warn "fix: log in normally (or: sudo loginctl enable-linger $(id -un)), then re-run; or run them without systemd: ./install.sh --direct"
    START=0
  fi
fi

# ------------------------------------------------------------------------------- health checks
wait_http() { # url seconds → prints the http status (000 = nothing answered)
  local c=000; for _ in $(seq "$2"); do c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" || true); [ "$c" = 200 ] && break; sleep 1; done; echo "$c"
}
HEALTH=()
if [ $START = 1 ]; then
  say "health checks"
  APP_LOCAL=127.0.0.1; [ "$APP_HOST" = 0.0.0.0 ] || [ "$APP_HOST" = 127.0.0.1 ] || APP_LOCAL=$APP_HOST
  on brain && [ $BRAIN_READY = 1 ] && HEALTH+=("brain   $BRAIN_URL/session → $(wait_http "$BRAIN_URL/session" 20)")
  on bridge && HEALTH+=("bridge  http://127.0.0.1:$BRIDGE_PORT/identity → $(wait_http "http://127.0.0.1:$BRIDGE_PORT/identity" 20)")
  on app && HEALTH+=("app     http://$APP_LOCAL:$APP_PORT/pair → $(wait_http "http://$APP_LOCAL:$APP_PORT/pair" 60)")
  on livekit && [ "$LK_MODE" = binary ] && HEALTH+=("livekit http://127.0.0.1:$LK_PORT/ → $(wait_http "http://127.0.0.1:$LK_PORT/" 20)")
  if on voice && [ $VOICE_LOCAL = 1 ] && [ -f "$UNIT_DIR/bifrost-voice.service" ]; then
    c=$(wait_http "http://127.0.0.1:$VOICE_PORT/healthz" 5)
    [ "$c" = 200 ] || c="$c (first start downloads ~200 MB of models — check again in a few minutes)"
    HEALTH+=("voice   http://127.0.0.1:$VOICE_PORT/healthz → $c")
  fi
  for h in "${HEALTH[@]}"; do printf '    %s\n' "$h"; done
fi

# ---------------------------------------------------------------------------------- manifest
{
  echo "# bifrost install manifest — written by install.sh $(date -u +%FT%TZ). Re-written on every run."
  echo "# repo: $ROOT   mode: full stack   skipped: ${SKIP//,/ }"
  echo
  echo "[files]  (path  mode  what)"
  for f in "${FILES[@]}"; do echo "  $f"; done
  echo
  echo "[units]  ($UNIT_DIR, mode 644, no secrets inside)"
  for u in "${UNITS[@]}"; do echo "  $u"; done
  echo
  echo "[env key names]  (values live only in the 600 files above)"
  for f in "$ENV_FILE" "$BF_ENV" "$BF_CONF/app.env" "$BF_CONF/agent.env" "$BF_CONF/voice.env"; do
    [ -f "$f" ] && echo "  $f: $(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$f" | sort -u | tr '\n' ' ')"
  done
  echo
  echo "[network calls install.sh can make]  (each only when needed; nothing else is contacted)"
  echo "  registry.npmjs.org                      npm install for the app (when the app needs a build)"
  echo "  github.com/livekit/livekit/releases     livekit-server v$LIVEKIT_VERSION + checksums.txt (LIVEKIT_MODE=binary, once per version)"
  echo "  pypi.org                                voice server deps (sherpa-onnx, fastapi, uvicorn, numpy) and the agent's (livekit-agents)"
  echo "  huggingface.co, github.com              agent.py download-files: silero VAD + turn-detector models (with the agent deps)"
  echo "  crates.io                               cargo build — only when no prebuilt yggdrasil / bifrost-net is found"
  echo "  \$SPEACHES_URL/models                    reachability probe, only when SPEACHES_URL points at a remote speech server"
  echo
  echo "[network calls made by this run]"
  if [ ${#NET[@]} -eq 0 ]; then echo "  none (everything was already current)"; else for n in "${NET[@]}"; do echo "  $n"; done; fi
  echo
  echo "[network at runtime]"
  echo "  brain → your YGG_UPSTREAM_BASE_URL (the only outbound call in normal use)"
  echo "  bifrost-voice first start → github.com/k2-fsa/sherpa-onnx/releases (models, once)"
  [ "$LK_MODE" = cloud ] && echo "  app + agent → $LK_PHONE (LiveKit Cloud)"
  echo "  listening: app $APP_HOST:$APP_PORT · bridge 0.0.0.0:$BRIDGE_PORT + udp $LAN:$MEDIA_PORT · brain $BRAIN_LISTEN · voice 127.0.0.1:$VOICE_PORT$([ "$LK_MODE" = binary ] && echo " · livekit 0.0.0.0:$LK_PORT + tcp $LK_TCP + udp $LK_UDP") · agent :$AGENT_PORT"
  if [ ${#SOFT[@]} -gt 0 ]; then echo; echo "[skipped]"; for s in "${SOFT[@]}"; do echo "  $s"; done; fi
} >"$MANIFEST"
chmod 600 "$MANIFEST"
say "manifest $MANIFEST"

# ----------------------------------------------------------------------------------- next steps
cat <<EOF

bifrost is installed.  Config: $BF_ENV  ·  brain: $ENV_FILE
$( [ $BRAIN_READY = 1 ] || printf '\n  FIRST: set your model upstream in %s\n         (YGG_UPSTREAM_BASE_URL + YGG_UPSTREAM_API_KEY), then re-run ./install.sh\n' "$ENV_FILE")
  1. On THIS box, open   http://127.0.0.1:$APP_PORT/pair      (a QR code appears)
     headless box? from your laptop: ssh -L $APP_PORT:127.0.0.1:$APP_PORT <box>, then open the same URL
  2. Scan the QR with your phone's camera (same Wi-Fi). The phone opens
     http://$LAN:$APP_PORT, pairs itself and lands on your main session — no typing.
  3. Add it to the home screen from the browser menu.
EOF
if [ ${#SOFT[@]} -gt 0 ]; then echo; for s in "${SOFT[@]}"; do warn "skipped $s"; done; fi
if [ $SYSTEMD_SEES = 1 ] && [ $DIRECT = 0 ]; then
  echo "  Logs: journalctl --user -u 'bifrost-*' -u yggdrasil -f        Status: systemctl --user status 'bifrost-*' yggdrasil"
elif [ $DIRECT = 1 ]; then
  echo "  Logs: $LOG_DIR/<unit>.log    (direct mode: re-run ./install.sh --direct after a reboot)"
fi
for h in "${HEALTH[@]}"; do case $h in *"→ 200"*) ;; *voice*) ;; *) warn "not healthy yet: $h — see README.md 'When it fails'"; exit 1 ;; esac; done
exit 0
