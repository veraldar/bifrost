#!/usr/bin/env bash
# boot-world.sh — boot one scratch sim-world root: the SAME release binary as the live
# root (:4100), own data/proj dirs, never touching :4096/:4100/:8090. Pattern reused
# from lab/tool-policy/boot.sh (10-28, proven); brains:
#
#   boot-world.sh <tag> <port>              mock brain  (sim-mock :18190 — canned, free)
#   REAL=1 boot-world.sh <tag> <port>       real brain  (glm-5.3-flash via the coding-plan
#                                           upstream, key reused from lab/tool-policy)
#   QUOTA=1 boot-world.sh <tag> <port>      429 brain   (mock "mock-1310" → z.ai's exact
#                                           weekly-limit body — the quota outage injector)
#
# Env: WORLD_BIN, WORLD_DIR (default /tmp/simworld), YGG_MAX_STEPS, YGG_VOICE_MAX_WORDS.
set -euo pipefail
TAG="${1:?tag}"; PORT="${2:?port}"
BIN="${WORLD_BIN:-$HOME/Work/bifrost/lab/yggdrasil/target/release/yggdrasil}"
DIR="${WORLD_DIR:-/tmp/simworld}/$TAG"
mkdir -p "$DIR/data/session" "$DIR/proj"
PIDF="/tmp/simworld/$TAG.pid"
[ -x "$BIN" ] || { echo "boot-world: no binary at $BIN" >&2; exit 1; }
# a stale root on our port would eat the health check
OLDPID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLDPID:-}" ]; then kill "$OLDPID" 2>/dev/null || true; sleep 0.5; fi

if [ -n "${REAL:-}" ]; then
  UP="https://api.z.ai/api/anthropic"; STYLE=anthropic
  KEY="$(cat "$HOME/Work/bifrost/lab/tool-policy/upstream.key")"; MODEL=glm-5.3-flash
  BRAIN=real
elif [ -n "${QUOTA:-}" ]; then
  UP="http://127.0.0.1:18190"; STYLE=anthropic; KEY="mock-1310"; MODEL=glm-5.3-flash
  BRAIN=quota429
else
  UP="http://127.0.0.1:18190"; STYLE=anthropic; KEY="mock-key"; MODEL=glm-5.3-flash
  BRAIN=mock
fi

env YGG_UPSTREAM_BASE_URL="$UP" YGG_UPSTREAM_STYLE="$STYLE" YGG_UPSTREAM_API_KEY="$KEY" \
    YGG_UPSTREAM_MODEL="$MODEL" YGG_LISTEN="127.0.0.1:$PORT" \
    YGG_MAX_TOKENS=16384 YGG_DATA_DIR="$DIR/data" YGG_PROJECT_DIR="$DIR/proj" \
    YGG_ROLLUP_TOKENS=0 YGG_MAX_STEPS="${YGG_MAX_STEPS:-12}" \
    YGG_VOICE=1 YGG_VOICE_MAX_WORDS="${YGG_VOICE_MAX_WORDS:-60}" \
    "$BIN" >> "/tmp/simworld/$TAG.log" 2>&1 &
echo $! > "$PIDF"
for i in $(seq 1 60); do
  kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo "boot-world: $TAG($BRAIN) died on boot" >&2; tail -5 "/tmp/simworld/$TAG.log" >&2; exit 1; }
  curl -sf -m 2 "http://127.0.0.1:$PORT/session/status" >/dev/null 2>&1 && {
    echo "$TAG brain=$BRAIN port=$PORT pid=$(cat "$PIDF")"; exit 0; }
  sleep 0.25
done
echo "boot-world: $TAG($BRAIN) FAILED to answer on :$PORT" >&2; tail -5 "/tmp/simworld/$TAG.log" >&2; exit 1
