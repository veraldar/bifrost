#!/usr/bin/env bash
# end-to-end software lab: live PWA on this box -> ssh tunnel -> Mac emulator Chrome.
# runs ON omarchy: scripts/android-lab/03-run-consumer-flow.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MAC_TUNNEL_PORT=18080
REMOTE_LAB='$HOME/Library/android-lab'

echo "== 1. tunnel omarchy:8080 -> mac loopback :$MAC_TUNNEL_PORT (consumer path stand-in)"
if ssh mac "curl -sf -o /dev/null --max-time 5 http://127.0.0.1:${MAC_TUNNEL_PORT}/" 2>/dev/null; then
  echo "tunnel already up"
else
  ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    -R "127.0.0.1:${MAC_TUNNEL_PORT}:127.0.0.1:8080" mac
  sleep 2
  ssh mac "curl -sf -o /dev/null --max-time 10 http://127.0.0.1:${MAC_TUNNEL_PORT}/" \
    || { echo "FATAL: tunnel up but PWA unreachable on mac loopback"; exit 1; }
  echo "tunnel established"
fi

echo "== 2. node + playwright on mac (no sudo, tarball install)"
ssh mac 'export LAB=$HOME/Library/android-lab; bash -s' <<'REMOTE'
set -euo pipefail
LAB="${LAB:?}"; SDK="$HOME/Library/Android/sdk"
mkdir -p "$LAB"
if [ ! -x "$LAB/node/bin/node" ]; then
  TAR=$(curl -s https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v[0-9.]*-darwin-arm64.tar.xz' | head -1)
  curl -fL "https://nodejs.org/dist/latest-v22.x/$TAR" -o "$LAB/node.tar.xz"
  mkdir -p "$LAB/node" && tar -xJf "$LAB/node.tar.xz" -C "$LAB/node" --strip-components=1
  rm "$LAB/node.tar.xz"
fi
"$LAB/node/bin/node" -v
if [ ! -d "$LAB/flow/node_modules/playwright" ]; then
  mkdir -p "$LAB/flow"
  cd "$LAB/flow"
  export PATH="$LAB/node/bin:$PATH"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright --no-fund --no-audit --loglevel=error
fi
[ -x "$SDK/platform-tools/adb" ] || { echo "FATAL: run 01-mac-setup.sh first"; exit 1; }
REMOTE

echo "== 3. push flow script + run against emulator chrome"
ssh mac "mkdir -p ${REMOTE_LAB}/shots"
scp -q "$REPO/scripts/android-lab/04-consumer-flow.mjs" "mac:Library/android-lab/flow/"
ssh mac "export PATH=${REMOTE_LAB}/node/bin:\$HOME/Library/Android/sdk/platform-tools:\$PATH
  cd ${REMOTE_LAB}/flow
  adb reverse --remove tcp:8080 2>/dev/null || true
  adb reverse tcp:8080 tcp:${MAC_TUNNEL_PORT}
  node 04-consumer-flow.mjs ${REMOTE_LAB}/shots"
FLOW_RC=$?

echo "== 4. pull evidence"
mkdir -p "$REPO/artifacts/android-lab"
scp -q "mac:Library/android-lab/shots/*" "$REPO/artifacts/android-lab/" 2>/dev/null || true
ls -la "$REPO/artifacts/android-lab/"
echo "== flow rc=$FLOW_RC"
exit $FLOW_RC
