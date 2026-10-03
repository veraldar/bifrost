#!/usr/bin/env bash
# flip-ygg.sh — the invisible version flip (req 10-03, ops/flip-automation).
#
# One command: lab the phone on the yggdrasil binary for a bounded window,
# then flip back — the phone NEVER needs manual action:
#   - refuses while a run is in flight (a restart would orphan it)
#   - builds + starts lab/yggdrasil on 127.0.0.1:4100 (its own data dir;
#     upstream from scripts/flip-ygg.env, else the lab mock)
#   - flips OPENCODE_URL in the LIVE pwa/.env.local + agent/.env → :4100
#   - restarts lk-pwa + lk-agent (the M1 client makes the blip invisible:
#     bounded retry, hands-free re-arms on return)
#   - health-checks (ygg direct + through the proxy + agent active);
#     any failure → immediate flip-back + loud push
#   - when the window ends (default 300s, --window N): drain runs, flip
#     back to opencode, restart, health-check, push "done"
#   - Ctrl-C / crash: the EXIT trap still flips back — the box can never
#     be stranded on the lab binary
#
# Usage: scripts/flip-ygg.sh [--window SECONDS]
# Push on start/done/failure via pwa/scripts/flip-notify.mjs (lib/push.ts
# pattern: same VAPID keys, same .push-subs.json, same pruning).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"     # this worktree (builds yggdrasil)
LIVE="${HOME}/Work/bifrost"                  # the live deployment this box serves
YGG="127.0.0.1:4100"
YGG_LOG=/tmp/opencode/flip-ygg.log
WINDOW=300

say()  { echo "[flip-ygg] $*"; }
fail() { say "FAIL: $*"; exit 1; }
probe() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) WINDOW="${2:?}"; shift 2 ;;
    *) fail "unknown arg: $1 (usage: flip-ygg.sh [--window SECONDS])" ;;
  esac
done

YGG_PID=""; MOCK_PID=""
FLIPPED=0

# --- pushes (lib/push.ts pattern) ---------------------------------------------
notify() {
  (cd "$REPO/pwa" && node scripts/flip-notify.mjs "$LIVE/pwa" "$1") || true
}

# --- in-flight guard: a restart orphans a live run (deploy.sh rule) -----------
runs_in_flight() {
  python3 - "$LIVE/pwa/.oc-live.json" << 'EOF'
import json, sys, time, pathlib
try:
    live = json.loads(pathlib.Path(sys.argv[1]).read_text())
    print(sum(1 for v in live.values() if time.time() - v / 1000 < 30 * 60))
except Exception:
    print(0)
EOF
}
runs_in_agent() { # live agent/.env marks its live run window in .oc-live.json too
  python3 - "$LIVE/agent/.oc-live.json" << 'EOF' 2>/dev/null
import json, sys, time, pathlib
try:
    live = json.loads(pathlib.Path(sys.argv[1]).read_text())
    print(sum(1 for v in live.values() if time.time() - v / 1000 < 30 * 60))
except Exception:
    print(0)
EOF
}
wait_quiet() { # drain: wait ≤60s for runs to settle before touching services
  for _ in $(seq 12); do
    local n; n=$(( $(runs_in_flight) + $(runs_in_agent) ))
    [[ "$n" == "0" ]] && return 0
    say "$n run(s) in flight — draining (60s max)…"
    sleep 5
  done
  return 1
}

# --- flip state ---------------------------------------------------------------
flip_envs() { # $1 = to (http://…) — flips OPENCODE_URL in the live env files
  local to="$1"
  for f in "$LIVE/pwa/.env.local" "$LIVE/agent/.env"; do
    [[ -f "$f" ]] || fail "missing $f"
    if grep -q '^OPENCODE_URL=' "$f"; then
      sed -i "s|^OPENCODE_URL=.*|OPENCODE_URL=$to|" "$f"
    else
      printf '\nOPENCODE_URL=%s\n' "$to" >> "$f"
    fi
  done
}
snapshot_envs() {
  for f in "$LIVE/pwa/.env.local" "$LIVE/agent/.env"; do cp "$f" "$f.pre-flip"; done
}
restore_envs() {
  for f in "$LIVE/pwa/.env.local" "$LIVE/agent/.env"; do
    [[ -f "$f.pre-flip" ]] && cp "$f.pre-flip" "$f" && rm "$f.pre-flip"
  done
}
restart_services() {
  systemctl --user restart lk-pwa lk-agent && sleep 5
  systemctl --user is-active --quiet lk-pwa lk-agent
}
health() { # ygg direct + through the proxy + agent alive
  [[ "$(probe "http://$YGG/session")" == "200" ]] || return 1
  [[ "$(probe http://127.0.0.1:8080/)" == "200" ]] || return 1
  [[ "$(probe http://127.0.0.1:8080/api/session)" == "200" ]] || return 1
  systemctl --user is-active --quiet lk-agent || return 1
}

flip_back() { # idempotent — EXIT trap may call it after a manual flip-back
  (( FLIPPED )) || return 0
  FLIPPED=0
  say "flipping back to opencode…"
  restore_envs
  if ! restart_services; then
    notify "flip FAILED — opencode restored but services are red. Manual attention needed."
    fail "services red after flip-back"
  fi
  if ! health; then
    # ygg may still be listening (env flipped back but proxy died) — the
    # opencode health path is what matters: proxy + session list on 4096
    [[ "$(probe http://127.0.0.1:4096/session)" == "200" ]] \
      || notify "flip FAILED — opencode unreachable on 4096. Manual attention needed."
  fi
  [[ -n "$YGG_PID" ]] && kill "$YGG_PID" 2>/dev/null
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  say "OK — back on opencode (4096). yggdrasil session store kept in lab/yggdrasil/ygg-data"
}
trap flip_back EXIT INT TERM

# --- preflight ----------------------------------------------------------------
[[ -d "$LIVE/pwa" ]] || fail "live deployment not found at $LIVE"
grep -q '4100' "$LIVE/pwa/.env.local" && fail "already flipped? OPENCODE_URL points at 4100 — run the flip-back first"
[[ "$(probe http://127.0.0.1:4096/session)" == "200" ]] || fail "opencode (4096) is down — fix the base before flipping"
systemctl --user is-active --quiet lk-pwa lk-agent || fail "lk-pwa/lk-agent not active — broken base state"
N=$(runs_in_flight); [[ "$N" == "0" ]] || fail "$N run(s) in flight — wait, then retry (a flip orphans live runs)"

# --- build + start yggdrasil --------------------------------------------------
say "building yggdrasil (release)…"
source ~/.cargo/env 2>/dev/null || fail "no rust toolchain (source ~/.cargo/env)"
(cd "$REPO/lab/yggdrasil" && cargo build -q --release) || fail "yggdrasil build failed"
mkdir -p "$REPO/lab/yggdrasil/ygg-data"

UPSTREAM_ENV="$REPO/scripts/flip-ygg.env"
if [[ -f "$UPSTREAM_ENV" ]]; then
  set -a; source "$UPSTREAM_ENV"; set +a
  say "upstream: ${YGG_UPSTREAM_BASE_URL:-?} (model ${YGG_UPSTREAM_MODEL:-gpt-4o-mini})"
  [[ -n "${YGG_UPSTREAM_BASE_URL:-}" ]] || fail "flip-ygg.env set but YGG_UPSTREAM_BASE_URL empty"
else
  say "no scripts/flip-ygg.env — using the LAB MOCK upstream (mock replies, real flip path)"
  python3 "$REPO/lab/yggdrasil/mock/mock_upstream.py" 18081 >/tmp/opencode/flip-mock.log 2>&1 &
  MOCK_PID=$!
  export YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18081/v1 YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock
fi

YGG_LISTEN="$YGG" YGG_DATA_DIR="$REPO/lab/yggdrasil/ygg-data" \
  nohup "$REPO/lab/yggdrasil/target/release/yggdrasil" >"$YGG_LOG" 2>&1 &
YGG_PID=$!
for _ in $(seq 30); do [[ "$(probe "http://$YGG/session")" == "200" ]] && break; sleep 0.5; done
[[ "$(probe "http://$YGG/session")" == "200" ]] || fail "yggdrasil did not come up on $YGG (log: $YGG_LOG)"

# --- the flip -----------------------------------------------------------------
say "flipping OPENCODE_URL → $YGG (window ${WINDOW}s)…"
snapshot_envs
FLIPPED=1
flip_envs "http://$YGG"
restart_services || { flip_back; fail "services red after flip — restored"; }
health || { flip_back; notify "flip ABORTED — health-check red on yggdrasil; opencode restored."; fail "health-check failed on yggdrasil"; }
notify "flip: yggdrasil is serving (window ${WINDOW}s) — flips back on its own; hands-free stays hands-free"
say "live on yggdrasil. window: ${WINDOW}s (Ctrl-C = flip back now)"

# --- the window ----------------------------------------------------------------
sleep "$WINDOW" & WPID=$!
wait $WPID

# --- flip back ------------------------------------------------------------------
wait_quiet || notify "flip: runs still in flight at window end — flipping back anyway, the client heals aborted runs"
flip_back
notify "flip done: back on opencode — hands-free re-armed itself. yggdrasil session store: lab/yggdrasil/ygg-data"
trap - EXIT INT TERM
say "done — one flip, zero phone touches"
