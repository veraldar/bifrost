#!/usr/bin/env bash
# v0.9 VALIDATION LADDER — the box (bifrost-net bridge + devices-mode PWA via
# server.mjs) + browser "devices" on THIS machine, then the S1 + ladder specs.
#
#   scripts/v09-ladder.sh [LAN_IP]
#
# LAN_IP = the address phones would dial (default: first 192.168/10. address).
# Ports: PWA :8095 (V09_PORT), bridge signaling :7890 + media udp :7891.
# Never touches live services (lk-pwa :8080 / opencode / LiveKit). Uses the live
# opencode brain (127.0.0.1:4096) with a disposable MAIN ("e2e-ladder-main",
# deleted at the end). State + logs: /tmp/v09-ladder (V09_STATE).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LAN_IP=${1:-$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 \
  | grep -E '^(192\.168\.|10\.)' | head -1)}
STATE=${V09_STATE:-/tmp/v09-ladder}
PORT=${V09_PORT:-8095}
BIN="$ROOT/lab/bifrost-net/target/release/bifrost-net"
[ $# -gt 0 ] && shift  # the rest goes to playwright
[ -n "$LAN_IP" ] || { echo "no LAN address found — pass one"; exit 2; }
[ -x "$BIN" ] || { echo "build the bridge first: (cd lab/bifrost-net && cargo build --release)"; exit 2; }
[ -d "$ROOT/pwa/.next" ] || { echo "build the PWA first: (cd pwa && npm run build)"; exit 2; }

mkdir -p "$STATE" && chmod 700 "$STATE"
rm -f "$STATE"/devices.json*   # a ladder run starts with zero paired devices
[ -s "$STATE/admin.token" ] || head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' >"$STATE/admin.token"
ADMIN="admin-$(cat "$STATE/admin.token")"
if [ ! -s "$STATE/bridge.toml" ] || ! grep -q "$LAN_IP" "$STATE/bridge.toml"; then
  KEY=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
  cat >"$STATE/bridge.toml" <<TOML
[node]
name = "$(hostname)"
private_key = "$KEY"

[bridge]
http = "0.0.0.0:7890"
media = "$LAN_IP:7891"
tokens_file = "$STATE/devices.json"
candidates = ["$LAN_IP"]
dtls_cert_file = "$STATE/bridge-dtls.json"
public_url = "http://$LAN_IP:7890"
TOML
fi
chmod 600 "$STATE"/*

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

"$BIN" bridge -c "$STATE/bridge.toml" >"$STATE/bridge.log" 2>&1 &
pids+=($!)
(
  cd "$ROOT/pwa"
  exec env BIFROST_AUTH=devices BIFROST_DEVICES_FILE="$STATE/devices.json" \
    BIFROST_ADMIN_TOKEN="$ADMIN" BIFROST_PUBLIC_URL="http://$LAN_IP:$PORT" \
    BIFROST_BRIDGE_URL=http://127.0.0.1:7890 BIFROST_MAIN_TITLE=e2e-ladder-main \
    BIFROST_ACCESS_TTL_S=30 BIFROST_PAIR_TTL_S=20 BIFROST_ROTATE_GRACE_S=2 \
    BIFROST_RATE_BURST=120 BIFROST_RATE_PER_SEC=2 PORT="$PORT" HOST=0.0.0.0 \
    node server.mjs
) >"$STATE/pwa.log" 2>&1 &
pids+=($!)

for _ in $(seq 60); do
  curl -sf "http://127.0.0.1:7890/identity" >/dev/null && curl -s -o /dev/null "http://127.0.0.1:$PORT/pair" && break
  sleep 1
done
echo "box up: pwa http://$LAN_IP:$PORT · bridge $(curl -s http://127.0.0.1:7890/identity)"

cd "$ROOT/pwa"
PW_BASE_URL="http://127.0.0.1:$PORT" PW_LAN_URL="http://$LAN_IP:$PORT" PW_DEVICES_MODE=1 \
  PW_MAIN_SLUG=e2e-ladder-main BIFROST_ADMIN_TOKEN="$ADMIN" \
  npx playwright test e2e/auth.spec.ts e2e/pair-ladder.spec.ts "$@" 2>&1 | tee "$STATE/e2e.log"
exit "${PIPESTATUS[0]}"
