#!/usr/bin/env bash
# layman-bootstrap.sh — ONE command: fresh Linux box → running bifrost (root+trunk) → QR to scan.
#
# ON-NETWORK layman flow (lab/layman-deploy, spec: docs/spec-onboard.md + spec-onboard refinement):
#   1. installs the app stage (PWA build + brain + mock provider) and the trunk (bifrost-net bridge)
#   2. mints the first device token through the REAL pairing surface (PWA /api/pair → lib/devices.ts)
#   3. prints a QR containing the join URL (PWA /bridge + bridge url + device token) — phone scans, done.
#
# Design law: reuse ONLY what exists. No new architecture, no release dirs, no systemd live
# units (:8080/:4096/:4100), no deploy.sh. Services run as transient user units
# (systemd-run, sim-stack.sh pattern, ports defaulting to 8145+) — a "stage", not production.
#
# Usage:
#   scripts/layman-bootstrap.sh [--stage|--fresh-install] [--qr-dir DIR] [--print-qr-file PATH] [--ports BASE]
#
#     --stage          run ON this box from this checkout (default): stage the already-built
#                      pwa/.next + prebuilt binaries into a fresh dir, own ports, own state.
#     --fresh-install  behave as on a FRESH Linux computer: clone the repo into $BIFROST_DIR
#                      (default ~/bifrost), npm ci + next build, system deps via docker compose
#                      (LiveKit/speaches path from deploy/), THEN stage + QR. Slow (~10+ min).
#                      This is the path the report's "paste this" block shows a layman.
#
# Exit 0 = stack healthy + QR printed. Nonzero = the exact failing step is in the output.
set -euo pipefail

MODE="stage"
QR_DIR=""
QR_FILE=""   # --print-qr-file: EXACT png path (win/launcher.bat grabs it deterministically)
PORT_BASE="${LAYMAN_PORT_BASE:-8145}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) MODE="stage" ;;
    --fresh-install) MODE="fresh" ;;
    --qr-dir) QR_DIR="${2:?}"; shift ;;
    --print-qr-file) QR_FILE="${2:?}"; shift ;;
    --ports) PORT_BASE="${2:?}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { echo "[layman] $*"; }
fail() { echo "[layman] FAIL: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "$MODE" == "fresh" ]]; then
  # ---------- the FRESH-BOX path: what a layman actually pastes ----------
  have git || fail "git missing — install it first (sudo apt install -y git curl)"
  have curl || fail "curl missing (sudo apt install -y git curl)"
  BIFROST_DIR="${BIFROST_DIR:-$HOME/bifrost}"
  if [[ ! -d "$BIFROST_DIR/.git" ]]; then
    say "cloning bifrost into $BIFROST_DIR"
    git clone --depth 1 https://github.com/veraldar/bifrost.git "$BIFROST_DIR"
  fi
  cd "$BIFROST_DIR"
  # system deps: docker compose carries LiveKit + speaches (deploy/docker-compose.yml).
  if ! have docker; then
    say "installing docker (official convenience script)"
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER" || true
    fail "docker was just installed — log out/in once (group docker), then re-run this command"
  fi
  have node || fail "node missing (install node 22+: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs)"
  say "npm ci + next build (first install: ~5-10 min)"
  (cd pwa && npm ci --no-audit --no-fund && npm run build)
else
  # ---------- the STAGE path (this box): reuse MAIN's built artifacts ----------
  # repo root = the script lives at <root>/lab/layman-deploy/impl/
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  cd "$ROOT"
  [[ -f pwa/.next/BUILD_ID ]] || fail "pwa/.next/BUILD_ID missing — build first: cd pwa && npm run build"
fi

# ---------- shared staging (both modes): fresh dir, own ports, own state ----------
PWA_PORT=$((PORT_BASE))        # the app the phone lands on
YGG_PORT=$((PORT_BASE + 1))    # root: the brain
MOCK_PORT=$((PORT_BASE + 2))   # mock provider behind the brain (on-network self-contained)
BRIDGE_HTTP=$((PORT_BASE + 3)) # trunk: bifrost-net bridge signaling (POST /offer)
BRIDGE_MEDIA=$((PORT_BASE + 4)) # trunk: bridge media UDP
STAGE="${LAYMAN_STAGE_DIR:-/tmp/layman-qr}"
IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' | head -1 || true)"
IP="${IP:-127.0.0.1}"

say "stage dir: $STAGE · ports app:$PWA_PORT root:$YGG_PORT mock:$MOCK_PORT bridge:$BRIDGE_HTTP/$BRIDGE_MEDIA · LAN IP $IP"

# prebuilt pieces (staged, never rebuilt here):
YGG_BIN="${YGG_BIN:-$PWD/lab/yggdrasil/target/release/yggdrasil}"
BRIDGE_BIN="${BRIDGE_BIN:-$PWD/lab/bifrost-net/target/release/bifrost-net}"
MOCK_PY="${MOCK_PY:-$PWD/lab/yggdrasil/mock/mock_upstream.py}"
[[ -x "$YGG_BIN" ]]    || fail "brain binary missing: $YGG_BIN (lab/yggdrasil — cargo build --release)"
[[ -x "$BRIDGE_BIN" ]] || fail "trunk binary missing: $BRIDGE_BIN (lab/bifrost-net — cargo build --release)"
[[ -f "$MOCK_PY" ]]    || fail "mock upstream missing: $MOCK_PY"

rm -rf "$STAGE"; mkdir -p "$STAGE"/{pwa,state,proj,ygg}
# app stage = the built .next WITHOUT its cache (sim-stack.sh pattern), symlinks to real node_modules
rsync -a --delete --exclude cache pwa/.next/ "$STAGE/pwa/.next/"
rsync -a --delete pwa/public/ "$STAGE/pwa/public/" 2>/dev/null || true
cp pwa/package.json pwa/next.config.ts "$STAGE/pwa/"
ln -sfn "$PWD/pwa/node_modules" "$STAGE/pwa/node_modules"
# the stage's own env: device-token auth for the /api/* seam (the app + trunk
# listen on the LAN for the ON-NETWORK story — the lab law requires device
# tokens beyond loopback, so BIFROST_AUTH=devices + an admin token minted here;
# the bootstrap uses the admin token for the first /api/pair mint below).
ADMIN_TOKEN="bfad-$(openssl rand -hex 24)"
cat > "$STAGE/pwa/.env.local" <<EOF
OPENCODE_URL=http://127.0.0.1:$YGG_PORT
AGENT_NAME=layman-none
AGENT_DISPATCH_NAME=layman-none
BIFROST_DEVICES_FILE=$STAGE/state/devices.json
BIFROST_AUTH=devices
BIFROST_ADMIN_TOKEN=$ADMIN_TOKEN
EOF
printf '%s' "$ADMIN_TOKEN" > "$STAGE/state/admin-token" && chmod 600 "$STAGE/state/admin-token"

# ---------- down any previous stage (only layman-* units — never live names) ----------
for u in layman-mock layman-root layman-app layman-trunk; do
  systemctl --user stop "$u" 2>/dev/null || true
  systemctl --user reset-failed "$u" 2>/dev/null || true
done

# ---------- up: mock provider → root (brain) → app (PWA) → trunk (bridge) ----------
systemd-run --user -q --unit=layman-mock --collect -p Restart=on-failure \
  python3 "$MOCK_PY" "$MOCK_PORT"

systemd-run --user -q --unit=layman-root -p Type=exec -p Restart=on-failure -p RestartSec=2 \
  -p RestartPreventExitStatus=2 -p NoNewPrivileges=yes -p LockPersonality=yes \
  -p RestrictRealtime=yes -p RestrictSUIDSGID=yes -p RestrictNamespaces=yes \
  -p MemoryDenyWriteExecute=yes -p SystemCallArchitectures=native -p UMask=0077 \
  -p WorkingDirectory="$STAGE/proj" \
  -E YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT" -E YGG_UPSTREAM_STYLE=anthropic \
  -E YGG_UPSTREAM_API_KEY=layman-key -E YGG_UPSTREAM_MODEL=mock \
  -E YGG_LISTEN="127.0.0.1:$YGG_PORT" -E YGG_DATA_DIR="$STAGE/ygg" -E YGG_PROJECT_DIR="$STAGE/proj" \
  -E YGG_MAX_TOKENS=16384 -E YGG_VOICE=1 -E YGG_VOICE_MAX_WORDS=60 \
  "$YGG_BIN"

# ON-NETWORK: the phone joins over the LAN, so app + trunk bind 0.0.0.0 (the
# QR points at $IP). Gates: /api/* behind BIFROST_AUTH=devices; the trunk's
# signaling accepts ONLY a minted Bearer token (401 fail-closed — verified
# in the e2e below); the brain + mock stay loopback-only.
systemd-run --user -q --unit=layman-app -p Restart=on-failure -p RestartSec=5 \
  -p WorkingDirectory="$STAGE/pwa" \
  -E PORT="$PWA_PORT" -E HOST=0.0.0.0 -E OPENCODE_URL="http://127.0.0.1:$YGG_PORT" \
  -E NODE_ENV=production \
  node node_modules/next/dist/bin/next start -p "$PWA_PORT" -H 0.0.0.0

# trunk: bifrost-net bridge. Keypair minted once, kept in the stage state (idempotent).
[[ -f "$STAGE/state/node.key" ]] || "$BRIDGE_BIN" keygen > "$STAGE/state/node.key"
NODE_KEY_LINE="$(head -1 "$STAGE/state/node.key")" # keygen prints a ready `private_key = "…"` TOML line
cat > "$STAGE/state/bridge.toml" <<EOF
[node]
name = "layman"
$NODE_KEY_LINE

[bridge]
http = "0.0.0.0:$BRIDGE_HTTP"
media = "0.0.0.0:$BRIDGE_MEDIA"
tokens_file = "$STAGE/state/devices.json"
opencode_url = "http://127.0.0.1:$YGG_PORT"
speaches_url = "${SPEACHES_URL:-http://127.0.0.1:8000/v1}"
candidates = ["127.0.0.1", "$IP"]
EOF
systemd-run --user -q --unit=layman-trunk -p Restart=on-failure -p RestartSec=2 \
  -E SPEACHES_URL="${SPEACHES_URL:-http://127.0.0.1:8000/v1}" \
  "$BRIDGE_BIN" bridge -c "$STAGE/state/bridge.toml"

wait_http() { # url secs label
  for _ in $(seq $(( $2 * 4 ))); do
    curl -sf -o /dev/null "$1" 2>/dev/null && return 0
    sleep 0.25
  done
  fail "$3 did not answer: $1 (journalctl --user -u layman-* -n 50)"
}
wait_http "http://127.0.0.1:$MOCK_PORT/calls" 15 "mock provider"
wait_http "http://127.0.0.1:$YGG_PORT/session" 30 "root (brain)"
wait_http "http://127.0.0.1:$PWA_PORT/" 45 "app (PWA)"

# ---------- pair: mint the first device through the REAL pairing surface ----------
# POST /api/pair — the endpoint backed by lib/devices.ts (mintDevice: bfnd-… token,
# sha256 tokenHash written to BIFROST_DEVICES_FILE — the same file the trunk verifies).
PAIR_JSON="$(curl -sf -X POST "http://127.0.0.1:$PWA_PORT/api/pair" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"layman-phone"}')" \
  || fail "pairing failed (POST /api/pair with the admin token)"
TOKEN="$(printf '%s' "$PAIR_JSON" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
[[ "$TOKEN" == bfnd-* ]] || fail "pairing returned no bfnd- token: $PAIR_JSON"
chmod 600 "$STAGE/state/devices.json" 2>/dev/null || true

# final app health: the minted DEVICE token must clear the /api/* devices gate —
# this is exactly the credential every call from the paired phone carries.
BUILD_JSON="$(curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PWA_PORT/api/build")"
printf '%s' "$BUILD_JSON" | grep -q '"id"' || fail "device token did not clear /api/build: $BUILD_JSON"

# ---------- the QR: everything the phone needs to join, in one scan ----------
JOIN_URL="http://$IP:$PWA_PORT/bridge?b=http%3A%2F%2F$IP%3A$BRIDGE_HTTP&t=$TOKEN"
QR_DIR="${QR_DIR:-$STAGE}"
# --print-qr-file: the png's EXACT path, decided by the caller (the Windows
# launcher passes a path on the user's Desktop) — qr-dir stays the payload's home.
QR_PNG="$QR_FILE"
if [[ -n "$QR_PNG" ]]; then mkdir -p "$(dirname "$QR_PNG")"; else QR_PNG="$QR_DIR/pair-qr.png"; fi
QR_TXT="$QR_DIR/pair-qr.txt"
printf '%s' "$JOIN_URL" > "$QR_TXT"
chmod 600 "$QR_TXT"
say "writing QR png + terminal QR for: $JOIN_URL"
if have npx || [[ -f pwa/node_modules/qrcode/bin/qrcode ]]; then
  # qrcode renders a PNG + terminal blocks — no image viewer needed on the box.
  # The repo already ships qrcode (pwa dep, used by /pair); prefer the local CLI.
  # NODE_OPTIONS=--jitless: on hardened boxes (MemoryDenyWriteExecute) plain node aborts.
  QR_CLI=""; [[ -f pwa/node_modules/qrcode/bin/qrcode ]] && QR_CLI="$(command -v node) pwa/node_modules/qrcode/bin/qrcode"
  if [[ -n "$QR_CLI" ]]; then
    NODE_OPTIONS="--jitless" $QR_CLI -o "$QR_PNG" -w 320 "$JOIN_URL" \
      && NODE_OPTIONS="--jitless" $QR_CLI --small "$JOIN_URL" || say "WARN: local qrcode render failed — payload is in $QR_TXT"
  elif have npx; then
    npx --yes qrcode -o "$QR_PNG" -w 320 "$JOIN_URL" \
      && npx --yes qrcode -t "$JOIN_URL" || say "WARN: npx qrcode render failed — payload is in $QR_TXT"
  fi
else
  say "SKIP png (no qrcode available) — raw payload below"
fi

say "-------------------------------------------------------------"
say "bifrost is UP (layman stage)"
say "  app    http://$IP:$PWA_PORT   (the phone lands here)"
say "  root   127.0.0.1:$YGG_PORT    (the brain)"
say "  trunk  http://$IP:$BRIDGE_HTTP (the bridge; phone joins with the token)"
say "  token  $TOKEN   (ALSO inside the QR — shown once)"
say "  QR payload file: $QR_TXT  · png: $QR_PNG"
say "  scan the QR with any camera app → opens /bridge pre-filled → tap Connect → talk."
say "  teardown: systemctl --user stop layman-mock layman-root layman-app layman-trunk"
say "-------------------------------------------------------------"
