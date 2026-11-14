#!/usr/bin/env bash
# trunk-full-e2e.sh — the WHOLE tree end to end, with a simulated phone, deterministic, on this
# machine, inside private namespaces (unshare: user + net + mount + pid — no live port is
# touched, every process dies with the run, /etc/hosts is ours for the run only).
#
#   "internet" 198.51.100.7  ap.tree.test:443   bifrost-net ap (TLS, self-signed test cert)
#                                 ▲         ▲                      ▲
#   the phone (Playwright Chromium, Pixel 7) │                      │ wss /rootlink (link token)
#     talks ONLY to https://ap.tree.test     │ dial-OUT (pinned)    │
#                                            │                      │
#   HUB box (loopback):  bridge ─────────────┘           new machine "mac" (203.0.113.9):
#     root-link + switchboard + [ap] + /branch            trunk-full-joiner.py → POST /api/roots/join
#     app  node server.mjs  BIFROST_AUTH=devices             (through the ap), QR → phone approves,
#          (join env: BIFROST_NET_BIN, BRIDGE_CONFIG,         polls → 20 link tokens → its brain
#           ROOTLINK_URL=wss://ap…/rootlink, PEER token)      (yggdrasil on the mock) + root-dial.py
#     brain "home" (yggdrasil on root/mock/mock_upstream.py)    --tls --cafile --path /rootlink
#       YGG_PEERS_FROM=bridge /_roots: learns joined roots      --brain --peer-port
# Steps (branch/e2e/trunk-full.spec.ts): 1 pair by QR through the ap → home (the list) · 1d a fresh
# phone pairs → the door → a typed first turn → "you are in" · 1v voice over the trunk is one calm
# line, never an error box or a retry storm · 2 MAIN answers the phone ·
# 3 join by QR, approved on the phone, the root links through the ap · 4 MAIN delegates to the
# joined root over the trunk, the report comes home, the phone sees it · 5 the phone talks to the
# joined root directly (/branch through the ap) · 6 revoke from the box console → refused.
#
#   sim/trunk-full-e2e.sh            exit 0 = every step PASS; prints the PASS/FAIL table
#
# Needs: root/target/release/yggdrasil, trunk/target/release/bifrost-net (cargo build --release;
# or YGG_BIN / BIFROST_NET_BIN), branch built (npm run build), zbarimg + qrencode, playwright's
# chromium. State + logs: TRUNK_FULL_STATE (default: a fresh mktemp dir, printed at the end).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${TRUNK_FULL_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env TRUNK_FULL_NS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
B=$ROOT/branch
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release)"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }
for t in zbarimg qrencode; do command -v $t >/dev/null || { echo "$t missing"; exit 2; }; done

# ---- the namespace's network: loopback, the "internet" (the ap), the box LAN, the new machine ----
ip link set lo up
add() { ip link add "$1" type dummy && ip addr add "$2" dev "$1" && ip link set "$1" up; }
add wan0 198.51.100.7/24   # the access point's public address (TEST-NET-2)
add lan0 192.168.77.2/24   # the hub box's LAN
add far0 203.0.113.9/24    # the new machine, somewhere else (TEST-NET-3)
AP_IP=198.51.100.7 LAN=192.168.77.2 FAR=203.0.113.9 AP_HOST=ap.tree.test
AP_URL="https://$AP_HOST"
STATE=${TRUNK_FULL_STATE:-$(mktemp -d /tmp/trunk-full.XXXXXX)}
mkdir -p "$STATE"/{home/work,mac,tls} && chmod 700 "$STATE"
rm -f "$STATE"/devices.json* "$STATE"/roots.json* "$STATE"/steps.tsv
# the ap's name resolves for every process of the run (and only here)
{ cat /etc/hosts; echo "$AP_IP $AP_HOST"; } >"$STATE/hosts"
mount --bind "$STATE/hosts" /etc/hosts

APP=18395 HOMEP=18396 MOCK=18397 BR=18398 MEDIA=18399 RL=18400 MACP=18401 PEERP=18402
RLSECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
PEER="peer-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

pids=()
cleanup() {
  touch "$STATE/.stop"
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  kill "$(cat "$STATE/home.pid" 2>/dev/null)" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$STATE/mock.log" 2>&1 &
pids+=($!)

# the hub brain "home": no static YGG_PEERS — it learns every root that links to the trunk from
# the bridge's loopback list (YGG_PEERS_FROM → GET /_roots; reached through /_root/<id>). Started
# once: the spec checks that a join reaches it without a restart (home.pid stays the same).
env -i PATH="$PATH" HOME="$STATE/home" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK" \
  YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock \
  YGG_WAKE_DEBOUNCE_MS=400 YGG_PROVIDERS="$STATE/home/none.json" \
  YGG_ARTIFACTS_DIR="$STATE/home/artifacts" YGG_DATA_DIR="$STATE/home/data" \
  YGG_PROFILES="$STATE/home/agents.json" YGG_PROJECT_DIR="$STATE/home/work" \
  YGG_LISTEN="127.0.0.1:$HOMEP" YGG_ROOT_NAME=home YGG_PEER_TOKEN="$PEER" \
  YGG_PEERS_FROM="http://127.0.0.1:$BR/_roots" "$YGG_BIN" >>"$STATE/home.log" 2>&1 &
pids+=($!)
echo $! >"$STATE/home.pid"

# ---- the access point: TLS on the "internet" address, a self-signed test cert ----
CERT=$("$BIN" ap-cert "$STATE/tls" "$AP_HOST" "$AP_IP")
PIN=$(sed -n 's/^pin = "\([^"]*\)".*/\1/p' <<<"$CERT")
TOK=$("$BIN" ap-token)
APTOK=$(sed -n 's/^token = "\([^"]*\)".*/\1/p' <<<"$TOK")
APHASH=$(sed -n 's/^bridge_token_sha256 = "\([^"]*\)".*/\1/p' <<<"$TOK")
cat >"$STATE/ap.toml" <<TOML
[ap]
listen = "$AP_IP:443"
cert_path = "$STATE/tls/cert.pem"
key_path = "$STATE/tls/key.pem"
bridge_token_sha256 = "$APHASH"
TOML
"$BIN" ap -c "$STATE/ap.toml" >"$STATE/ap.log" 2>&1 &
pids+=($!)

# ---- the hub's bridge: pairing identity, root-link plane + switchboard, [ap] dial-OUT ----
KEY=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat >"$STATE/bridge.toml" <<TOML
[node]
name = "hub-box"
private_key = "$KEY"

[bridge]
http = "127.0.0.1:$BR"
media = "$LAN:$MEDIA"
tokens_file = "$STATE/devices.json"
opencode_url = "http://127.0.0.1:$HOMEP"
candidates = ["$LAN"]
dtls_cert_file = "$STATE/bridge-dtls.json"
public_url = "http://$LAN:$BR"
root_link_secret = "$RLSECRET"

[bridge.root-link]
enabled = true
listen = "127.0.0.1:$RL"
ping_secs = 5
result_secs = 120

[ap]
url = "wss://$AP_HOST/ap"
pin = "$PIN"
token = "$APTOK"
upstream = "127.0.0.1:$APP"
TOML
chmod 600 "$STATE/bridge.toml"
"$BIN" bridge -c "$STATE/bridge.toml" >"$STATE/bridge.log" 2>&1 &
pids+=($!)

# ---- the app: devices mode behind the ap (loopback only, X-Forwarded-For from the bridge) ----
(
  cd "$B"
  exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    BIFROST_AUTH=devices BIFROST_DEVICES_FILE="$STATE/devices.json" \
    BIFROST_PUBLIC_URL="$AP_URL" BIFROST_TRUST_PROXY=1 PORT="$APP" HOST=127.0.0.1 \
    BIFROST_BRIDGE_URL="http://127.0.0.1:$BR" BIFROST_MAIN_TITLE='[MAIN]' \
    OPENCODE_URL="http://127.0.0.1:$HOMEP" ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= \
    BIFROST_NET_BIN="$BIN" BIFROST_BRIDGE_CONFIG="$STATE/bridge.toml" \
    BIFROST_ROOTLINK_URL="wss://$AP_HOST/rootlink" YGG_PEER_TOKEN="$PEER" \
    node server.mjs
) >"$STATE/app.log" 2>&1 &
pids+=($!)

up=0
for _ in $(seq 90); do
  if curl -sf -o /dev/null "http://127.0.0.1:$BR/identity" &&
    curl -sf -o /dev/null "http://127.0.0.1:$APP/pair" &&
    curl -sf -o /dev/null "http://127.0.0.1:$HOMEP/session" &&
    grep -q "channel up" "$STATE/bridge.log" &&
    curl -sf -o /dev/null --cacert "$STATE/tls/cert.pem" "$AP_URL/pair"; then
    up=1
    break
  fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "the box did not come up — logs in $STATE"
  tail -n 20 "$STATE"/{bridge,ap,app,home}.log
  exit 1
fi
echo "box up: phone → $AP_URL (ap $AP_IP:443) → bridge (dial-out) → app :$APP · brain home :$HOMEP"

cd "$B"
set +e
PW_AP_URL="$AP_URL" PW_AP_IP="$AP_IP" PW_BASE_URL="http://127.0.0.1:$APP" PW_STATE="$STATE" \
  PW_BRIDGE="http://127.0.0.1:$BR" PW_HOME="http://127.0.0.1:$HOMEP" PW_MAC_PORT="$MACP" \
  PW_PEER_PORT="$PEERP" PW_MOCK="http://127.0.0.1:$MOCK" PW_FAR="$FAR" PW_YGG_BIN="$YGG_BIN" \
  PW_CAFILE="$STATE/tls/cert.pem" PW_PEER_TOKEN="$PEER" \
  npx playwright test e2e/trunk-full.spec.ts --reporter=list 2>&1 | tee "$STATE/e2e.log"
rc=${PIPESTATUS[0]}
set -e

# ---- the table ----
echo
printf '%-5s %-4s %s\n' STEP "" "WHAT"
fails=0
if [ -s "$STATE/steps.tsv" ]; then
  while IFS=$'\t' read -r n res what detail; do
    printf '%-5s %-4s %s\n' "$n" "$res" "$what"
    [ "$res" = PASS ] || { fails=$((fails + 1)); [ -n "$detail" ] && printf '           ↳ %s\n' "$detail"; }
  done <"$STATE/steps.tsv"
else
  echo "(no steps recorded)"
  fails=1
fi
echo "invariant 5: raw credentials in devices.json: $(grep -cE '"bfn[dpr]-' "$STATE/devices.json" 2>/dev/null || true) · roots.json mode $(stat -c %a "$STATE/roots.json" 2>/dev/null || echo -)"
echo "state + logs: $STATE"
if [ "$rc" != 0 ] || [ "$fails" != 0 ]; then
  echo "TRUNK-FULL: RED ($fails failed step(s), playwright exit $rc)"
  exit 1
fi
echo "TRUNK-FULL: GREEN"
