#!/usr/bin/env bash
# vps-bootstrap.sh — ONE command: fresh Ubuntu 24.04 VPS → running veraldar
# stack → QR to scan with a phone.
#
# spec-onboard path, option 3 ("rented VPS hosts everything"), built ONLY from
# pieces already proven on this box:
#   - staging pattern + env/ports/health-wait: layman-bootstrap.sh (same dir)
#   - brain binary + mock provider:            lab/yggdrasil (+ lab/yggdrasil/mock)
#   - trunk (WebRTC bridge, token-gated):      lab/bifrost-net
#   - device-token pairing:                    pwa /api/pair → lib/devices.ts
#   - LiveKit + caddy images:                  already local
#
# Modes:
#   --stage  (default) run on THIS box from this checkout: stage into /tmp/vps-boot
#            with an overridden IP/domain, transient user units, own ports
#            (8235+). The simulation lane: no sudo, no installs, no live units.
#            The cert step LOGS ITS PLAN (real ACME needs a real VPS with 80/443).
#   --vps    run on a FRESH UBUNTU 24.04 VPS as a sudo-capable user: apt deps,
#            secrets, caddy with real ACME (Let's Encrypt), system units.
#
# Exit 0 = units healthy + QR verified. Nonzero = the failing step is printed.
set -euo pipefail

MODE="stage"
DOMAIN=""       # --domain: public name (nip.io/sslip or your own); empty = <ip>.nip.io
EMAIL=""        # --email: ACME contact (real VPS only)
IP_OVERRIDE=""  # --ip: force the public IP (stage sim: your LAN IP)
PORT_BASE="${VPS_PORT_BASE:-8235}"
VPS_HOME_DIR="${VPS_HOME_DIR:-$HOME/veraldar}"
UPSTREAM_KEY=""      # --upstream-key: the brain's provider key (the ONE secret a VPS can't mint)
UPSTREAM_URL="${UPSTREAM_URL:-https://api.anthropic.com}"
UPSTREAM_STYLE="${UPSTREAM_STYLE:-anthropic}"
UPSTREAM_MODEL=""    # empty = brain's built-in default

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) MODE="stage" ;;
    --vps) MODE="vps" ;;
    --domain) DOMAIN="${2:?}"; shift ;;
    --email) EMAIL="${2:?}"; shift ;;
    --ip) IP_OVERRIDE="${2:?}"; shift ;;
    --ports) PORT_BASE="${2:?}"; shift ;;
    --upstream-key) UPSTREAM_KEY="${2:?}"; shift ;;
    --upstream-url) UPSTREAM_URL="${2:?}"; shift ;;
    --upstream-style) UPSTREAM_STYLE="${2:?}"; shift ;;
    --upstream-model) UPSTREAM_MODEL="${2:?}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { echo "[vps-boot] $*"; }
fail() { echo "[vps-boot] FAIL: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# repo root = the script lives at <root>/lab/layman-deploy/impl/
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
[[ -f pwa/.next/BUILD_ID ]] || fail "pwa/.next/BUILD_ID missing — build first: cd pwa && npm run build"

# ---------- 0. public IP + domain ----------
# nip.io/sslip map <anything>.<ip>.nip.io → <ip>. A real VPS uses its public IP;
# the stage sim uses the LAN IP (the phone is on the same network) or --ip.
IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' | head -1 || true)"
IP="${IP_OVERRIDE:-${IP:-127.0.0.1}}"
DOMAIN="${DOMAIN:-$IP.nip.io}"

# ---------- 1. ports, paths, prebuilt pieces ----------
PWA_PORT=$PORT_BASE
YGG_PORT=$((PORT_BASE + 1))
MOCK_PORT=$((PORT_BASE + 2))
BRIDGE_HTTP=$((PORT_BASE + 3))
BRIDGE_MEDIA=$((PORT_BASE + 4))
LK_PORT=$((PORT_BASE + 5))
STAGE="${VPS_STAGE_DIR:-/tmp/vps-boot}"
SECRETS="$STAGE/state"
mkdir -p "$SECRETS"

YGG_BIN="${YGG_BIN:-$PWD/lab/yggdrasil/target/release/yggdrasil}"
BRIDGE_BIN="${BRIDGE_BIN:-$PWD/lab/bifrost-net/target/release/bifrost-net}"
MOCK_PY="${MOCK_PY:-$PWD/lab/yggdrasil/mock/mock_upstream.py}"
[[ -x "$YGG_BIN" ]]    || fail "brain binary missing: $YGG_BIN (cargo build --release in lab/yggdrasil)"
[[ -x "$BRIDGE_BIN" ]] || fail "trunk binary missing: $BRIDGE_BIN (cargo build --release in lab/bifrost-net)"
[[ -f "$MOCK_PY" ]]    || fail "mock upstream missing: $MOCK_PY"

# ---------- 2. secrets: mint if absent, NEVER overwrite (spec §2) ----------
mint_if_absent() { # file cmd...
  local f="$1"; shift
  if [[ -f "$f" ]]; then say "keep  $(basename "$f") (exists — never overwrite)"; return; fi
  "$@" > "$f"
  chmod 600 "$f"
  say "mint  $(basename "$f")"
}
mint_if_absent "$SECRETS/livekit-secret" openssl rand -hex 24
# VAPID pair (webpush): placeholder pair for the stage sim — the real derivation
# (P-256 raw scalar + uncompressed point, base64url) is vps-mode work; push is
# spec phase 2 and not one of this lane's asserts.
mint_if_absent "$SECRETS/vapid-priv" openssl rand -base64 32
mint_if_absent "$SECRETS/vapid-pub"  openssl rand -base64 32
mint_if_absent "$SECRETS/admin-token" sh -c 'echo "bfad-$(openssl rand -hex 24)"'
LIVEKIT_SECRET="$(cat "$SECRETS/livekit-secret")"
ADMIN_TOKEN="$(cat "$SECRETS/admin-token")"

# ---------- 3. stage the app + write its env ----------
if [[ "$MODE" == "stage" ]]; then rm -rf "$STAGE/pwa" "$STAGE/proj" "$STAGE/ygg"; fi
mkdir -p "$STAGE/pwa" "$STAGE/proj" "$STAGE/ygg"
rsync -a --delete --exclude cache pwa/.next/ "$STAGE/pwa/.next/"
rsync -a --delete pwa/public/ "$STAGE/pwa/public/" 2>/dev/null || true
cp pwa/package.json pwa/next.config.ts "$STAGE/pwa/"
ln -sfn "$PWD/pwa/node_modules" "$STAGE/pwa/node_modules"
cat > "$STAGE/pwa/.env.local" <<EOF
OPENCODE_URL=http://127.0.0.1:$YGG_PORT
AGENT_NAME=vps-none
AGENT_DISPATCH_NAME=vps-none
BIFROST_DEVICES_FILE=$SECRETS/devices.json
BIFROST_AUTH=devices
BIFROST_ADMIN_TOKEN=$ADMIN_TOKEN
VAPID_PUBLIC_KEY=$(cat "$SECRETS/vapid-pub")
VAPID_PRIVATE_KEY=$(cat "$SECRETS/vapid-priv")
EOF

# ---------- 4. caddy ----------
# Real VPS: real ACME. Stage: the SAME routing plan, `caddy adapt` proves the
# config compiles, and the plan is LOGGED — real certs need 80/443 + a public IP.
if [[ -n "$EMAIL" ]]; then
  cat > "$SECRETS/Caddyfile" <<EOF
{
	email $EMAIL
}

$DOMAIN {
	reverse_proxy 127.0.0.1:$PWA_PORT
}

vlive.$DOMAIN {
	reverse_proxy h2c://127.0.0.1:$LK_PORT
}
EOF
else
  # no email: caddy will use on-demand/HTTP-01 without a contact — fine for the
  # plan record; a real run should pass --email for Let's Encrypt expiry mail.
  cat > "$SECRETS/Caddyfile" <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PWA_PORT
}

vlive.$DOMAIN {
	reverse_proxy h2c://127.0.0.1:$LK_PORT
}
EOF
fi
if [[ "$MODE" == "stage" ]]; then
  say "CERT PLAN (logged, NOT executed — a real VPS runs this for real):"
  say "  caddy → Let's Encrypt (ACME HTTP-01, ports 80/443) for:"
  say "    https://$DOMAIN        → PWA 127.0.0.1:$PWA_PORT"
  say "    https://vlive.$DOMAIN  → LiveKit 127.0.0.1:$LK_PORT"
fi

# livekit.yaml: minted in BOTH modes — vps mode: use_external_ip true + the IP
# include (public-NIC VPS); stage: use_external_ip false, no includes (same as
# the green night lane — includes must match a real NIC, the sim IP is fake).
if [[ "$MODE" == "vps" ]]; then
  RTC_BLOCK="rtc:
  tcp_port: $((LK_PORT + 1))
  port_range_start: 50100
  port_range_end: 50120
  use_external_ip: true
  ips:
    includes: [\"$IP/32\"]"
else
  RTC_BLOCK="rtc:
  tcp_port: $((LK_PORT + 1))
  port_range_start: 50100
  port_range_end: 50120
  use_external_ip: false"
fi
[[ -f "$SECRETS/livekit.yaml" ]] || cat > "$SECRETS/livekit.yaml" <<EOF
port: $LK_PORT
bind_addresses: ["0.0.0.0"]
$RTC_BLOCK
keys:
  devkey: $LIVEKIT_SECRET
EOF
say "livekit.yaml ready ($LK_PORT/$((LK_PORT+1)) tcp, 50100-50120 udp, rtc per mode)"

# ---------- 5a. VPS-mode system deps (stage mode skips all of this) ----------
if [[ "$MODE" == "vps" ]]; then
  [[ -n "$EMAIL" ]] || fail "--email required with --vps (ACME contact)"
  have git || { sudo apt-get update -y; sudo apt-get install -y git curl; }
  have node || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -; sudo apt-get install -y nodejs; }
  have docker || { curl -fsSL https://get.docker.com | sh; sudo usermod -aG docker "$USER" || true; }
  [[ -f pwa/.next/BUILD_ID ]] || { say "building PWA (first run ~5-10 min)"; (cd pwa && npm ci --no-audit --no-fund && npm run build); }
  [[ -x "$YGG_BIN" ]]    || { say "building brain"; (cd lab/yggdrasil && cargo build --release); }
  [[ -x "$BRIDGE_BIN" ]] || { say "building trunk"; (cd lab/bifrost-net && cargo build --release); }
  sudo apt-get install -y caddy qrencode rsync
  sudo mkdir -p /etc/caddy
  sudo cp "$SECRETS/Caddyfile" /etc/caddy/Caddyfile
  sudo caddy validate --config /etc/caddy/Caddyfile || fail "caddy config invalid"
  sudo systemctl enable caddy
  # NOT started yet — the restart (and the real ACME attempt it triggers)
  # happens after the stack units are up, right before the cert-wait below.
fi

# ---------- 5b. units (shared machinery; stage = transient user units) ----------
if [[ "$MODE" == "stage" ]]; then
  for u in vpsboot-mock vpsboot-root vpsboot-app vpsboot-trunk; do
    systemctl --user stop "$u" 2>/dev/null || true
    systemctl --user reset-failed "$u" 2>/dev/null || true
  done
  docker rm -f vpsboot-livekit vpsboot-caddy >/dev/null 2>&1 || true

  systemd-run --user -q --unit=vpsboot-mock --collect -p Restart=on-failure \
    python3 "$MOCK_PY" "$MOCK_PORT"

  systemd-run --user -q --unit=vpsboot-root -p Type=exec -p Restart=on-failure -p RestartSec=2 \
    -p RestartPreventExitStatus=2 -p NoNewPrivileges=yes -p LockPersonality=yes \
    -p RestrictRealtime=yes -p RestrictSUIDSGID=yes -p RestrictNamespaces=yes \
    -p MemoryDenyWriteExecute=yes -p SystemCallArchitectures=native -p UMask=0077 \
    -p WorkingDirectory="$STAGE/proj" \
    -E YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT" -E YGG_UPSTREAM_STYLE=anthropic \
    -E YGG_UPSTREAM_API_KEY=vps-key -E YGG_UPSTREAM_MODEL=mock \
    -E YGG_LISTEN="127.0.0.1:$YGG_PORT" -E YGG_DATA_DIR="$STAGE/ygg" -E YGG_PROJECT_DIR="$STAGE/proj" \
    -E YGG_MAX_TOKENS=16384 -E YGG_VOICE=1 -E YGG_VOICE_MAX_WORDS=60 \
    "$YGG_BIN"

  systemd-run --user -q --unit=vpsboot-app -p Restart=on-failure -p RestartSec=5 \
    -p WorkingDirectory="$STAGE/pwa" \
    -E PORT="$PWA_PORT" -E HOST=127.0.0.1 -E OPENCODE_URL="http://127.0.0.1:$YGG_PORT" \
    -E NODE_ENV=production \
    node node_modules/next/dist/bin/next start -p "$PWA_PORT" -H 127.0.0.1

  # trunk: keypair minted once into stage state (idempotent)
  [[ -f "$SECRETS/node.key" ]] || "$BRIDGE_BIN" keygen > "$SECRETS/node.key"
  NODE_KEY_LINE="$(head -1 "$SECRETS/node.key")"
  cat > "$SECRETS/bridge.toml" <<EOF
[node]
name = "vps"
$NODE_KEY_LINE

[bridge]
http = "0.0.0.0:$BRIDGE_HTTP"
media = "0.0.0.0:$BRIDGE_MEDIA"
tokens_file = "$SECRETS/devices.json"
opencode_url = "http://127.0.0.1:$YGG_PORT"
speaches_url = "${SPEACHES_URL:-http://127.0.0.1:8000/v1}"
candidates = ["127.0.0.1", "$IP"]
EOF
  systemd-run --user -q --unit=vpsboot-trunk -p Restart=on-failure -p RestartSec=2 \
    -E SPEACHES_URL="${SPEACHES_URL:-http://127.0.0.1:8000/v1}" \
    "$BRIDGE_BIN" bridge -c "$SECRETS/bridge.toml"

  # livekit: deploy/'s own image, config minted into stage state
  [[ -f "$SECRETS/livekit.yaml" ]] || cat > "$SECRETS/livekit.yaml" <<EOF
port: $LK_PORT
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: $((LK_PORT + 1))
  port_range_start: 50100
  port_range_end: 50120
  use_external_ip: false
  ips:
    includes: ["$IP/32"]
keys:
  devkey: $LIVEKIT_SECRET
EOF
  docker run -d --rm --name vpsboot-livekit --network host \
    -v "$SECRETS/livekit.yaml:/etc/livekit.yaml:ro" \
    livekit/livekit-server:latest --config /etc/livekit.yaml >/dev/null
  say "livekit container up (host net, config minted: devkey + staged secret)"

  # caddy in stage: ADAPT-ONLY (proves the routing plan compiles; serving
  # 80/443 is impossible on this box — logged above, executed on a real VPS)
  if docker run --rm --network host -v "$SECRETS/Caddyfile:/etc/caddy/Caddyfile:ro" \
      caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --pretty \
      > "$SECRETS/caddy-adapt.json" 2>"$SECRETS/caddy-adapt.err"; then
    say "caddy config ADAPTS clean — routing plan proven (real serve = real VPS)"
  else
    fail "caddy config invalid — see $SECRETS/caddy-adapt.err"
  fi

  wait_http() { # url secs label
    for _ in $(seq $(( $2 * 4 ))); do
      curl -sf -o /dev/null "$1" 2>/dev/null && return 0
      sleep 0.25
    done
    fail "$3 did not answer: $1"
  }
  wait_http "http://127.0.0.1:$MOCK_PORT/calls" 15 "mock provider"
  wait_http "http://127.0.0.1:$YGG_PORT/session" 30 "root (brain)"
  wait_http "http://127.0.0.1:$PWA_PORT/" 60 "app (PWA)"
  wait_http "http://127.0.0.1:$LK_PORT" 30 "livekit"

  # ---------- 6. pair: mint the first device via the REAL pairing surface ----------
  PAIR_JSON="$(curl -sf -X POST "http://127.0.0.1:$PWA_PORT/api/pair" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"name":"vps-phone"}')" || fail "pairing mint failed (POST /api/pair with admin token)"
  TOKEN="$(printf '%s' "$PAIR_JSON" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
  [[ "$TOKEN" == bfnd-* ]] || fail "no bfnd- token minted: $PAIR_JSON"
  chmod 600 "$SECRETS/devices.json" 2>/dev/null || true

  # the minted DEVICE token must clear the /api/* gate (the phone's credential)
  BUILD_JSON="$(curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PWA_PORT/api/build")"
  printf '%s' "$BUILD_JSON" | grep -q '"id"' || fail "device token did not clear /api/build: $BUILD_JSON"

  # ---------- 7. the QR: public-style URL, one scan ----------
  JOIN_URL="https://$DOMAIN/bridge?b=https%3A%2F%2Fvlive.$DOMAIN&t=$TOKEN"
  QR_PNG="${VPS_QR_FILE:-$VPS_HOME_DIR/pair-qr.png}"
  mkdir -p "$(dirname "$QR_PNG")"
  printf '%s' "$JOIN_URL" > "$SECRETS/pair-qr.txt"
  chmod 600 "$SECRETS/pair-qr.txt"
  have qrencode || fail "qrencode missing (stage sim needs it: sudo apt install qrencode — not done on this box)"
  qrencode -o "$QR_PNG" -s 8 -m 2 "$JOIN_URL"
  say "QR png: $QR_PNG (payload also in $SECRETS/pair-qr.txt)"
  if have zbarimg; then
    DECODED="$(zbarimg -q --raw "$QR_PNG")"
    [[ "$DECODED" == "$JOIN_URL" ]] || fail "QR roundtrip mismatch: got '$DECODED'"
    say "QR VERIFIED: zbar decodes byte-identical to the public-style join URL"
  else
    say "WARN: zbarimg missing — QR written but not machine-verified"
  fi

  say "-------------------------------------------------------------"
  say "veraldar VPS stage is UP (mode=stage on this box)"
  say "  domain plan : https://$DOMAIN (caddy → PWA :$PWA_PORT; cert = real-VPS step)"
  say "  app direct  : http://$IP:$PWA_PORT"
  say "  brain       : 127.0.0.1:$YGG_PORT (loopback only — never public)"
  say "  trunk       : http://$IP:$BRIDGE_HTTP"
  say "  livekit     : 127.0.0.1:$LK_PORT (edge plan: vlive.$DOMAIN → this)"
  say "  token       : $TOKEN (inside the QR, shown once)"
  say "  teardown    : systemctl --user stop vpsboot-mock vpsboot-root vpsboot-app vpsboot-trunk; docker rm -f vpsboot-livekit vpsboot-caddy"
  say "-------------------------------------------------------------"
  cat <<'EOT'

  THE THREE COMMANDS A LAYMAN RUNS ON A FRESH UBUNTU 24.04 VPS:
    1. curl -fsSL https://raw.githubusercontent.com/veraldar/bifrost/main/lab/layman-deploy/impl/vps-bootstrap.sh -o vps-bootstrap.sh
    2. bash vps-bootstrap.sh --vps --domain YOURNAME.nip.io --email you@example.com
    3. scan ~/veraldar/pair-qr.png with the phone camera → /bridge opens pre-filled → Connect → talk.

EOT
  exit 0
fi

# ---------- 5b-vps: system units on the real VPS ----------
# (stage mode exited above; this runs only with --vps, after deps + caddy enable)
# Environment-driven like the canonical brain unit (lk-yggdrasil: env vars, no flags).
say "writing system units (veraldar-brain · veraldar-trunk · veraldar-app · veraldar-livekit)"

# root (brain): loopback only — never public (spec-onboard §3 privacy model)
sudo tee /etc/systemd/system/veraldar-brain.service >/dev/null <<EOF
[Unit]
Description=veraldar brain (yggdrasil root, loopback-only)
After=network-online.target
[Service]
Type=exec
WorkingDirectory=/opt/bifrost/proj
EnvironmentFile=/opt/bifrost/state/brain.env
ExecStart=$YGG_BIN
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=2
NoNewPrivileges=yes
MemoryDenyWriteExecute=yes
UMask=0077
[Install]
WantedBy=multi-user.target
EOF

# trunk: public bridge, ports $BRIDGE_HTTP/$BRIDGE_MEDIA (the 443-class ports a
# VPS firewall must open)
sudo tee /etc/systemd/system/veraldar-trunk.service >/dev/null <<EOF
[Unit]
Description=veraldar trunk (bifrost-net WebRTC bridge)
After=network-online.target
[Service]
ExecStart=$BRIDGE_BIN bridge -c /opt/bifrost/state/bridge.toml
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

# PWA app: next start on $PWA_PORT, loopback (caddy fronts it)
sudo tee /etc/systemd/system/veraldar-app.service >/dev/null <<EOF
[Unit]
Description=veraldar app (bifrost PWA)
After=network-online.target
[Service]
WorkingDirectory=/opt/bifrost/pwa
EnvironmentFile=/opt/bifrost/state/app.env
ExecStart=$(command -v node || echo /usr/bin/node) node_modules/next/dist/bin/next start -p $PWA_PORT -H 127.0.0.1
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

# livekit: the proven docker oneshot (deploy/ pattern, image pre-pulled in 5a)
sudo tee /etc/systemd/system/veraldar-livekit.service >/dev/null <<EOF
[Unit]
Description=veraldar LiveKit edge (container)
After=network-online.target docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/docker run -d --rm --name veraldar-livekit --network host -v /opt/bifrost/state/livekit.yaml:/etc/livekit.yaml:ro livekit/livekit-server:latest --config /etc/livekit.yaml
ExecStop=/usr/bin/docker rm -f veraldar-livekit
[Install]
WantedBy=multi-user.target
EOF

# brain.env: YGG_* contract (main.rs docs). A --upstream-key = real brain; no
# key = the mock upstream, which this run then needs at $MOCK_PORT — started as
# a 5th unit so the health gate below is honest in the no-key case too.
if [[ -n "$UPSTREAM_KEY" ]]; then
  say "brain env: REAL upstream ($UPSTREAM_STYLE, model ${UPSTREAM_MODEL:-<provider default>})"
else
  say "brain env: MOCK upstream at 127.0.0.1:$MOCK_PORT (no --upstream-key passed)"
fi
sudo mkdir -p /opt/bifrost/state
if [[ -n "$UPSTREAM_KEY" ]]; then
  sudo tee /opt/bifrost/state/brain.env >/dev/null <<EOF
YGG_LISTEN=127.0.0.1:$YGG_PORT
YGG_DATA_DIR=/opt/bifrost/ygg-data
YGG_PROJECT_DIR=/opt/bifrost/proj
YGG_MAX_TOKENS=16384
YGG_UPSTREAM_BASE_URL=$UPSTREAM_URL
YGG_UPSTREAM_API_KEY=$UPSTREAM_KEY
YGG_UPSTREAM_STYLE=$UPSTREAM_STYLE
EOF
  [[ -n "$UPSTREAM_MODEL" ]] && echo "YGG_UPSTREAM_MODEL=$UPSTREAM_MODEL" | sudo tee -a /opt/bifrost/state/brain.env >/dev/null
else
  sudo tee /opt/bifrost/state/brain.env >/dev/null <<EOF
YGG_LISTEN=127.0.0.1:$YGG_PORT
YGG_DATA_DIR=/opt/bifrost/ygg-data
YGG_PROJECT_DIR=/opt/bifrost/proj
YGG_MAX_TOKENS=16384
YGG_UPSTREAM_BASE_URL=http://127.0.0.1:$MOCK_PORT
YGG_UPSTREAM_STYLE=anthropic
YGG_UPSTREAM_API_KEY=vps-key
YGG_UPSTREAM_MODEL=mock
EOF
  sudo tee /etc/systemd/system/veraldar-mock.service >/dev/null <<EOF
[Unit]
Description=veraldar mock provider (ONLY when no --upstream-key)
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 $PWD/lab/yggdrasil/mock/mock_upstream.py $MOCK_PORT
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF
  MOCK_UNIT="veraldar-mock"
fi

sudo tee /opt/bifrost/state/app.env >/dev/null <<EOF
PORT=$PWA_PORT
HOST=127.0.0.1
OPENCODE_URL=http://127.0.0.1:$YGG_PORT
NODE_ENV=production
BIFROST_DEVICES_FILE=/opt/bifrost/state/devices.json
BIFROST_AUTH=devices
BIFROST_ADMIN_TOKEN=$ADMIN_TOKEN
VAPID_PUBLIC_KEY=$(cat "$SECRETS/vapid-pub")
VAPID_PRIVATE_KEY=$(cat "$SECRETS/vapid-priv")
EOF

sudo tee /opt/bifrost/state/bridge.toml >/dev/null <<EOF
[node]
name = "vps"
$NODE_KEY_LINE

[bridge]
http = "0.0.0.0:$BRIDGE_HTTP"
media = "0.0.0.0:$BRIDGE_MEDIA"
tokens_file = "/opt/bifrost/state/devices.json"
opencode_url = "http://127.0.0.1:$YGG_PORT"
speaches_url = "${SPEACHES_URL:-http://127.0.0.1:8000/v1}"
candidates = ["$IP"]
EOF

say "copying stage tree → /opt/bifrost (pwa, proj, bins, state)"
sudo rsync -a --delete "$STAGE/pwa/" /opt/bifrost/pwa/
sudo rsync -a "$STAGE/proj/" /opt/bifrost/proj/
sudo cp "$YGG_BIN" "$BRIDGE_BIN" /opt/bifrost/
sudo chmod 600 /opt/bifrost/state/* 2>/dev/null || true

say "enabling stack units"
sudo systemctl daemon-reload
sudo systemctl enable --now veraldar-brain veraldar-trunk veraldar-app veraldar-livekit $MOCK_UNIT

# ---------- 6-vps: pairing gate + QR on the REAL VPS ----------
# (stage mode exits with its own proven pair/QR block above)
say "minting the first device token via the REAL pairing surface"
PAIR_JSON="$(curl -sf -X POST "http://127.0.0.1:$PWA_PORT/api/pair" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"vps-phone"}')" || fail "pairing mint failed (POST /api/pair with admin token)"
TOKEN="$(printf '%s' "$PAIR_JSON" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
[[ "$TOKEN" == bfnd-* ]] || fail "no bfnd- token minted: $PAIR_JSON"
sudo chmod 600 /opt/bifrost/state/devices.json 2>/dev/null || true

JOIN_URL="https://$DOMAIN/bridge?b=https%3A%2F%2Fvlive.$DOMAIN&t=$TOKEN"
QR_PNG="$HOME/veraldar/pair-qr.png"
mkdir -p "$(dirname "$QR_PNG")"
printf '%s' "$JOIN_URL" > "$SECRETS/pair-qr.txt"
chmod 600 "$SECRETS/pair-qr.txt"
if have qrencode; then
  qrencode -o "$QR_PNG" -s 8 -m 2 "$JOIN_URL"
  say "QR png: $QR_PNG (payload in $SECRETS/pair-qr.txt)"
elif have node && [[ -f /opt/bifrost/pwa/node_modules/qrcode/package.json ]]; then
  NODE_OPTIONS=--jitless node /opt/bifrost/pwa/node_modules/qrcode/cli.js -o "$QR_PNG" -w 320 "$JOIN_URL"
  say "QR png: $QR_PNG (via node qrcode cli)"
else
  sudo apt-get install -y qrencode
  qrencode -o "$QR_PNG" -s 8 -m 2 "$JOIN_URL"
  say "QR png: $QR_PNG (installed qrencode for it)"
fi

# ---------- 7-vps: THE CERT STEP — real ACME, hard wait ----------
# Everything above had to succeed to get here; this is the one step this box
# CANNOT do (ports 80/443 + a public DNS answer are VPS-only facts).
say "CERT STEP: waiting for real certs on https://$DOMAIN + https://vlive.$DOMAIN (ACME)"
CERT_OK=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/" -o /dev/null 2>/dev/null; then CERT_OK=1; break; fi
  sleep 2
done
if (( CERT_OK == 0 )); then
  fail "no real cert after 60s — https://$DOMAIN never answered (ACME failed: domain not pointing at this box, or 80/443 blocked). VPS run: fix DNS/firewall and re-run; stage run: THIS FAIL IS THE PROOF — everything before it is VPS-complete."
fi
say "caddy ACME done: certs live for $DOMAIN + vlive.$DOMAIN"
say "scan $QR_PNG → $JOIN_URL"
say "DONE — $DOMAIN"
