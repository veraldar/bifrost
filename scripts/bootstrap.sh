#!/usr/bin/env bash
# bifrost bootstrap — one command, zero judgment calls (spec: docs/spec-onboard.md).
# Local/single-machine mode: prepares configs, mints secrets, starts the stack.
# Idempotent: re-running never overwrites existing secrets/configs.
# Container-safe: skips what a container cannot do (tailscale, systemd) and says so.
# Usage: scripts/bootstrap.sh [--dry-run]
set -uo pipefail
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

# ---- -1. self-bootstrap: clone the repo if we are not inside it --------------
if [[ ! -d deploy || ! -f pwa/package.json ]]; then
  DEST="${BIFROST_DIR:-$PWD/bifrost}"
  echo "[bootstrap] not inside the repo — cloning into $DEST"
  git clone --depth 1 --branch v0.6.0 https://github.com/veraldar/yggdrasil-bifrost.git "$DEST"  # pinned release tag (S2) || exit 1
  cd "$DEST" || exit 1
fi
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOG="$ROOT/bootstrap.log"
OK=(); SKIP=(); FAIL=()
say() { echo "[bootstrap] $*"; }
run() { # run <desc> <cmd...> — records outcome, never aborts the whole bootstrap
  local desc="$1"; shift
  if (( DRY )); then SKIP+=("$desc (dry-run)"); say "DRY $desc: $*"; return 0; fi
  say "$desc ..."
  if "$@" >>"$LOG" 2>&1; then OK+=("$desc"); else FAIL+=("$desc (see bootstrap.log)"); return 1; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

cd "$ROOT"
say "bifrost bootstrap — root: $ROOT $( ((DRY)) && echo '(DRY RUN)' )"

# ---- 0. prerequisites -------------------------------------------------------
MISS=()
for b in git node npm curl openssl ip; do have "$b" || MISS+=("$b"); done
if ((${#MISS[@]})); then
  say "MISSING: ${MISS[*]} — install them (e.g. apt/dnf/brew) and re-run."; exit 1
fi
have docker || SKIP+=("docker (LiveKit/speaches cannot start without it)")
have uv     || SKIP+=("uv (voice agent cannot start without it: curl -LsSf https://astral.sh/uv/install.sh | sh)")

# ---- 1. detect reachable IP (tailscale preferred, then LAN, then loopback) ---
IP="127.0.0.1"
if have tailscale && tailscale ip -4 >/dev/null 2>&1; then
  IP="$(tailscale ip -4 | head -1)"
elif ip -4 route get 1.1.1.1 >/dev/null 2>&1; then
  IP="$(ip -4 route get 1.1.1.1 | grep -o 'src [0-9.]*' | awk '{print $2}' | head -1)"
fi
say "reachable IP for ICE: $IP"

# ---- 2. mint secrets + write configs (never overwrite) ----------------------
mint() { openssl rand -hex 24; }
if [[ -f deploy/.env ]]; then
  SKIP+=("deploy/.env (exists)")
else
  SECRET="$(mint)"
  cat > deploy/.env <<EOF
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=$SECRET
OPENCODE_URL=http://127.0.0.1:4096
EOF
  OK+=("deploy/.env (minted)")
fi
SECRET="$(grep LIVEKIT_API_SECRET deploy/.env | cut -d= -f2)"

if [[ -f deploy/livekit.yaml ]]; then
  SKIP+=("deploy/livekit.yaml (exists)")
else
  cat > deploy/livekit.yaml <<EOF
port: 7880
bind_addresses:
  - 0.0.0.0
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: false
  ips:
    includes:
      - $IP/32
logging:
  level: info
EOF
  OK+=("deploy/livekit.yaml (ICE pinned to $IP)")
fi

if [[ -f agent/.env ]]; then
  SKIP+=("agent/.env (exists)")
else
  sed "s/LIVEKIT_API_SECRET=.*/LIVEKIT_API_SECRET=$SECRET/" agent/.env.example > agent/.env
  OK+=("agent/.env (from example, secret injected)")
fi

if [[ -f pwa/.env.local ]]; then
  SKIP+=("pwa/.env.local (exists)")
else
  VAPID_PUB=""; VAPID_PRIV=""
  if have npx; then
    KEYS="$(npx --yes web-push generate-vapid-keys --json 2>/dev/null || true)"
    VAPID_PUB="$(echo "$KEYS" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)"
    VAPID_PRIV="$(echo "$KEYS" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)"
  fi
  {
    echo "LIVEKIT_URL=ws://127.0.0.1:7880"
    echo "LIVEKIT_API_KEY=devkey"
    echo "LIVEKIT_API_SECRET=$SECRET"
    echo "OPENCODE_URL=http://127.0.0.1:4096"
    echo "VAPID_PUBLIC_KEY=$VAPID_PUB"
    echo "VAPID_PRIVATE_KEY=$VAPID_PRIV"
  } > pwa/.env.local
  if [[ -n "$VAPID_PUB" ]]; then OK+=("pwa/.env.local (VAPID minted)");
  else OK+=("pwa/.env.local (VAPID skipped — no npx)"); fi
fi

# ---- 2b. bundled skills → every opencode session on this box -----------------
if have opencode || [[ -d "$HOME/.config/opencode" ]]; then
  mkdir -p "$HOME/.config/opencode/skills"
  for d in "$ROOT"/skills/*/; do
    name="$(basename "$d")"
    mkdir -p "$HOME/.config/opencode/skills/$name"
    cp -f "$d/SKILL.md" "$HOME/.config/opencode/skills/$name/SKILL.md" 2>/dev/null \
      && OK+=("skill: $name (installed global)") || SKIP+=("skill: $name (copy failed)")
  done
else
  SKIP+=("bundled skills (no opencode config dir yet)")
fi

# ---- 3. opencode (install if asked to, start if not running) ----------------
start_opencode() { # CLI shape differs across versions: try flags, then env
  nohup opencode serve --port 4096 --hostname 127.0.0.1 >/dev/null 2>&1 &
  for i in 1 2 3 4 5; do sleep 2; curl -sf -m 3 http://127.0.0.1:4096/ >/dev/null 2>&1 && return 0; done
  nohup env PORT=4096 opencode serve >/dev/null 2>&1 &
  for i in 1 2 3 4 5; do sleep 2; curl -sf -m 3 http://127.0.0.1:4096/ >/dev/null 2>&1 && return 0; done
  return 1
}
if curl -sf -m 3 http://127.0.0.1:4096/ >/dev/null 2>&1; then
  SKIP+=("opencode serve (already answering on :4096)")
elif have opencode; then
  if (( DRY )); then SKIP+=("opencode serve (dry-run)");
  elif start_opencode; then OK+=("opencode serve :4096"); else FAIL+=("opencode serve (see bootstrap.log)"); fi
elif [[ "${BOOTSTRAP_INSTALL_OPENCODE:-0}" = "1" ]]; then
  run "install opencode" bash -c "curl -fsSL https://opencode.ai/install | bash >>$LOG 2>&1"
  export PATH="$HOME/.opencode/bin:$PATH" # installer writes a new PATH — same shell needs it now
  if (( DRY )); then SKIP+=("opencode serve (dry-run)");
  elif start_opencode; then OK+=("opencode serve :4096"); else FAIL+=("opencode serve (see bootstrap.log)"); fi
  BOOTSTRAP_REMINDER_OPLOGIN=1
else
  SKIP+=("opencode (not installed; export BOOTSTRAP_INSTALL_OPENCODE=1 to auto-install, then 'opencode auth login')")
fi

# ---- 4. LiveKit + speaches (docker) -----------------------------------------
if have docker && docker compose version >/dev/null 2>&1; then
  run "docker compose up -d (LiveKit + speaches)" bash -c "cd deploy && docker compose up -d"
  sleep 4
else
  SKIP+=("LiveKit/speaches (docker missing)")
fi

# ---- 5. voice agent ----------------------------------------------------------
if have uv && curl -sf -m 3 http://127.0.0.1:7880/ >/dev/null 2>&1; then
  (cd agent && uv sync >>"$LOG" 2>&1) && OK+=("agent deps (uv sync)") || FAIL+=("agent deps")
  run "voice agent (worker mode)" bash -c "cd agent && nohup uv run agent.py dev >/dev/null 2>&1 & sleep 5"
else
  SKIP+=("voice agent (needs uv + LiveKit up)")
fi

# ---- 6. PWA ------------------------------------------------------------------
if [[ ! -d pwa/node_modules ]]; then run "pwa deps (npm ci)" bash -c "cd pwa && npm ci --no-audit --no-fund"; fi
run "pwa build (next build)" bash -c "cd pwa && npm run build"
run "pwa serve :8080" bash -c "cd pwa && nohup npx next start -p 8080 >/dev/null 2>&1 & sleep 5"

# ---- 7. HTTPS (tailscale, best effort) ---------------------------------------
if have tailscale && tailscale serve status >/dev/null 2>&1; then
  run "tailscale serve :8080" bash -c "tailscale serve --bg 8080"
  say "HTTPS (tailnet): https://$(tailscale dns status 2>/dev/null | grep -o '[a-z0-9-]*\.ts\.net' | head -1)"
else
  SKIP+=("HTTPS/tailscale (not available here — LAN http://$IP:8080 works)")
fi

# ---- 8. verify ---------------------------------------------------------------
sleep 2
VERDICT="PARTIAL"
probe() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }
PWA="$(probe http://127.0.0.1:8080/)"; OC="$(probe http://127.0.0.1:4096/)"; LK="$(probe http://127.0.0.1:7880/)"
# CSS probe: a page that returns 200 with a dead stylesheet renders unstyled
# (seen in the wild: node < 22 breaks tailwind4's native oxide silently)
CSS_HREF="$(curl -s -m 5 http://127.0.0.1:8080/ 2>/dev/null | grep -o 'href="[^"]*\.css[^"]*"' | head -1 | sed 's/href="//;s/"$//')"
CSS="${CSS_HREF:+$(probe "http://127.0.0.1:8080$CSS_HREF")}"
[[ "$PWA" == 200 && "$OC" != 000 && "$LK" != 000 ]] && VERDICT="READY"
[[ "$PWA" == 200 && "$LK" == 000 && "$OC" != 000 ]] && VERDICT="READY (no docker — media layers skipped)"
[[ "$PWA" == 200 && "$CSS" != 200 ]] && VERDICT="BROKEN styling (css probe: ${CSS:-no <link> in html}) — check 'node --version' (need ≥22) and re-run npm run build"
(( ${#FAIL[@]} )) && VERDICT="PARTIAL (with failures)"

say "---------------- summary ----------------"
say "verdict: $VERDICT"
say "probes: pwa=$PWA opencode=$OC livekit=$LK css=${CSS:-n/a}"
for s in "${OK[@]}";  do say "  ok:   $s"; done
for s in "${SKIP[@]}"; do say "  skip: $s"; done
for s in "${FAIL[@]}"; do say "  FAIL: $s"; done
say "open the PWA: http://$IP:8080  (phone: same tailnet, or install as app)"
say "log: $LOG"
[[ "$VERDICT" == READY* ]] && exit 0 || exit 2
