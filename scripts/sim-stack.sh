#!/usr/bin/env bash
# sim-stack.sh up|down|status — the SIMULATED stack (Rule 10-09: only simulation is proof).
#
# The shipping pieces, isolated: the served sandbox build (pwa/.next, copied without its
# cache — same BUILD_ID) and the yggdrasil release binary, each under a transient systemd
# unit with its production unit's restart policy (+ the brain's hardening), against the
# yggdrasil mock LLM (lab/yggdrasil/mock) instead of the rate-limited real provider. Kills,
# reconnect storms and turn volume land here — never on the user's stack (:8090/:4100,
# :8080/:4096 untouched). Own ports (loopback only), own data dirs, own proxy queue file.
#
#   units    sim-mock (:18190) · sim-ygg (:4111) · sim-pwa (:8096)
#   state    $SIM_DIR (default /tmp/bifrost-sim): ygg/ (brain store) proj/ pwa/ artifacts/
#   voice    token mints dispatch to agent "sim-none" — no worker serves it, so no real
#            voice agent ever joins a sim room (the LiveKit server is the real one)
#
# Env: SIM_DIR, SIM_FRESH=1 (up: wipe the brain store first), SIM_STALL_MS (the proxy's stall
# window, default production 10 min — watchdog-zombie.spec needs 20000). Exit 0 = all three answer.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
YGG_DIR=${YGG_DIR:-$HOME/Work/bifrost/lab/yggdrasil}
SIM=${SIM_DIR:-/tmp/bifrost-sim}
NODE=$(command -v node)
MOCK_PORT=18190 BRAIN=127.0.0.1:4111 APP_PORT=8096
UNITS=(sim-pwa sim-ygg sim-mock)

wait_http() { # url secs
  for _ in $(seq $(($2 * 4))); do curl -sf -o /dev/null "$1" && return 0; sleep 0.25; done
  echo "sim-stack: $1 did not answer in $2s" >&2; return 1
}

down() {
  for u in "${UNITS[@]}"; do
    systemctl --user stop "$u" 2>/dev/null || true
    systemctl --user reset-failed "$u" 2>/dev/null || true
  done
}

up() {
  down
  [ -n "${SIM_FRESH:-}" ] && rm -rf "$SIM/ygg"
  mkdir -p "$SIM"/{ygg,proj,artifacts,pwa}
  # the build under test: the sandbox's own .next, minus the 900 MB build cache
  rsync -a --delete --exclude cache "$ROOT/pwa/.next/" "$SIM/pwa/.next/"
  rsync -a --delete "$ROOT/pwa/public/" "$SIM/pwa/public/"
  cp "$ROOT/pwa/package.json" "$ROOT/pwa/next.config.ts" "$SIM/pwa/"
  ln -sfn "$ROOT/pwa/node_modules" "$SIM/pwa/node_modules"
  # the sandbox's client env (LiveKit keys, VAPID) with the sim's own seams
  grep -vE '^(OPENCODE_URL|AGENT_NAME|AGENT_DISPATCH_NAME)=' "$ROOT/pwa/.env.local" >"$SIM/pwa/.env.local"
  printf 'OPENCODE_URL=http://%s\nAGENT_NAME=sim-none\nAGENT_DISPATCH_NAME=sim-none\n' "$BRAIN" >>"$SIM/pwa/.env.local"
  rm -f "$SIM/pwa/.oc-queue.json"

  systemd-run --user -q --unit=sim-mock --collect -p Restart=on-failure \
    python3 "$YGG_DIR/mock/mock_upstream.py" $MOCK_PORT
  # lk-yggdrasil.service's restart policy + hardening, verbatim
  systemd-run --user -q --unit=sim-ygg -p Type=exec -p Restart=on-failure -p RestartSec=2 \
    -p RestartPreventExitStatus=2 -p NoNewPrivileges=yes -p LockPersonality=yes \
    -p RestrictRealtime=yes -p RestrictSUIDSGID=yes -p RestrictNamespaces=yes \
    -p MemoryDenyWriteExecute=yes -p SystemCallArchitectures=native -p UMask=0077 \
    -p WorkingDirectory="$SIM/proj" \
    -E YGG_UPSTREAM_BASE_URL=http://127.0.0.1:$MOCK_PORT -E YGG_UPSTREAM_STYLE=anthropic \
    -E YGG_UPSTREAM_API_KEY=mock-key -E YGG_UPSTREAM_MODEL=glm-5.3-flash \
    -E YGG_LISTEN=$BRAIN -E YGG_DATA_DIR="$SIM/ygg" -E YGG_PROJECT_DIR="$SIM/proj" \
    -E YGG_MAX_TOKENS=16384 -E YGG_VOICE=1 -E YGG_VOICE_MAX_WORDS=60 \
    "$YGG_DIR/target/release/yggdrasil"
  # bifrost-sandbox.service's restart policy
  local stall=()
  [ -n "${SIM_STALL_MS:-}" ] && stall=(-E OC_STALL_MS="$SIM_STALL_MS")
  systemd-run --user -q --unit=sim-pwa -p Restart=on-failure -p RestartSec=5 "${stall[@]}" \
    -p WorkingDirectory="$SIM/pwa" \
    -E PORT=$APP_PORT -E HOST=127.0.0.1 -E OPENCODE_URL=http://$BRAIN -E BIFROST_AUTH=tailnet \
    -E ARTIFACTS_DIR="$SIM/artifacts" -E NODE_ENV=production \
    "$NODE" node_modules/next/dist/bin/next start -p $APP_PORT -H 127.0.0.1
  wait_http "http://127.0.0.1:$MOCK_PORT/calls" 10
  wait_http "http://$BRAIN/session" 15
  wait_http "http://127.0.0.1:$APP_PORT/api/build" 40
  status
}

status() {
  for u in "${UNITS[@]}"; do
    printf '%-9s %-8s pid=%s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null || true)" \
      "$(systemctl --user show -p MainPID --value "$u" 2>/dev/null || echo -)"
  done
  echo "build $(curl -sf http://127.0.0.1:$APP_PORT/api/build || echo DOWN) (sandbox .next/BUILD_ID $(cat "$ROOT/pwa/.next/BUILD_ID"))"
}

case "${1:-}" in
  up) up ;;
  down) down; echo "sim stack down" ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
