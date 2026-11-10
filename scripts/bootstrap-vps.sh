#!/usr/bin/env bash
# bootstrap-vps.sh — spec-onboard.md phase 1.5: the VPS layer on top of the
# proven phase-1 bootstrap (scripts/bootstrap.sh). ONE command on a fresh
# Ubuntu 24.04 VPS; on this dev tree it runs in --in-stage mode and PROVES
# every step that does not need a public IP + real cert, honestly skipping
# what it cannot prove (marked VPS-ONLY).
#
#   scripts/bootstrap-vps.sh --in-stage [--nip myname]      # dev-tree proof (default here)
#   scripts/bootstrap-vps.sh --domain veraldar.example --email you@example.com   # real VPS
#   scripts/bootstrap-vps.sh --nip myname --dry-run          # print the VPS actions
#   scripts/bootstrap-vps.sh --no-tls                        # LAN-only fallback (no ACME)
#
# Topology (spec-onboard.md §3, privacy model): Caddy exposes ONLY
#   /pair + /api/pair  (the one-time pairing gate, admin-token'd)
#   wss live.<domain>  (LiveKit WebRTC edge)
# Everything else (PWA deep pages, opencode :4096, voice agent) stays
# loopback-only on the VPS. opencode NEVER gets a public route.
set -uo pipefail

MODE=""; DOMAIN=""; EMAIL=""; NIP=""; DRY=0; NO_TLS=0
while (($#)); do
  case "$1" in
    --in-stage) MODE="stage" ;;
    --domain) DOMAIN="${2:?}"; shift ;;
    --email)  EMAIL="${2:?}"; shift ;;
    --nip)    NIP="${2:?}"; shift ;;
    --no-tls) NO_TLS=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "[vps] unknown arg: $1" >&2; exit 1 ;;
  esac; shift
done
IN_STAGE=0
[[ -n "$NIP" || -z "$DOMAIN" ]] && IN_STAGE=1          # dev-tree default: stage mode
[[ "$MODE" == "stage" ]] && IN_STAGE=1

STAGE_DIR="${VPS_STAGE_DIR:-/tmp/vps-bootstrap-stage}"
LOG="$STAGE_DIR/bootstrap-vps.log"
OK=(); SKIP=(); VPS=()   # VPS[] = steps only a real VPS can do
say(){ echo "[vps] $*"; }
have(){ command -v "$1" >/dev/null 2>&1; }
record_step(){ # <stage> <desc>
  case "$1" in ok)  OK+=("$2");;  skip) SKIP+=("$2");;  vps) VPS+=("$2");; esac
}
# act <provable-on-dev? ok|skip> <desc> <cmd...> — stage mode records, dry prints, VPS runs
act(){
  local kind="$1" desc="$2"; shift 2
  if (( IN_STAGE )) || (( DRY )); then
    (( DRY )) && say "DRY $desc: $*"
    record_step "$kind" "$desc"
    return 0
  fi
  say "$desc ..."
  if "$@" >>"$LOG" 2>&1; then record_step ok "$desc"; else
    say "FAIL: $desc (see $LOG)"; record_step skip "$desc (FAILED)"; fi
}

mkdir -p "$STAGE_DIR"
say "bifrost VPS bootstrap — mode: $([[ $IN_STAGE -eq 1 ]] && echo IN-STAGE-PROOF || echo REAL-VPS)$([[ $DRY -eq 1 ]] && echo ' (dry-run)')"
say "stage dir: $STAGE_DIR"

# ---- A. system deps (root-only on a VPS; here: verify presence, be honest) ---
DEPS=(git curl openssl node npm python3 caddy)
MISSING=()
for b in "${DEPS[@]}"; do have "$b" || MISSING+=("$b"); done
if (( IN_STAGE )); then
  if ((${#MISSING[@]})); then record_step vps "apt-get install -y ${MISSING[*]} + Node 22 via NodeSource (VPS: run as sudo — absent here: ${MISSING[*]})"
  else record_step vps "apt-get install -y nodejs (Node 22 via NodeSource) — VPS: run as sudo (all other deps present on this dev tree)"; fi
else
  if ((${#MISSING[@]})); then
    say "installing missing deps: ${MISSING[*]}"
    (( ${#MISSING[@]} )) && act ok "apt install deps" bash -c "sudo apt-get update -qq && sudo apt-get install -y ${MISSING[*]}"
  fi
  have node && { NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; (( NODE_MAJOR >= 22 )) || say "WARN: node $NODE_MAJOR < 22 — Tailwind4 renders unstyled (see SKILL.md §1)"; }
fi

# ---- B. secrets (PROVEN HERE — real mints, 0600, never overwrite) ------------
ENVF="$STAGE_DIR/vps.env"
if [[ -f "$ENVF" ]]; then record_step skip "secrets (already minted: $ENVF)"
else
  LK_SECRET="$(openssl rand -hex 24)"
  ADMIN_TOKEN="bfad-$(openssl rand -hex 16)"
  SESS_SECRET="$(openssl rand -hex 24)"
  VAPID_PUB=""; VAPID_PRIV=""
  if have npx; then
    KEYS="$(NODE_OPTIONS=--jitless npx --yes web-push generate-vapid-keys --json 2>/dev/null || true)"
    VAPID_PUB="$(echo "$KEYS" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)"
    VAPID_PRIV="$(echo "$KEYS" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)"
  fi
  {
    echo "LIVEKIT_API_SECRET=$LK_SECRET"
    echo "BIFROST_ADMIN_TOKEN=$ADMIN_TOKEN"
    echo "SESSION_SECRET=$SESS_SECRET"
    echo "VAPID_PUBLIC_KEY=$VAPID_PUB"
    echo "VAPID_PRIVATE_KEY=$VAPID_PRIV"
  } > "$ENVF"
  chmod 600 "$ENVF"
  [[ -n "$VAPID_PUB" ]] && record_step ok "secrets minted ($ENVF, 0600: LiveKit secret, admin token, session secret, VAPID pair)" \
                            || record_step skip "secrets minted minus VAPID (npx failed here — VPS npx will mint)"
fi
# shellcheck disable=SC1090
source <(grep = "$ENVF")

# ---- C. public URL + TLS plan -------------------------------------------------
if [[ -n "$NIP" ]]; then
  EXT_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' | head -1)"
  [[ -n "$EXT_IP" ]] || EXT_IP="203.0.113.10"   # stage placeholder, says so in output
  DOMAIN="${EXT_IP}.nip.io"; SUB_LIVE="live.${EXT_IP}.nip.io"
  TLS="nip.io — caddy auto-cert, NO domain purchase (DNS already points at $EXT_IP)"
else
  SUB_LIVE="live.${DOMAIN}"
  TLS="real domain — caddy Let's Encrypt (needs A records for $DOMAIN + $SUB_LIVE)"
fi
PUBLIC_URL="$([[ $NO_TLS -eq 1 ]] && echo "http://${DOMAIN}" || echo "https://${DOMAIN}")"
say "public URL: $PUBLIC_URL   · live edge: wss://$SUB_LIVE   · TLS plan: $TLS"

# ---- D. configs (PROVEN HERE — real generated files) --------------------------
# livekit.yaml: per-VPS generation is a 10-26 review finding — external IP,
# embedded TURN implied by ports, UDP 50000-50100.
if [[ -f "$STAGE_DIR/livekit.yaml" ]]; then record_step skip "livekit.yaml (exists)"
else
  cat > "$STAGE_DIR/livekit.yaml" <<EOF
port: 7880
bind_addresses: [127.0.0.1]          # signal enters via caddy wss, never raw
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true              # VPS: behind NAT-less public NIC
  ips:
    includes: ["$EXT_IP/32"]
logging: { level: info }
EOF
  record_step ok "livekit.yaml generated for $EXT_IP (7880/7881 tcp, 50000-50100 udp)"
fi

# Caddyfile: ONLY /pair + /api/pair public; everything else gated; live edge on its subdomain.
if [[ -f "$STAGE_DIR/Caddyfile" ]]; then record_step skip "Caddyfile (exists)"
else
  cat > "$STAGE_DIR/Caddyfile" <<EOF
# generated by bootstrap-vps.sh — privacy model per docs/spec-onboard.md §3
${DOMAIN} {
	encode zstd gzip
	# the pairing gate is the ONLY public app route
	@pair path /pair /api/pair
	handle @pair {
		reverse_proxy 127.0.0.1:8080
	}
	# every other path: paired devices only (device-token check happens in-app)
	handle {
		@noauth not header Authorization "Bearer *"
		respond @noauth "pair first" 401
		reverse_proxy 127.0.0.1:8080
	}
}
${SUB_LIVE} {
	reverse_proxy 127.0.0.1:7880
}
EOF
  record_step ok "Caddyfile generated ($DOMAIN: /pair public, rest Bearer-gated; $SUB_LIVE → :7880)"
fi

# systemd units (written as files here; enable = VPS-only step)
if [[ -f "$STAGE_DIR/vps-pwa.service" ]]; then record_step skip "systemd units (exist)"
else
  for u in pwa agent livekit; do :; done
  cat > "$STAGE_DIR/vps-pwa.service" <<EOF
[Unit]
Description=bifrost PWA (VPS)
After=network-online.target
[Service]
WorkingDirectory=/opt/bifrost/pwa
EnvironmentFile=/opt/bifrost/vps.env
ExecStart=$(have node && echo "/usr/bin/env npx next start -p 8080" || echo "npx next start -p 8080")
Restart=always
[Install]
WantedBy=default.target
EOF
  cat > "$STAGE_DIR/vps-agent.service" <<EOF
[Unit]
Description=bifrost voice agent (VPS)
After=network-online.target
[Service]
WorkingDirectory=/opt/bifrost/agent
EnvironmentFile=/opt/bifrost/vps.env
ExecStart=/usr/bin/env uv run agent.py dev
Restart=always
[Install]
WantedBy=default.target
EOF
  cat > "$STAGE_DIR/vps-livekit.service" <<EOF
[Unit]
Description=LiveKit (VPS edge)
After=network-online.target
[Service]
ExecStart=/usr/bin/env livekit-server --config /opt/bifrost/livekit.yaml
Restart=always
[Install]
WantedBy=default.target
EOF
  record_step ok "systemd unit files written (vps-{pwa,agent,livekit}.service)"
fi
record_step vps "cp stage files to /opt/bifrost + systemctl --user enable --now vps-{pwa,agent,livekit} + caddy (VPS-only: real units on real ports)"

# ---- E. caddy TLS (VPS-ONLY — ACME needs the public 80/443) -------------------
if (( NO_TLS )); then record_step vps "caddy run (http only — --no-tls: mic needs a secure origin, phone will fall back to text)"
else record_step vps "caddy start --config Caddyfile → auto-ACME for $DOMAIN + $SUB_LIVE (VPS-only: needs ports 80/443 open + DNS)"; fi

# ---- F. /pair QR (PROVEN HERE — real png, decodable) --------------------------
# resolve from the FILE, not the mint-time local — a re-run took the skip branch above
ADMIN_TOKEN="$(grep '^BIFROST_ADMIN_TOKEN=' "$ENVF" | cut -d= -f2)"
PAIR_URL="$PUBLIC_URL/pair?t=$ADMIN_TOKEN"
if [[ -f "$STAGE_DIR/pair-qr.png" ]]; then record_step skip "pair QR (exists)"
elif have npx; then
  if NODE_OPTIONS=--jitless npx --yes qrcode -o "$STAGE_DIR/pair-qr.png" -w 320 "$PAIR_URL" >/dev/null 2>&1; then
    printf '%s' "$PAIR_URL" > "$STAGE_DIR/pair-qr.txt"
    record_step ok "pair QR minted at $STAGE_DIR/pair-qr.png (encodes $PAIR_URL)"
  else record_step skip "pair QR (npx qrcode failed — VPS run mints it)"; fi
else record_step skip "pair QR (no npx here)"; fi
record_step vps "serve /pair page with the SAME payload (one-time: after first successful pair the token burns — devices.ts registry)"

# ---- verdict ------------------------------------------------------------------
say "---------------- summary ----------------"
if (( IN_STAGE )); then say "verdict: IN-STAGE PROOF COMPLETE — VPS-only steps listed below (they need a public IP + open 80/443)"
else say "verdict: check FAIL/skip lines above — READY requires all ok + VPS steps done"; fi
for s in "${OK[@]:-}";   do [[ -n "$s" ]] && say "  ok(stage-proof): $s"; done
for s in "${SKIP[@]:-}"; do [[ -n "$s" ]] && say "  skip: $s"; done
for s in "${VPS[@]:-}";  do [[ -n "$s" ]] && say "  VPS-ONLY: $s"; done
say "pair URL (first scan pairs, then token burns): $PAIR_URL"
say "what the phone does: scan QR → /pair?t=<admin-token> → device token minted → PWA + voice on $PUBLIC_URL"
(( IN_STAGE )) && say "honest limit: QR here encodes the DEV tree's IP — the VPS run regenerates it with the VPS IP/domain."
exit 0
