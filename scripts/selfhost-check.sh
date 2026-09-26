#!/usr/bin/env bash
# Self-host smoke: proves the PWA part of the quickstart works from zero on
# any clean box (or in a container/VM): clone → npm ci → build → boot → probe.
# LiveKit/agent/opencode are covered by README steps + deploy/docker-compose.yml;
# this script is the one-command "is my box able to run bifrost's PWA" check.
# Usage: scripts/selfhost-check.sh [repo-url] [port]
set -euo pipefail
REPO_URL="${1:-https://github.com/veraldar/yggdrasil-bifrost.git}"
PORT="${2:-3210}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[selfhost] cloning $REPO_URL → $WORK"
git clone --depth 1 "$REPO_URL" "$WORK/repo" >/dev/null 2>&1

echo "[selfhost] node $(node --version), npm $(npm --version)"
echo "[selfhost] npm ci (clean deps)"
cd "$WORK/repo/pwa"
npm ci --no-audit --no-fund >/dev/null

echo "[selfhost] next build"
npm run build >/dev/null
echo "[selfhost] build OK"

echo "[selfhost] booting on :$PORT (no env = proxy will 500 on /api/*, expected)"
LIVEKIT_URL=wss://example.invalid LIVEKIT_API_KEY=dummy LIVEKIT_API_SECRET=dummy \
  npx next start -p "$PORT" >/dev/null 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for i in $(seq 1 30); do
  sleep 1
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  [ "$i" = 30 ] && { echo "[selfhost] FAIL: server did not answer"; exit 1; }
done

TITLE="$(curl -s "http://127.0.0.1:$PORT/" | grep -o '<title>[^<]*</title>' || true)"
MANIFEST="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/manifest.json")"
API="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/session")"
echo "[selfhost] page: $TITLE, manifest: $MANIFEST, api (no backend): $API"

[ "$MANIFEST" = "200" ] || { echo "[selfhost] FAIL: manifest"; exit 1; }
[ "$API" = "500" ] || { echo "[selfhost] FAIL: api should 500 without opencode"; exit 1; }
case "$TITLE" in *Bifrost*) ;; *) echo "[selfhost] FAIL: title"; exit 1 ;; esac
echo "[selfhost] PASS — PWA builds and boots from a fresh clone."
echo "[selfhost] next steps (README): LiveKit (deploy/), agent (agent/), opencode-serve,"
echo "[selfhost] then set real env vars and re-run this PWA with them."
