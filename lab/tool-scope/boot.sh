#!/usr/bin/env bash
# boot.sh — one SCRATCH root for TOOL-SCOPE validation, as its own transient user unit.
# Usage: boot.sh <name> <port> <project-dir> [context-file] [seed-stale]
#   name     unit agg-tool-scope-<name>, store /tmp/tool-scope-store/<name> (throwaway)
#   port     4121-4124 only (never 4100/4101/4096)
#   context  YGG_CONTEXT_FILES (read-only; default: none = the project's AGENTS.md if any)
#   seed     "seed" = plant the tool-policy t1 fixture sessions (one 40-day-old, one fresh)
# Upstream = ~/.cache/tool-scope/scratch.env (z.ai anthropic, glm-5.3-flash, 16384 — the live
# root's model config; key from the tool-policy lab). The live env file is never loaded.
set -euo pipefail
NAME="${1:?name}"; PORT="${2:?port}"; PROJ="${3:?project dir}"; CTX="${4:-}"; SEED="${5:-}"
case "$PORT" in 4121|4122|4123|4124) ;; *) echo "port $PORT refused (scratch ports are 4121-4124)"; exit 2;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${TS_BIN:-$(ls -t ~/.cache/tool-scope/yggdrasil-* | head -1)}"
DATA="/tmp/tool-scope-store/$NAME"
UNIT="agg-tool-scope-$NAME"
case "$DATA" in /tmp/tool-scope-store/*) ;; *) echo "refusing store $DATA"; exit 2;; esac
mkdir -p "$DATA/session" "$PROJ"
if [ "$SEED" = seed ]; then
  python3 - "$DATA" <<'PY'
import json, sys, time
data = sys.argv[1]; now = int(time.time() * 1000)
for sid, t, title in [("ses_staleone", now - 40 * 24 * 3600 * 1000, "old drift sweep"),
                      ("ses_freshtwo", now - 3600_000, "yesterday's lab")]:
    sess = {"info": {"id": sid, "title": title, "time": {"created": t, "updated": t}, "parentID": "ses_fakeparent"},
            "messages": [{"info": {"id": "msg_x", "role": "user", "sessionID": sid, "time": {"created": t}},
                          "parts": [{"type": "text", "text": "hi"}]}], "todo": []}
    json.dump(sess, open(f"{data}/session/{sid}.json", "w"), indent=1)
PY
fi
systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
ENVS=(-E YGG_LISTEN="127.0.0.1:$PORT" -E YGG_DATA_DIR="$DATA" -E YGG_PROJECT_DIR="$PROJ"
      -E YGG_PROFILES="${TS_PROFILES:-$HERE/profiles.json}" -E YGG_MAX_STEPS="${TS_MAX_STEPS:-100}"
      -E YGG_ROLLUP_TOKENS="${TS_ROLLUP:-100000}")
[ -n "$CTX" ] && ENVS+=(-E YGG_CONTEXT_FILES="$CTX")
systemd-run --user --unit="$UNIT" --collect -q -p EnvironmentFile="$HOME/.cache/tool-scope/scratch.env" \
  -p StandardOutput="append:/tmp/tool-scope-store/$NAME.log" -p StandardError="append:/tmp/tool-scope-store/$NAME.log" \
  "${ENVS[@]}" "$BIN"
for _ in $(seq 1 50); do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/profile" >/dev/null 2>&1; then
    echo "$UNIT up on :$PORT ($(basename "$BIN"), store $DATA)"; exit 0
  fi
  sleep 0.2
done
echo "$UNIT FAILED on :$PORT"; tail -5 "/tmp/tool-scope-store/$NAME.log"; exit 1
