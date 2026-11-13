#!/usr/bin/env bash
# v0.9 PAIRING LADDER — the whole box in a PRIVATE network namespace (unshare -rn,
# like root/run-e2e.sh): loopback + a dummy "LAN" 192.168.77.2/24, so nothing here
# can touch a host port or a live service. Then the pairing specs.
#
#   mock upstream → yggdrasil (root/) → the app (`node server.mjs`, BIFROST_AUTH=devices)
#   → the v0.9 bifrost-net bridge (/identity, DTLS key the QR pins; root-link dial-in
#   plane on loopback for join.spec) → playwright:
#   branch/e2e/auth.spec.ts, pair-ladder.spec.ts, bridge.spec.ts (or the specs you name)
#
#   scripts/v09-ladder.sh [spec...]          (BIFROST_NET_BIN overrides the bridge binary)
#
# Needs: branch built (npm run build), trunk/target/release/bifrost-net (cd trunk && cargo build
# --release — the merged v0.9 bridge: /identity, the v2 registry), root/target/release/yggdrasil
# (YGG_BIN), zbarimg, playwright's chromium.
# State + logs: V09_STATE (default: a fresh mktemp dir, printed at the end).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${V09_NETNS:-}" ]; then
  exec unshare -rn env V09_NETNS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
B=$ROOT/branch
[ -x "$BIN" ] || { echo "build the bridge first: (cd trunk && cargo build --release), or set BIFROST_NET_BIN"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }
command -v zbarimg >/dev/null || { echo "zbarimg missing (zbar) — pair-ladder decodes the QR"; exit 2; }

ip link set lo up
ip link add d0 type dummy
ip addr add 192.168.77.2/24 dev d0
ip link set d0 up
LAN=192.168.77.2
APP=18195 YGG=18196 MOCK=18197 BR=18198 MEDIA=18199 RL=18200
STATE=${V09_STATE:-$(mktemp -d /tmp/v09-ladder.XXXXXX)}
mkdir -p "$STATE"/{ygg,proj} && chmod 700 "$STATE"
rm -f "$STATE"/devices.json* "$STATE"/roots.json*   # zero paired devices, zero joined roots
ADMIN="admin-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
# root-link HMAC secret (bridge.toml only — the app reads it from there) + the brain's peer token
RLSECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
PEER="peer-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT

python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$STATE/mock.log" 2>&1 &
pids+=($!)
# env -i: the brain must not pick up this machine's real provider config or key
env -i PATH="$PATH" HOME="$STATE" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK/v1" \
  YGG_UPSTREAM_MODEL=mock YGG_UPSTREAM_API_KEY=mock-key YGG_CATALOG="$ROOT/root/fixtures/catalog.json" \
  YGG_PROVIDERS="$STATE/none.json" YGG_DATA_DIR="$STATE/ygg" YGG_PROJECT_DIR="$STATE/proj" \
  YGG_ARTIFACTS_DIR="$STATE/artifacts" YGG_LISTEN="127.0.0.1:$YGG" YGG_PEER_TOKEN="$PEER" \
  "$YGG_BIN" >"$STATE/ygg.log" 2>&1 &
pids+=($!)

KEY=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat >"$STATE/bridge.toml" <<TOML
[node]
name = "ladder-box"
private_key = "$KEY"

[bridge]
http = "0.0.0.0:$BR"
media = "$LAN:$MEDIA"
tokens_file = "$STATE/devices.json"
opencode_url = "http://127.0.0.1:$YGG"
candidates = ["$LAN"]
dtls_cert_file = "$STATE/bridge-dtls.json"
public_url = "http://$LAN:$BR"
root_link_secret = "$RLSECRET"

[bridge.root-link]
enabled = true
listen = "127.0.0.1:$RL"
TOML
chmod 600 "$STATE/bridge.toml"
"$BIN" bridge -c "$STATE/bridge.toml" >"$STATE/bridge.log" 2>&1 &
pids+=($!)

# the timings auth.spec assumes: 30 s access tokens, 20 s pairing codes, 2 s race grace
(
  cd "$B"
  exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    BIFROST_AUTH=devices BIFROST_DEVICES_FILE="$STATE/devices.json" \
    BIFROST_ADMIN_TOKEN="$ADMIN" BIFROST_PUBLIC_URL="http://$LAN:$APP" \
    BIFROST_BRIDGE_URL="http://127.0.0.1:$BR" BIFROST_MAIN_TITLE=e2e-ladder-main \
    OPENCODE_URL="http://127.0.0.1:$YGG" ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= \
    BIFROST_ACCESS_TTL_S=30 BIFROST_PAIR_TTL_S=20 BIFROST_ROTATE_GRACE_S=2 \
    BIFROST_RATE_BURST=120 BIFROST_RATE_PER_SEC=2 PORT="$APP" HOST=0.0.0.0 \
    BIFROST_NET_BIN="$BIN" BIFROST_BRIDGE_CONFIG="$STATE/bridge.toml" \
    BIFROST_ROOTLINK_URL="ws://127.0.0.1:$RL/rootlink" YGG_PEER_TOKEN="$PEER" BIFROST_JOIN_TTL_S=20 \
    node server.mjs
) >"$STATE/app.log" 2>&1 &
pids+=($!)

for _ in $(seq 90); do
  curl -sf "http://127.0.0.1:$BR/identity" >/dev/null &&
    curl -sf -o /dev/null "http://127.0.0.1:$APP/pair" &&
    curl -sf -o /dev/null "http://127.0.0.1:$YGG/session" && break
  sleep 1
done
echo "box up: app http://$LAN:$APP · brain :$YGG · bridge $(curl -s "http://127.0.0.1:$BR/identity")"

cd "$B"
SPECS=("$@")
[ ${#SPECS[@]} -gt 0 ] || SPECS=(e2e/auth.spec.ts e2e/pair-ladder.spec.ts e2e/bridge.spec.ts)
set +e
PW_BASE_URL="http://127.0.0.1:$APP" PW_LAN_URL="http://$LAN:$APP" PW_DEVICES_MODE=1 \
  PW_MAIN_SLUG=e2e-ladder-main BIFROST_ADMIN_TOKEN="$ADMIN" \
  PW_V09_STATE="$STATE" PW_PEER_TOKEN="$PEER" PW_JOIN_TTL_S=20 \
  npx playwright test "${SPECS[@]}" 2>&1 | tee "$STATE/e2e.log"
rc=${PIPESTATUS[0]}
# invariant 5: only hashes at rest
echo "raw credentials in devices.json: $(grep -cE '"bfn[dpr]-' "$STATE/devices.json" || true) · mode $(stat -c %a "$STATE/devices.json")"
[ -f "$STATE/roots.json" ] && echo "roots.json: $(grep -c '"secretHash"' "$STATE/roots.json") root(s), hashes only · mode $(stat -c %a "$STATE/roots.json")"
echo "state + logs: $STATE"
exit "$rc"
