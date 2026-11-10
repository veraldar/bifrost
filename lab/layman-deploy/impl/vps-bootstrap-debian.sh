#!/usr/bin/env bash
# vps-bootstrap-debian.sh — the REAL VPS run of the proven trunk deploy path.
#
# Adapted from lab/layman-deploy/impl/vps-bootstrap.sh (whose --stage mode is
# GREEN on the dev tree) with ONLY the Debian-trixie apt deltas + the
# fresh-system realities of a 1 vCPU / 2 GB RAM box:
#   - deps: docker.io + docker-compose (Debian pkg, no get.docker.com),
#     nodejs 20 (trixie's own — next 15 engines is >=20, NodeSource NOT needed),
#     git rsync qrencode zbar-tools (all non-interactive).
#   - RAM: adds 1G swapfile when total swap < 1G (2GB box, speaches int8).
#   - speech: deploy/'s compose FALLBACK (speaches cpu container on :8000,
#     127.0.0.1 only) — the Mac MLX endpoint is unreachable from a VPS.
#   - private LAN/iface: public IP is on the NIC (Infomaniak) — read from it.
#   - firewall: one ufw allow for the trunk media port (idempotent).
#   - caddy: DEBIAN's caddy serves veraldar.org already — this script ONLY
#     appends a marked nip.io block between markers and reloads. Never touches
#     the existing config. If the marker block exists it is replaced in place.
#   - idempotent: re-run = update (secrets/keys/configs never overwritten;
#     units stopped then re-written; compose re-uped).
#
# Runs on the VPS as a sudo-capable user (debian). Exit 0 = units healthy +
# QR minted. One command: bash vps-bootstrap-debian.sh --nip 179-237-67-146
set -euo pipefail

NIP_NAME=""      # --nip <name>  → https://<name>.nip.io  (name like 179-237-67-146)
DOMAIN=""        # --domain <d>  → real domain (alternative to --nip)
EMAIL=""         # --email       → ACME contact (recommended)
PORT_BASE="${VPS_PORT_BASE:-8235}"
STAGE="${VPS_STAGE_DIR:-$HOME/vps-test}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nip) NIP_NAME="${2:?}"; shift ;;
    --domain) DOMAIN="${2:?}"; shift ;;
    --email) EMAIL="${2:?}"; shift ;;
    --ports) PORT_BASE="${2:?}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { echo "[vps-boot] $*"; }
fail() { echo "[vps-boot] FAIL: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 0. domain: nip.io from the NIC's public IP ----------
if [[ -n "$NIP_NAME" ]]; then
  DOMAIN="${NIP_NAME}.nip.io"
elif [[ -z "$DOMAIN" ]]; then
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' | head -1 || true)"
  [[ -n "$IP" ]] || fail "no public IP on the NIC — pass --nip <name> or --domain <d>"
  DOMAIN="$(echo "$IP" | tr . -).nip.io"
fi
PUB_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
[[ -n "$PUB_IP" ]] || fail "DNS does not resolve: $DOMAIN"

PWA_PORT=$PORT_BASE             # 8235 — next start
YGG_PORT=$((PORT_BASE + 1))     # 8236 — brain (loopback only)
MOCK_PORT=$((PORT_BASE + 2))    # 8237 — mock provider (loopback only)
BRIDGE_HTTP=$((PORT_BASE + 3))  # 8238 — trunk signaling (public via vlive.)
BRIDGE_MEDIA=$((PORT_BASE + 4)) # 8239/udp — trunk media (public, ufw)
SPEACH_PORT=8000               # compose speaches (127.0.0.1 only)

SECRETS="$STAGE/state"
mkdir -p "$SECRETS"
say "domain: $DOMAIN (→ $PUB_IP) · ports app:$PWA_PORT brain:$YGG_PORT trunk:$BRIDGE_HTTP/udp$BRIDGE_MEDIA"

# ---------- 1. Debian deps (idempotent; non-interactive) ----------
NEED=()
have docker    || NEED+=(docker.io docker-cli containerd runc)
have docker-compose || NEED+=(docker-compose)
have node      || NEED+=(nodejs)
have git       || NEED+=(git)
have rsync     || NEED+=(rsync)
have qrencode  || NEED+=(qrencode)
have zbarimg   || NEED+=(zbar-tools)
# next.config.ts (TS) needs typescript at RUNTIME + npm must exist (Debian's
# nodejs ships without npm) — the brain/trunk stay apt-only:
NEED+=(node-typescript)
have npm || NEED+=(npm)
ldconfig -p 2>/dev/null | grep -q 'libopus.so.0' || NEED+=(libopus0)
if ((${#NEED[@]})); then
  say "apt install (trixie): ${NEED[*]}"
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${NEED[@]}"
fi
have docker && have node && have qrencode || fail "deps still missing after apt"
say "docker $(docker --version | grep -o '[0-9.]*' | head -1) · node $(node --version)"

# ---------- 2. RAM: 1G swap when swap < 1G (2GB box + speaches int8) ----------
SWAP_MB="$(awk '/^SwapTotal:/{printf "%d", $2/1024}' /proc/meminfo)"
if (( SWAP_MB < 1000 )); then
  say "swap ${SWAP_MB}MB < 1G — adding 1G swapfile"
  sudo -n mkdir -p /swap
  [[ -f /swap/swapfile ]] || sudo -n dd if=/dev/zero of=/swap/swapfile bs=1M count=1024 status=none
  sudo -n chmod 600 /swap/swapfile
  sudo -n mkswap -q /swap/swapfile
  sudo -n swapon /swap/swapfile 2>/dev/null || true
  grep -q '^/swap/swapfile' /etc/fstab || echo '/swap/swapfile none swap sw 0 0' | sudo -n tee -a /etc/fstab >/dev/null
  say "swap now: $(awk '/^SwapTotal:/{printf "%dMB", $2/1024}' /proc/meminfo)"
else
  say "swap OK (${SWAP_MB}MB) — not touched"
fi

# ---------- 3. payload: untar the uploaded stage (idempotent) ----------
# typescript must resolve from the app dir (next.config.ts is TS): link the
# apt-installed TS into the staged node_modules (npm's node_modules/… layout).
if [[ -d /usr/share/nodejs/typescript && ! -e "$HOME/vps-test/pwa/node_modules/typescript" ]]; then
  ln -s /usr/share/nodejs/typescript "$HOME/vps-test/pwa/node_modules/typescript" 2>/dev/null || true
fi
UP="$HOME/vps-test-upload"
[[ -f "$UP/nm-prod.tgz" && -f "$UP/pwa-next.tgz" && -f "$UP/bins.tgz" ]] || fail "payload missing in $UP"
mkdir -p "$STAGE/pwa" "$STAGE/proj" "$STAGE/ygg" "$STAGE/bins"
tar -xzf "$UP/bins.tgz" -C "$STAGE"             # bins/{yggdrasil,bifrost-net}
chmod +x "$STAGE"/bins/*
tar -xzf "$UP/pwa-next.tgz" -C "$STAGE/pwa"     # .next (cache already excluded)
rm -rf "$STAGE/pwa/.next/cache"
tar -xzf "$UP/misc.tgz" -C "$STAGE"             # mock/, fixtures/, package.json, next.config.ts
mkdir -p "$STAGE/pwa/node_modules"
tar -xzf "$UP/nm-prod.tgz" -C "$STAGE/pwa"      # prod-closure node_modules
YGG_BIN="$STAGE/bins/yggdrasil"
BRIDGE_BIN="$STAGE/bins/bifrost-net"
MOCK_PY="$STAGE/mock/mock_upstream.py"
[[ -x "$YGG_BIN" && -x "$BRIDGE_BIN" && -f "$MOCK_PY" ]] || fail "staged binaries/mock missing"
say "payload staged in $STAGE"

# ---------- 4. secrets: mint if absent, NEVER overwrite ----------
mint_if_absent() { local f="$1"; shift
  if [[ -f "$f" ]]; then say "keep  $(basename "$f")"; return; fi
  "$@" > "$f"; chmod 600 "$f"; say "mint  $(basename "$f")"; }
mint_if_absent "$SECRETS/livekit-secret" openssl rand -hex 24
mint_if_absent "$SECRETS/admin-token"    sh -c 'echo "bfad-$(openssl rand -hex 24)"'
ADMIN_TOKEN="$(cat "$SECRETS/admin-token")"

cat > "$STAGE/pwa/.env.local" <<EOF
OPENCODE_URL=http://127.0.0.1:$YGG_PORT
AGENT_NAME=vps-none
AGENT_DISPATCH_NAME=vps-none
BIFROST_DEVICES_FILE=$SECRETS/devices.json
BIFROST_AUTH=devices
BIFROST_ADMIN_TOKEN=$ADMIN_TOKEN
EOF
chmod 600 "$STAGE/pwa/.env.local"

# ---------- 5. speech stack: deploy/'s compose FALLBACK (speaches cpu) ----------
# docker was just apt-installed: our user is in the docker group but the
# membership needs a fresh session — existing shells use sudo docker.
DC_RUN() { if docker info >/dev/null 2>&1; then "$@"; else sudo -n "$@"; fi; }
COMPOSE_DIR="$STAGE/speech"
mkdir -p "$COMPOSE_DIR"
if [[ -f "$COMPOSE_DIR/docker-compose.yml" ]]; then
  say "keep  speech compose file"
else
  cat > "$COMPOSE_DIR/docker-compose.yml" <<'EOF'
services:
  speaches:
    image: ghcr.io/speaches-ai/speaches:latest-cpu
    restart: unless-stopped
    environment:
      WHISPER__COMPUTE_TYPE: int8
      STT_MODEL_TTL: -1
      TTS_MODEL_TTL: -1
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - speaches-hf:/home/ubuntu/.cache/huggingface/hub
volumes:
  speaches-hf:
EOF
fi
cd "$COMPOSE_DIR"
DC_RUN docker-compose up -d 2>&1 | tail -1
cd - >/dev/null

# ---------- 6. firewall: ONE ufw allow for the trunk media port ----------
if have ufw; then
  sudo -n ufw status | grep -q "$BRIDGE_MEDIA/udp" || sudo -n ufw allow "$BRIDGE_MEDIA/udp" comment 'trunk media'
  say "ufw: $BRIDGE_MEDIA/udp open (22/80/443 already were)"
fi

# ---------- 7. units: system units (fresh VPS — user lingering is the alt) ----------
say "writing + starting system units vps-boot-{mock,brain,app,trunk}"
for u in vps-boot-trunk vps-boot-app vps-boot-brain vps-boot-mock; do
  sudo -n systemctl stop "$u" 2>/dev/null || true
done
sudo -n tee /etc/systemd/system/vps-boot-mock.service >/dev/null <<EOF
[Unit]
Description=vps-boot mock provider
After=network.target
[Service]
ExecStart=/usr/bin/python3 $MOCK_PY $MOCK_PORT
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
sudo -n tee /etc/systemd/system/vps-boot-brain.service >/dev/null <<EOF
[Unit]
Description=vps-boot brain (yggdrasil, loopback)
After=network.target vps-boot-mock.service
[Service]
WorkingDirectory=$STAGE/proj
Environment=YGG_UPSTREAM_BASE_URL=http://127.0.0.1:$MOCK_PORT
Environment=YGG_UPSTREAM_STYLE=anthropic
Environment=YGG_UPSTREAM_API_KEY=vps-key
Environment=YGG_UPSTREAM_MODEL=mock
Environment=YGG_LISTEN=127.0.0.1:$YGG_PORT
Environment=YGG_DATA_DIR=$STAGE/ygg
Environment=YGG_PROJECT_DIR=$STAGE/proj
Environment=YGG_MAX_TOKENS=16384
Environment=YGG_VOICE=1
Environment=YGG_VOICE_MAX_WORDS=60
ExecStart=$YGG_BIN
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
sudo -n tee /etc/systemd/system/vps-boot-app.service >/dev/null <<EOF
[Unit]
Description=vps-boot app (bifrost PWA)
After=network.target vps-boot-brain.service
[Service]
WorkingDirectory=$STAGE/pwa
Environment=PORT=$PWA_PORT
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
Environment=OPENCODE_URL=http://127.0.0.1:$YGG_PORT
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p $PWA_PORT -H 127.0.0.1
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
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
speaches_url = "http://127.0.0.1:$SPEACH_PORT/v1"
candidates = ["127.0.0.1", "$PUB_IP"]
EOF
chmod 600 "$SECRETS/bridge.toml"
sudo -n tee /etc/systemd/system/vps-boot-trunk.service >/dev/null <<EOF
[Unit]
Description=vps-boot trunk (bifrost-net bridge)
After=network.target vps-boot-brain.service
[Service]
Environment=SPEACHES_URL=http://127.0.0.1:$SPEACH_PORT/v1
Environment=V9_STT_MODEL=Systran/faster-whisper-small
Environment=V9_TTS_MODEL=speaches-ai/Kokoro-82M-v1.0-ONNX
ExecStart=$BRIDGE_BIN bridge -c $SECRETS/bridge.toml
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now vps-boot-mock vps-boot-brain vps-boot-app vps-boot-trunk >/dev/null 2>&1
for u in vps-boot-mock vps-boot-brain vps-boot-app vps-boot-trunk; do
  systemctl is-active --quiet "$u" || { journalctl -u "$u" -n 12 --no-pager | tail -12; fail "$u not active"; }
done
say "units active: mock brain app trunk"

# ---------- 8. health waits ----------
wait_http() { local url="$1" secs="$2" label="$3"
  for _ in $(seq $(( secs * 4 ))); do
    curl -sf -o /dev/null "$url" 2>/dev/null && { say "health OK: $label"; return 0; }
    sleep 0.25
  done
  fail "$label did not answer: $url"; }
wait_http "http://127.0.0.1:$MOCK_PORT/calls"   20 "mock provider"
wait_http "http://127.0.0.1:$YGG_PORT/session"  30 "brain"
wait_http "http://127.0.0.1:$PWA_PORT/"         90 "app (PWA)"
for _ in $(seq 80); do curl -sf "http://127.0.0.1:$SPEACH_PORT/health" >/dev/null 2>&1 && break; sleep 2; done
curl -sf "http://127.0.0.1:$SPEACH_PORT/health" >/dev/null || fail "speaches did not answer /health"
say "health OK: speaches ($(DC_RUN docker ps --format '{{.Names}} {{.Status}}' | grep speaches))"

# ---------- 9. caddy: APPEND a marked block — never touch veraldar.org ----------
CADDY_MARK="# === BEGIN vps-boot nip.io test block (generated; safe to delete) ==="
CADDY_END="# === END vps-boot nip.io test block ==="
CADDY_TMP="$SECRETS/Caddyfile.new"
sudo -n cp /etc/caddy/Caddyfile "$SECRETS/Caddyfile.bak"
sudo -n cat /etc/caddy/Caddyfile > "$CADDY_TMP"
python3 - "$CADDY_TMP" "$DOMAIN" "$PWA_PORT" "$BRIDGE_HTTP" "$CADDY_MARK" "$CADDY_END" <<'EOF'
import sys, re
path, domain, pwa, bridge, mark, end = sys.argv[1:7]
src = open(path).read()
block = f"""{mark}
{domain} {{
	reverse_proxy 127.0.0.1:{pwa}
}}

vlive.{domain} {{
	reverse_proxy http://127.0.0.1:{bridge}
}}
{end}"""
# replace existing marked block in place, else append
pat = re.compile(re.escape(mark) + r".*?" + re.escape(end), re.S)
src = pat.sub(lambda m: block, src) if pat.search(src) else src + "\n" + block + "\n"
open(path, "w").write(src)
EOF
sudo -n caddy validate --config "$CADDY_TMP" >/dev/null 2>&1 || fail "caddy config invalid after edit"
if sudo -n caddy adapt --config "$CADDY_TMP" 2>/dev/null | grep -q '"answer_port"'; then :; fi
sudo -n cp "$CADDY_TMP" /etc/caddy/Caddyfile
sudo -n systemctl reload caddy
say "caddy reloaded — existing veraldar.org block untouched (backup: state/Caddyfile.bak)"

# ---------- 10. cert wait: real Let's Encrypt via nip.io ----------
CERT_OK=0
for i in $(seq 1 40); do
  if curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "https://$DOMAIN/" 2>/dev/null | grep -q '40[13]'; then CERT_OK=1; break; fi
  sleep 3
done
if (( CERT_OK )); then
  ISSUER="$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)"
  say "TLS up: $ISSUER"
else
  say "WARN: cert not confirmed after 120s — caddy retries in background (check step 10b)"
fi

# ---------- 11. pair: mint the first device via the REAL pairing surface ----------
PAIR_JSON="$(curl -sf -X POST "http://127.0.0.1:$PWA_PORT/api/pair" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"vps-phone"}')" || fail "pairing mint failed"
TOKEN="$(printf '%s' "$PAIR_JSON" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
[[ "$TOKEN" == bfnd-* ]] || fail "no bfnd- token minted: $PAIR_JSON"
chmod 600 "$SECRETS/devices.json" 2>/dev/null || true
BUILD_JSON="$(curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PWA_PORT/api/build")"
printf '%s' "$BUILD_JSON" | grep -q '"id"' || fail "device token did not clear /api/build: $BUILD_JSON"
say "pair minted (bfnd-…${TOKEN: -6}) and clears /api/build"

# ---------- 12. the QR: public https join URL, one scan ----------
JOIN_URL="https://$DOMAIN/bridge?b=https%3A%2F%2Fvlive.$DOMAIN&t=$TOKEN"
QR_PNG="${VPS_QR_FILE:-$STAGE/pair-qr.png}"
QR_TXT="$STAGE/state/pair-qr.txt"
printf '%s' "$JOIN_URL" > "$QR_TXT"; chmod 600 "$QR_TXT"
qrencode -o "$QR_PNG" -s 8 -m 2 "$JOIN_URL"
DECODED="$(zbarimg -q --raw "$QR_PNG")"
[[ "$DECODED" == "$JOIN_URL" ]] || fail "QR roundtrip mismatch"
say "QR VERIFIED (zbar byte-identical): $QR_PNG"

say "-------------------------------------------------------------"
say "VPS trunk stage UP: https://$DOMAIN  ·  join $JOIN_URL"
say "teardown: sudo systemctl disable --now vps-boot-{mock,brain,app,trunk}; cd $STAGE/speech && docker-compose down"
say "caddy rollback: sudo cp $SECRETS/Caddyfile.bak /etc/caddy/Caddyfile && sudo systemctl reload caddy"
say "-------------------------------------------------------------"
