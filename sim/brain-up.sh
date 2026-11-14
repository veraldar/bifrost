#!/usr/bin/env bash
# brain-up.sh NAME PORT [BIN] — a scratch yggdrasil brain for the human sim: real upstream
# (the live env's key), its own data dir + workspace under ~/.cache/root-sim/NAME, sandboxed
# (ProtectHome=tmpfs: only the workspace and the binary are visible under /home).
# brain-up.sh NAME down — stop it.   State: ~/.cache/root-sim/NAME/{data,work,brain.log}
set -euo pipefail
NAME=${1:?name}; PORT=${2:?port|down}
ROOT="$HOME/.cache/root-sim/$NAME"; UNIT="rootsim-$NAME"
if [ "$PORT" = down ]; then systemctl --user stop "$UNIT" 2>/dev/null || true; exit 0; fi
BIN=${3:-$(cd "$(dirname "$0")/../root" && pwd)/target/release/yggdrasil}
mkdir -p "$ROOT/data/session" "$ROOT/work/artifacts" "$ROOT/bin"
cp -f "$BIN" "$ROOT/bin/yggdrasil"           # frozen copy: a rebuild never swaps a running sim
[ -f "$ROOT/work/AGENTS.md" ] || cat > "$ROOT/work/AGENTS.md" <<MD
# Workspace

This computer's work area is \`$ROOT/work\`. Every project lives in its own folder here
(e.g. \`$ROOT/work/<project-name>\`); never write outside it. Tools available: bash, python3, node, git. Prefer the standard
library (python3 here is a venv with pytest: run tests with \`python3 -m pytest\`). The user talks from a phone and only sees chat text: report results in words, with
the commands you ran and what they printed.
MD
set -a; . "$HOME/.config/yggdrasil/yggdrasil.env"; set +a
# an agents file inside the root stays writable (the agent editor saves there); outside it, read-only
RO_PROFILES=""; case "${SIM_PROFILES:-}" in "") ;; "$ROOT"/*) ;; *) RO_PROFILES=" $SIM_PROFILES" ;; esac
# SIM_HARNESS=1: harness sessions (claude/opencode/codex/antigravity) need their logins + binaries
# inside the sandbox; opencode gets its own data dir (never the live opencode.db), auth copied in;
# agy (~/.local/bin) keeps its conversations in ~/.gemini, its Google sign-in in the keyring (D-Bus).
HARNESS_PROPS=(); HPATH=""; SIMHOME="$ROOT/work"
if [ "${SIM_HARNESS:-0}" = 1 ]; then
  mkdir -p "$ROOT/xdg/opencode" "$ROOT/xdgc" "$ROOT/xdg-cache" "$ROOT/xdg-state"
  install -m600 "$HOME/.local/share/opencode/auth.json" "$ROOT/xdg/opencode/auth.json" 2>/dev/null || true
  rsync -a --exclude node_modules "$HOME/.config/opencode/" "$ROOT/xdgc/opencode/" 2>/dev/null || true
  mkdir -p "$HOME/.gemini"
  HARNESS_PROPS=(-p "BindPaths=$HOME/.claude $HOME/.claude.json $HOME/.gemini" -p "BindReadOnlyPaths=$HOME/.local/share/mise"
    -p "BindReadOnlyPaths=-$HOME/.local/bin/agy"
    --setenv=XDG_CONFIG_HOME="$ROOT/xdgc" --setenv=XDG_CACHE_HOME="$ROOT/xdg-cache" --setenv=XDG_STATE_HOME="$ROOT/xdg-state")
  SIMHOME="$HOME"
  HPATH="$HOME/.local/share/mise/installs/claude/latest:$HOME/.local/share/mise/installs/opencode/latest:$HOME/.local/share/mise/installs/codex/latest/bin:$HOME/.local/bin:"
fi
systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
systemd-run --user --unit="$UNIT" --collect -q \
  -p ProtectHome=tmpfs -p "BindPaths=$ROOT" -p "BindReadOnlyPaths=$HOME/.cache/root-sim/_venv$RO_PROFILES" "${HARNESS_PROPS[@]}" \
  --setenv=XDG_DATA_HOME="$ROOT/xdg" \
  -p StandardOutput="append:$ROOT/brain.log" -p StandardError="append:$ROOT/brain.log" \
  --setenv=YGG_UPSTREAM_BASE_URL="$YGG_UPSTREAM_BASE_URL" --setenv=YGG_UPSTREAM_API_KEY="$YGG_UPSTREAM_API_KEY" \
  --setenv=YGG_UPSTREAM_STYLE="${YGG_UPSTREAM_STYLE:-anthropic}" --setenv=YGG_UPSTREAM_MODEL="${SIM_MODEL:-glm-5.3-flash}" \
  --setenv=YGG_MODELS="${SIM_MODELS:-glm-5.3-flash,glm-5.3,glm-5.2}" --setenv=YGG_VISION_MODELS="${SIM_VISION:-glm-5.3-flash}" --setenv=YGG_ARTIFACTS_DIR="$ROOT/work/artifacts" \
  --setenv=YGG_MAX_TOKENS="${YGG_MAX_TOKENS:-16384}" --setenv=YGG_THINK_HIGH="${YGG_THINK_HIGH:-8192}" \
  --setenv=YGG_DEFAULT_VARIANT="${SIM_VARIANT:-high}" --setenv=YGG_VOICE=1 \
  --setenv=YGG_LISTEN="127.0.0.1:$PORT" --setenv=YGG_DATA_DIR="$ROOT/data" --setenv=YGG_PROJECT_DIR="$ROOT/work" \
  --setenv=YGG_MAX_INFLIGHT="${SIM_INFLIGHT:-5}" --setenv=YGG_WAKE_DEBOUNCE_MS="${SIM_DEBOUNCE:-4000}" \
  ${SIM_PROFILES:+--setenv=YGG_PROFILES=$SIM_PROFILES} ${SIM_EXTENSIONS:+--setenv=YGG_EXTENSIONS=$SIM_EXTENSIONS} \
  ${YGG_ROOT_NAME:+--setenv=YGG_ROOT_NAME=$YGG_ROOT_NAME} ${YGG_PEERS:+--setenv=YGG_PEERS=$YGG_PEERS} \
  ${YGG_PEER_TOKEN:+--setenv=YGG_PEER_TOKEN=$YGG_PEER_TOKEN} ${YGG_ROOT_NOTE:+"--setenv=YGG_ROOT_NOTE=$YGG_ROOT_NOTE"} \
  --setenv=HOME="$SIMHOME" --setenv=PATH="$HPATH$HOME/.cache/root-sim/_venv/bin:/usr/local/bin:/usr/bin:/bin" --setenv=VIRTUAL_ENV="$HOME/.cache/root-sim/_venv" \
  "$ROOT/bin/yggdrasil"
for i in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$PORT/session" >/dev/null && { echo "brain $NAME up on :$PORT ($ROOT)"; exit 0; }; sleep 0.25; done
echo "brain $NAME did not come up"; tail -20 "$ROOT/brain.log"; exit 1
