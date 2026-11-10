#!/usr/bin/env bash
# INSTALL SIM — run lab/yggdrasil/install/install.sh (full stack) in the clean Arch
# container `ygg-sim` (host network, no systemd) and print PASS-SIM with the receipts.
#
#   scripts/install-sim.sh            copy install/ in, place the prebuilt binaries, install, verify
#   scripts/install-sim.sh --fresh    first wipe what a previous sim installed (and libopus), then the same
#   scripts/install-sim.sh --receipts only re-run the receipts against the sim that is up
#
# The container shares the host network, so the sim runs on ports the live services
# don't use (brain 4110, app 8092, bridge 7990 + udp 7991, livekit 7980-7982, voice 8010).
# Pass 1 runs install.sh as a real box would (systemd step → "no systemd user session",
# units written, nothing started). Pass 2 re-runs it with --direct: the same units'
# commands under nohup — and proves the re-run is idempotent. The brain's upstream comes
# from the host's ~/.config/yggdrasil/yggdrasil.env (passed by NAME via docker exec -e).
# Never touches live services.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
C=${SIM_CONTAINER:-ygg-sim}
TREE=${SIM_TREE:-/opt/bifrost}
INST=$TREE/lab/yggdrasil/install
LAN=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
HOST_ENV=${SIM_BRAIN_ENV:-$HOME/.config/yggdrasil/yggdrasil.env}

docker exec "$C" true || { echo "container $C is not running"; exit 2; }
if [ "${1:-}" = --fresh ]; then
  echo "== --fresh: stop the previous sim's processes, remove everything install.sh wrote, uninstall opus"
  docker exec "$C" bash -c 'for f in /root/.local/state/bifrost/run/*.pid; do [ -f "$f" ] && kill -- "-$(cat "$f")" 2>/dev/null; done; sleep 1
    rm -rf /root/.config/bifrost /root/.config/yggdrasil /root/.local/share/bifrost /root/.local/share/yggdrasil /root/.local/state/bifrost \
      /root/.local/bin/yggdrasil /root/.local/bin/bifrost-net /root/.local/bin/livekit-server /root/.config/systemd/user/yggdrasil.service \
      /root/.config/systemd/user/bifrost-*.service; pacman -R --noconfirm opus >/dev/null 2>&1; true'
fi
for k in YGG_UPSTREAM_BASE_URL YGG_UPSTREAM_API_KEY YGG_UPSTREAM_MODEL YGG_UPSTREAM_STYLE; do
  v=$(sed -n "s/^$k=//p" "$HOST_ENV" 2>/dev/null | tail -1); [ -n "$v" ] && export "$k=$v"
done
export YGG_LISTEN=127.0.0.1:4110 BIFROST_APP_PORT=8092 BIFROST_BRIDGE_PORT=7990 BIFROST_MEDIA_PORT=7991 \
  BIFROST_VOICE_PORT=8010 LIVEKIT_PORT=7980 LIVEKIT_TCP_PORT=7981 LIVEKIT_UDP_PORT=7982 AGENT_HTTP_PORT=8093
PASS=(-e YGG_UPSTREAM_BASE_URL -e YGG_UPSTREAM_API_KEY -e YGG_UPSTREAM_MODEL -e YGG_UPSTREAM_STYLE -e YGG_LISTEN
  -e BIFROST_APP_PORT -e BIFROST_BRIDGE_PORT -e BIFROST_MEDIA_PORT -e BIFROST_VOICE_PORT
  -e LIVEKIT_PORT -e LIVEKIT_TCP_PORT -e LIVEKIT_UDP_PORT -e AGENT_HTTP_PORT)

if [ "${1:-}" != --receipts ]; then
echo "== copy install/ → $C:$INST, place the prebuilt binaries"
docker cp "$ROOT/lab/yggdrasil/install/." "$C:$INST/"
docker exec "$C" sh -c "[ -x $INST/yggdrasil ] || exit 3"
docker cp "$ROOT/lab/bifrost-net/target/release/bifrost-net" "$C:$INST/bifrost-net"

echo "== pass 1: install.sh (full stack + forced app rebuild, as on a real box; agent skipped: the tagged agent has no AGENT_HTTP_PORT and :8081 is the live agent's)"
pass1() { docker exec -e BIFROST_REBUILD=1 "${PASS[@]}" "$C" bash "$INST/install.sh" --skip agent >/tmp/install-sim-pass1.log 2>&1; }
if ! pass1; then
  tail -5 /tmp/install-sim-pass1.log
  grep -q 'pacman -S opus' /tmp/install-sim-pass1.log || exit 1
  echo "== the fix the installer printed, as a stranger would run it: pacman -S opus — then pass 1 again"
  docker exec "$C" pacman -S --noconfirm --needed opus >/dev/null
  pass1 || { tail -30 /tmp/install-sim-pass1.log; exit 1; }
fi
tail -40 /tmp/install-sim-pass1.log
echo "== pass 2: install.sh --direct (no systemd here: the units' own commands under nohup)"
docker exec "${PASS[@]}" "$C" bash "$INST/install.sh" --direct --skip agent 2>&1 | tee /tmp/install-sim-pass2.log | tail -40

fi  # --receipts: only re-check a sim that is already up
echo "== receipts (curl from inside $C)"
ex() { docker exec "$C" sh -c "$1"; }
R1=$(ex "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4110/session")
R2a=$(ex "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8092/")
R2b=$(ex "curl -s -o /tmp/pair.html -w '%{http_code} ' http://127.0.0.1:8092/pair; grep -c '/_next/static' /tmp/pair.html")
QR=$(ex "curl -s -X POST http://127.0.0.1:8092/api/pair/code")
R3=$(ex "curl -s -o /tmp/id.json -w '%{http_code}' http://127.0.0.1:7990/identity; echo; cat /tmp/id.json")
SID=$(ex "curl -s -X POST -H 'content-type: application/json' -d '{\"name\":\"install-sim\"}' http://127.0.0.1:8092/api/session" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
for try in 1 2 3; do  # the upstream provider can answer 529 "overloaded" — transient, not an install fault
  R4=$(ex "curl -s -m 120 -X POST -H 'content-type: application/json' -d '{\"text\":\"Reply with exactly the word PONG and nothing else.\"}' http://127.0.0.1:8092/api/session/$SID/messages")
  printf %s "$R4" | grep -q '"text":"[^"]' && break
  echo "  (round-trip try $try: $R4 — brain log: $(ex 'tail -1 /root/.local/state/bifrost/log/yggdrasil.service.log' | cut -c1-140))"; sleep 5
done
R5=$(ex "curl -s -o /dev/null -w '%{http_code}' http://$LAN:8092/api/session")
R6=$(ex "curl -s -m 3 http://127.0.0.1:7980/" || true)

FP=$(printf '%s' "$R3" | sed -n 's/.*"fingerprint":"\([^"]*\)".*/\1/p')
ok=1
chk() { if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; ok=0; fi; }
chk "brain   GET 127.0.0.1:4110/session → $R1" '[ "$R1" = 200 ]'
chk "app     GET 127.0.0.1:8092/ → $R2a · /pair → ${R2b%%[[:space:]]*} (next bundle refs: ${R2b##*[[:space:]]})" '[ "$R2a" = 200 ] && [ "${R2b%%[[:space:]]*}" = 200 ]'
chk "app     /pair console mint (loopback = box console): QR svg + bridge fp pinned" 'printf %s "$QR" | grep -q "<svg" && [ -n "$FP" ] && printf %s "$QR" | grep -qF "$FP"'
chk "bridge  GET 127.0.0.1:7990/identity → $(printf '%s' "$R3" | head -1) fp=${FP:0:23}…" '[ "$(printf "%s" "$R3" | head -1)" = 200 ] && [ -n "$FP" ]'
chk "seam    POST /api/session/$SID/messages → $R4" 'printf %s "$R4" | grep -q "\"text\":\"[^\"]\{1,\}"'
chk "devices a LAN peer without a device token: GET $LAN:8092/api/session → $R5" '[ "$R5" = 401 ]'
chk "livekit GET 127.0.0.1:7980/ → ${R6:-nothing}" '[ "$R6" = OK ]'
if ex "test -f /root/.config/systemd/user/bifrost-voice.service"; then  # voice installs only where python exists
  for _ in $(seq 120); do VH=$(ex "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8010/healthz" || true); [ "$VH" = 200 ] && break; sleep 2; done
  chk "voice   GET 127.0.0.1:8010/healthz → $VH (models fetched on its first start)" '[ "$VH" = 200 ]'
  TT=$("$ROOT/scripts/tts-json-test.sh" http://127.0.0.1:8092/api/tts/stream 2>&1 || true); TT=${TT%%$'\n'*}
  chk "tts     app seam /api/tts/stream → local voice: $TT" 'printf %s "$TT" | grep -q "audio=True"'
else echo "  ----  voice not installed in $C (no python there) — the installer printed the fix"; fi
[ $ok = 1 ] && echo "PASS-SIM" || { echo "FAIL-SIM"; exit 1; }
