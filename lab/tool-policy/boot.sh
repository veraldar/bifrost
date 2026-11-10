#!/usr/bin/env bash
# boot.sh — boot one private lab root (the same release binary as the live root,
# :4100), pointed at a variant's scratch fixture + its own data dir. Never touches
# ~/Work or the live root's store. Usage: boot.sh <A|B|C> <port>
set -euo pipefail
V="${1:?variant}"; PORT="${2:?port}"
LAB="$(cd "$(dirname "$0")" && pwd)"
BIN="${BOOT_BIN:-/home/dweeb_xyz/Work/bifrost/lab/yggdrasil/target/release/yggdrasil}"
PROJ="/tmp/toolpolicy/$V"
DATA="/tmp/toolpolicy/$V/data"
mkdir -p "$DATA/session"
PIDF="/tmp/toolpolicy/$V.pid"
# kill anything already on our port (stale lab root would eat the health check)
OLDPID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLDPID:-}" ]; then kill "$OLDPID" 2>/dev/null; sleep 0.5; fi
# seed: one fake stale session so task 1 ("which sessions are stale?") has data
if [ ! -f "$DATA/session/ses_staleone.json" ]; then
  python3 - "$DATA" <<'PY'
import json, sys, time
data = sys.argv[1]
now = int(time.time() * 1000)
old = now - 40 * 24 * 3600 * 1000  # 40 days ago = stale
fresh = now - 3600_000
for sid, t, title in [("ses_staleone", old, "old drift sweep"),
                      ("ses_freshtwo", fresh, "yesterday's lab")]:
    sess = {"info": {"id": sid, "title": title,
                     "time": {"created": t, "updated": t},
                     "parentID": "ses_fakeparent"},
            "messages": [{"info": {"id": "msg_x", "role": "user",
                                   "sessionID": sid,
                                   "time": {"created": t}},
                          "parts": [{"type": "text", "text": "hi"}]}],
            "todo": []}
    with open(f"{data}/session/{sid}.json", "w") as f:
        json.dump(sess, f, indent=1)
PY
fi
# context file = the variant's policy prompt (yggdrasil injects it as the system message);
# {ROOT} in the prompt is replaced with this root's own port, so any delegation the
# variant attempts stays INSIDE the lab (never the live root on :4100)
PROMPT="${PROMPT_OVERRIDE:-$LAB/prompts/$V.md}"; sed "s/{ROOT}/$PORT/g" "$PROMPT" > "$PROJ/POLICY.md"
env YGG_UPSTREAM_BASE_URL="https://api.z.ai/api/anthropic" \
    YGG_UPSTREAM_STYLE=anthropic \
    YGG_UPSTREAM_API_KEY="$(cat "$LAB/upstream.key")" \
    YGG_UPSTREAM_MODEL=glm-5.3-flash \
    YGG_LISTEN="127.0.0.1:$PORT" \
    YGG_MAX_TOKENS=16384 \
    YGG_DATA_DIR="$DATA" \
    YGG_PROJECT_DIR="$PROJ" \
    YGG_CONTEXT_FILES="$PROJ/POLICY.md" \
    YGG_ROLLUP_TOKENS=0 \
    YGG_MAX_STEPS="${YGG_MAX_STEPS:-12}" \
    "$BIN" >> "/tmp/toolpolicy/$V.log" 2>&1 &
echo $! > "$PIDF"
for i in $(seq 1 50); do
  kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo "variant $V process died on boot"; tail -5 "/tmp/toolpolicy/$V.log"; exit 1; }
  if curl -s -m 2 "http://127.0.0.1:$PORT/session/status" >/dev/null 2>&1; then
    echo "variant $V up on :$PORT (pid $(cat "$PIDF"))"; exit 0
  fi
  sleep 0.2
done
echo "variant $V FAILED to boot on :$PORT"; tail -5 "/tmp/toolpolicy/$V.log"; exit 1
