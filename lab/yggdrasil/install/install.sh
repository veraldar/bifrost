#!/usr/bin/env bash
# Install yggdrasil as a systemd user service. Idempotent: safe to re-run.
#
#   ./install.sh          install/upgrade the binary, unit, and env template (does not start anything)
#   ./install.sh --now    same, then enable and (re)start the service
#
# This touches only these paths (override with env vars):
#   $BIN_DIR/yggdrasil                                   BIN_DIR default ~/.local/bin
#   $XDG_CONFIG_HOME/yggdrasil/yggdrasil.env             created once, never overwritten
#   $XDG_CONFIG_HOME/systemd/user/yggdrasil.service      regenerated (replaced only if changed)
#   $XDG_DATA_HOME/yggdrasil/                            session store (created empty)
# Binary source, first match wins: $YGG_BINARY, ./yggdrasil next to this script,
# or `cargo build --release` of the crate one directory up.
set -euo pipefail

NOW=0
for a in "$@"; do
  case $a in
    --now) NOW=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 64 ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
CRATE=$(dirname "$HERE")
BIN_DIR=${BIN_DIR:-$HOME/.local/bin}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONF_DIR=$CONFIG_HOME/yggdrasil
UNIT_DIR=$CONFIG_HOME/systemd/user
DATA_DIR=$DATA_HOME/yggdrasil
ENV_FILE=$CONF_DIR/yggdrasil.env
UNIT=$UNIT_DIR/yggdrasil.service

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# 1. binary
if [ -n "${YGG_BINARY:-}" ]; then
  SRC=$YGG_BINARY
elif [ -x "$HERE/yggdrasil" ]; then
  SRC=$HERE/yggdrasil
else
  if ! command -v cargo >/dev/null; then
    # shellcheck disable=SC1091
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  fi
  command -v cargo >/dev/null || { echo "no prebuilt binary and no cargo. Install Rust (pacman -S rust, or rustup) and re-run" >&2; exit 1; }
  say "building release binary (cargo build --release --locked)"
  cargo build --release --locked --manifest-path "$CRATE/Cargo.toml"
  SRC=$CRATE/target/release/yggdrasil
fi
[ -x "$SRC" ] || { echo "binary not found or not executable: $SRC" >&2; exit 1; }

mkdir -p "$BIN_DIR" "$CONF_DIR" "$UNIT_DIR" "$DATA_DIR/session"
chmod 700 "$CONF_DIR" "$DATA_DIR"
# Copy then rename, so a running service's binary is replaced atomically ("text file busy" safe).
if cmp -s "$SRC" "$BIN_DIR/yggdrasil"; then
  say "binary  $BIN_DIR/yggdrasil (unchanged)"
else
  install -m 755 "$SRC" "$BIN_DIR/.yggdrasil.new"
  mv -f "$BIN_DIR/.yggdrasil.new" "$BIN_DIR/yggdrasil"
  say "binary  $BIN_DIR/yggdrasil ($(du -h "$BIN_DIR/yggdrasil" | cut -f1)) — restart the service to pick it up"
fi

# 2. env file: create once. Your upstream URL and key survive re-runs.
if [ -e "$ENV_FILE" ]; then
  say "config  $ENV_FILE (kept)"
else
  sed "s|@DATA@|$DATA_DIR|" "$HERE/yggdrasil.env.example" >"$ENV_FILE.new"
  chmod 600 "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
  say "config  $ENV_FILE (new; set YGG_UPSTREAM_BASE_URL)"
fi

# 3. unit: regenerated from the template, replaced only if the content changed.
sed -e "s|@BIN@|$BIN_DIR/yggdrasil|" -e "s|@ENV@|$ENV_FILE|" "$HERE/yggdrasil.service" >"$UNIT.new"
if cmp -s "$UNIT.new" "$UNIT"; then rm -f "$UNIT.new"; say "unit    $UNIT (unchanged)"
else mv -f "$UNIT.new" "$UNIT"; say "unit    $UNIT"; fi
say "data    $DATA_DIR"

# 4. systemd: the user manager reads only ~/.config/systemd/user (its own XDG_CONFIG_HOME).
#    For any other prefix, link the unit yourself (see README).
SYSTEMD_SEES=0
if [ "$UNIT_DIR" = "$HOME/.config/systemd/user" ] && systemctl --user show-environment >/dev/null 2>&1; then
  SYSTEMD_SEES=1
  systemctl --user daemon-reload
fi
if [ $NOW = 1 ]; then
  [ $SYSTEMD_SEES = 1 ] || { echo "--now: the user manager does not read $UNIT_DIR (or has no session bus); not starting" >&2; exit 1; }
  grep -q '^YGG_UPSTREAM_BASE_URL=.' "$ENV_FILE" || { echo "--now: set YGG_UPSTREAM_BASE_URL in $ENV_FILE first" >&2; exit 1; }
  systemctl --user enable yggdrasil.service
  systemctl --user restart yggdrasil.service
  say "service enabled and (re)started"
fi

LISTEN=$(sed -n 's/^YGG_LISTEN=//p' "$ENV_FILE" | tail -1); LISTEN=${LISTEN:-127.0.0.1:4096}
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
  Logs: journalctl --user -u yggdrasil -f
EOF
