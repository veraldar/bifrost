#!/usr/bin/env bash
# screen-off mic probe (native-app-eval Rung 0): fake mic + hands-free on the AVD,
# screen OFF 60s, assert mic track still live + LiveKit room never dropped.
# runs ON omarchy: scripts/android-lab/05-screen-off-probe.sh
# exit 0 = PASS, 1 = RED (track or room died), 2 = INCONCLUSIVE (lab could not set up)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PWA_PORT="${PWA_PORT:-8080}"  # live PWA; override to probe a privately served build
MAC_TUNNEL_PORT=18080   # PWA            -> omarchy 127.0.0.1:$PWA_PORT
MAC_LK_SIGNAL=18443     # LiveKit signal -> omarchy tailscale serve :443 (/livekit)
MAC_LK_TCP=17881        # LiveKit ICE/TCP -> omarchy 127.0.0.1:7881
OMARCHY_TS="${OMARCHY_TS:?set OMARCHY_TS (tailnet IP, docs/local.md)}"
OMARCHY_LAN="${OMARCHY_LAN:?set OMARCHY_LAN (LAN IP, docs/local.md)}"
REMOTE_LAB='$HOME/Library/android-lab'
inconclusive() { echo "PROBE RESULT: INCONCLUSIVE reason=$1"; exit 2; }

echo "== 1. boot/reuse AVD (02-boot-avd.sh)"
ssh mac 'bash -s' < "$REPO/scripts/android-lab/02-boot-avd.sh" || inconclusive avd-boot-failed

echo "== 2. tunnels omarchy -> mac loopback (PWA + LiveKit signal + LiveKit TCP media)"
fwd=()
# 03 binds :18080 -> :8080; a different PWA_PORT gets its own mac port so the two never alias
[ "$PWA_PORT" = 8080 ] || MAC_TUNNEL_PORT=$((10000 + PWA_PORT))
ssh mac "curl -sf -o /dev/null --max-time 5 http://127.0.0.1:${MAC_TUNNEL_PORT}/" 2>/dev/null \
  || fwd+=(-R "127.0.0.1:${MAC_TUNNEL_PORT}:127.0.0.1:${PWA_PORT}")
ssh mac "nc -z -G3 127.0.0.1 ${MAC_LK_SIGNAL}" 2>/dev/null \
  || fwd+=(-R "127.0.0.1:${MAC_LK_SIGNAL}:${OMARCHY_TS}:443")
ssh mac "nc -z -G3 127.0.0.1 ${MAC_LK_TCP}" 2>/dev/null \
  || fwd+=(-R "127.0.0.1:${MAC_LK_TCP}:127.0.0.1:7881")
if [ ${#fwd[@]} -gt 0 ]; then
  ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 "${fwd[@]}" mac || inconclusive tunnel-failed
  sleep 2
fi
ssh mac "curl -sf -o /dev/null --max-time 10 http://127.0.0.1:${MAC_TUNNEL_PORT}/" || inconclusive pwa-unreachable-on-mac
echo "tunnels up"

echo "== 3. node + playwright on mac (same bootstrap as 03)"
ssh mac 'export LAB=$HOME/Library/android-lab; bash -s' <<'REMOTE' || inconclusive node-bootstrap-failed
set -euo pipefail
LAB="${LAB:?}"; SDK="$HOME/Library/Android/sdk"
mkdir -p "$LAB"
if [ ! -x "$LAB/node/bin/node" ]; then
  TAR=$(curl -s https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v[0-9.]*-darwin-arm64.tar.xz' | head -1)
  curl -fL "https://nodejs.org/dist/latest-v22.x/$TAR" -o "$LAB/node.tar.xz"
  mkdir -p "$LAB/node" && tar -xJf "$LAB/node.tar.xz" -C "$LAB/node" --strip-components=1
  rm "$LAB/node.tar.xz"
fi
if [ ! -d "$LAB/flow/node_modules/playwright" ]; then
  mkdir -p "$LAB/flow" && cd "$LAB/flow"
  export PATH="$LAB/node/bin:$PATH"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright --no-fund --no-audit --loglevel=error
fi
[ -x "$SDK/platform-tools/adb" ] || { echo "FATAL: run 01-mac-setup.sh first"; exit 1; }
REMOTE

echo "== 4. emulator routing: adb reverse + DNAT LiveKit's ICE/TCP candidates onto the tunnel"
# LiveKit advertises ${OMARCHY_LAN}/${OMARCHY_TS}:7881; the Mac cannot open TCP to
# either (LAN firewall / tailnet ACL, see findings), so the AVD rewrites them to
# its own loopback where adb reverse carries them into the ssh tunnel. UDP fails, ICE falls back to TCP.
ssh mac "export PATH=\$HOME/Library/Android/sdk/platform-tools:\$PATH
  set -e
  adb root >/dev/null 2>&1 || true; adb wait-for-device
  adb reverse tcp:8080 tcp:${MAC_TUNNEL_PORT}
  adb reverse tcp:${MAC_LK_SIGNAL} tcp:${MAC_LK_SIGNAL}
  adb reverse tcp:${MAC_LK_TCP} tcp:${MAC_LK_TCP}
  adb shell 'echo 1 > /proc/sys/net/ipv4/conf/all/route_localnet'
  for ip in ${OMARCHY_LAN} ${OMARCHY_TS}; do
    rule=\"OUTPUT -p tcp -d \$ip --dport 7881 -j DNAT --to-destination 127.0.0.1:${MAC_LK_TCP}\"
    adb shell \"iptables -t nat -C \$rule 2>/dev/null || iptables -t nat -A \$rule\"
  done
  adb reverse --list" || inconclusive emulator-routing-failed

echo "== 5. run probe (screen off ${OFF_MS:-60000}ms)"
ssh mac "rm -rf ${REMOTE_LAB}/screen-off && mkdir -p ${REMOTE_LAB}/screen-off"
scp -q "$REPO/scripts/android-lab/05-screen-off-probe.mjs" "mac:Library/android-lab/flow/"
rc=0
ssh mac "export PATH=${REMOTE_LAB}/node/bin:\$HOME/Library/Android/sdk/platform-tools:\$PATH OFF_MS=${OFF_MS:-60000}
  cd ${REMOTE_LAB}/flow && node 05-screen-off-probe.mjs ${REMOTE_LAB}/screen-off" | tee /tmp/screen-off-probe.out || rc=${PIPESTATUS[0]}

echo "== 6. pull evidence + this run's diag lines"
OUT="$REPO/artifacts/android-lab/screen-off"
mkdir -p "$OUT"
scp -q "mac:Library/android-lab/screen-off/*" "$OUT/" 2>/dev/null || true
slug=$(grep -o '"name": "[^"]*"' "$OUT/report.json" 2>/dev/null | head -1 | cut -d'"' -f4 || true)
if [ -n "$slug" ]; then
  grep -h "$slug" "$REPO"/pwa/.diag/*.log 2>/dev/null | tail -60 > "$OUT/diag.log" || true
fi
ls -la "$OUT"
line=$(grep '^PROBE RESULT:' /tmp/screen-off-probe.out | tail -1)
[ -n "$line" ] || { line="PROBE RESULT: INCONCLUSIVE reason=probe-crashed-rc=$rc"; rc=2; }
echo "$line"
exit "$rc"
