#!/usr/bin/env bash
# bifrost-net AP verification — the REAL chain on this box, no VPS:
#   curl ─TLS─▶ ap (self-signed, :4443) ◀─wss, pinned─ bridge (dials OUT) ─▶ sandbox PWA :8090
# Refuses to lie: exits non-zero on any FAIL.
# Env: AP_UPSTREAM (127.0.0.1:8090)  AP_PORT (4443)  AP_LAN_IP (auto)
set -uo pipefail
cd "$(dirname "$0")"

PASS=0; TOTAL=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; }
t()    { TOTAL=$((TOTAL+1)); }

echo "== bifrost-net AP =="
cargo build --release -q || { echo "build failed"; exit 1; }
BIN=./target/release/bifrost-net
UPSTREAM=${AP_UPSTREAM:-127.0.0.1:8090}
APPORT=${AP_PORT:-4443}
LANIP=${AP_LAN_IP:-$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}
AP=https://127.0.0.1:$APPORT
TMP=$(mktemp -d)
AP_PID=; BR_PID=; WS_PID=
trap 'kill $AP_PID $BR_PID $WS_PID 2>/dev/null; rm -rf "$TMP"' EXIT

# 1. in-process selftest (stub upstream: smuggling, websocket byte-exact, pin/token refusals)
t; OUT=$("$BIN" selftest ap 2>&1)
if echo "$OUT" | grep -q "AP VERDICT: GREEN"; then ok "selftest ap: $(echo "$OUT" | grep -o 'AP.1 PASS.*' | cut -c13-150)…"
else fail "selftest ap: $(echo "$OUT" | tail -2)"; fi

# ---- material: self-signed cert (the VPS uses the site's LE files), pairing token, device registry
CERTOUT=$("$BIN" ap-cert "$TMP/tls" localhost 127.0.0.1 ${LANIP:+"$LANIP"})
PIN=$(echo "$CERTOUT" | sed -n 's/^pin = "\(.*\)"/\1/p')
TOKOUT=$("$BIN" ap-token)
BTOK=$(echo "$TOKOUT" | sed -n 's/^token = "\([0-9a-f]*\)".*/\1/p')
BHASH=$(echo "$TOKOUT" | sed -n 's/^bridge_token_sha256 = "\([0-9a-f]*\)".*/\1/p')
cat > "$TMP/ap.toml" <<EOF
[ap]
listen = "0.0.0.0:$APPORT"
cert_path = "$TMP/tls/cert.pem"
key_path = "$TMP/tls/key.pem"
bridge_token_sha256 = "$BHASH"
EOF
sha() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
DEV=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')      # issued on loopback
DEVLAN=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')   # issued on the LAN
EXP=$(( $(date +%s%3N) + 3600000 ))
LANREG="lan:$(echo "$LANIP" | cut -d. -f1-3).0/24"
cat > "$TMP/devices.json" <<EOF
{"version":2,"killEpoch":0,"devices":[
 {"id":"phone-loop","revoked":false,"access":[{"hash":"$(sha "$DEV")","exp":$EXP,"region":"loopback"}]},
 {"id":"phone-lan","revoked":false,"access":[{"hash":"$(sha "$DEVLAN")","exp":$EXP,"region":"$LANREG"}]}]}
EOF
PRIV=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
P=$((30000 + RANDOM % 20000))
WSP=$((P + 2))
cat > "$TMP/bridge.toml" <<EOF
[node]
name = "ap-verify"
private_key = "$PRIV"

[bridge]
http = "127.0.0.1:$P"
media = "127.0.0.1:$((P + 1))"
tokens_file = "$TMP/devices.json"

[ap]
url = "wss://127.0.0.1:$APPORT/ap"
pin = "$PIN"
token = "$BTOK"
upstream = "$UPSTREAM"
livekit = "127.0.0.1:$WSP"
EOF
# /rtc stand-in for the LiveKit signaling websocket: answers 101, then echoes
python3 - "$WSP" > /dev/null 2>&1 <<'PY' &
import socket, sys, threading
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen()
def h(c):
    b = b""
    while b"\r\n\r\n" not in b:
        d = c.recv(4096)
        if not d: return
        b += d
    rest = b.split(b"\r\n\r\n", 1)[1]
    c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n" + rest)
    while True:
        d = c.recv(65536)
        if not d: break
        c.sendall(d)
while True:
    c, _ = s.accept(); threading.Thread(target=h, args=(c,), daemon=True).start()
PY
WS_PID=$!

"$BIN" ap -c "$TMP/ap.toml" > "$TMP/ap.log" 2>&1 &
AP_PID=$!
for _ in $(seq 30); do grep -q "LIVE" "$TMP/ap.log" 2>/dev/null && break; sleep 0.1; done

# 2. bridge offline → the ap says so (503), HSTS already on
t; R=$(curl -sk -D - -o /dev/null "$AP/")
if echo "$R" | grep -q "^HTTP/1.1 503" && echo "$R" | grep -qi "^strict-transport-security: max-age"; then
  ok "edge up, bridge offline → 503 + HSTS"
else fail "bridge-offline answer: $(echo "$R" | head -1)"; fi

"$BIN" bridge -c "$TMP/bridge.toml" > "$TMP/bridge.log" 2>&1 &
BR_PID=$!
for _ in $(seq 100); do grep -q "channel up" "$TMP/bridge.log" 2>/dev/null && break; sleep 0.1; done

# 3. the bridge dialed OUT, pinned the ap, presented the pairing token
t; if grep -q "channel up" "$TMP/bridge.log" && grep -q "bridge registered from" "$TMP/ap.log"; then
  ok "bridge dialed out + registered ($(grep -o 'link #[0-9]*' "$TMP/ap.log" | head -1), pin ${PIN:0:20}…)"
else fail "bridge registration: $(tail -2 "$TMP/bridge.log")"; fi

# 4. the PWA answers through the chain (curl -k https://127.0.0.1:4443/)
t; CODE=$(curl -sk -D "$TMP/h" -o "$TMP/body" -w '%{http_code}' "$AP/")
if [ "$CODE" = 200 ] && grep -qi "<html" "$TMP/body" && grep -qi "^strict-transport-security: max-age=31536000" "$TMP/h"; then
  ok "GET / → 200 PWA html ($(wc -c < "$TMP/body") bytes) + HSTS, served from $UPSTREAM"
else fail "GET / → $CODE"; fi

# 5. the pin is the standard SPKI sha-256 (curl/OpenSSL agree); a wrong pin is refused
t; B64=$(echo "${PIN#sha-256 }" | tr -d ':' | xxd -r -p | base64)
C1=$(curl -sk --pinnedpubkey "sha256//$B64" -o /dev/null -w '%{http_code}' "$AP/")
curl -sk --pinnedpubkey "sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" -o /dev/null "$AP/"; C2=$?
if [ "$C1" = 200 ] && [ "$C2" = 90 ]; then ok "pin = SPKI sha-256: curl --pinnedpubkey accepts it, rejects a wrong one (exit 90)"
else fail "pin cross-check: right=$C1 wrong-exit=$C2"; fi

# 6. TLS floor: 1.2 + 1.3 accepted, 1.1 refused
t; V12=$(curl -sk --tlsv1.2 --tls-max 1.2 -o /dev/null -w '%{http_code}' "$AP/")
V13=$(curl -sk --tlsv1.3 -o /dev/null -w '%{http_code}' "$AP/")
V11=$(curl -sk --tlsv1.1 --tls-max 1.1 -o /dev/null -w '%{http_code}' "$AP/" 2>/dev/null); V11=${V11:-000}
if [ "$V12" = 200 ] && [ "$V13" = 200 ] && [ "$V11" = 000 ]; then ok "TLS1.2 200, TLS1.3 200, TLS1.1 refused"
else fail "tls versions: 1.2=$V12 1.3=$V13 1.1=$V11"; fi

# 7. a device-token'd request passes (Bearer and cookie) — verified on the bridge
t; C1=$(curl -sk -H "Authorization: Bearer $DEV" -o "$TMP/sess" -w '%{http_code}' "$AP/api/session")
C2=$(curl -sk -b "bifrost_device=$DEV" -o /dev/null -w '%{http_code}' "$AP/api/session")
if [ "$C1" = 200 ] && [ "$C2" = 200 ] && grep -q '"id"' "$TMP/sess"; then ok "device token passes: /api/session 200 (Bearer + cookie)"
else fail "device token: bearer=$C1 cookie=$C2"; fi

# 8. uncredentialed → 401 (loopback and LAN-style), bad token → 401 invalid
t; R1=$(curl -sk -w ' %{http_code}' "$AP/api/session")
R2=$(curl -sk -w ' %{http_code}' -H "Authorization: Bearer not-a-real-token-123456" "$AP/api/session")
R3=$( [ -n "$LANIP" ] && curl -sk --interface "$LANIP" -w ' %{http_code}' "https://$LANIP:$APPORT/api/session")
if [[ "$R1" == *'"why":"missing"'*' 401' && "$R2" == *'"why":"invalid"'*' 401' && "$R3" == *'"why":"missing"'*' 401' ]]; then
  ok "uncredentialed 401 (loopback + LAN $LANIP), bad token 401 invalid"
else fail "401s: $R1 | $R2 | $R3"; fi

# 9. region = the REAL client address the ap saw: a LAN token passes from the LAN; the loopback
#    token replayed from the LAN is refused even with a spoofed X-Forwarded-For
t; C1=$(curl -sk --interface "$LANIP" -H "Authorization: Bearer $DEVLAN" -o /dev/null -w '%{http_code}' "https://$LANIP:$APPORT/api/session")
R2=$(curl -sk --interface "$LANIP" -H "Authorization: Bearer $DEV" -H "X-Forwarded-For: 127.0.0.1" -H "X-Bifrost-Peer: 127.0.0.1" -w ' %{http_code}' "https://$LANIP:$APPORT/api/session")
if [ "$C1" = 200 ] && [[ "$R2" == *'"why":"region"'*' 401' ]]; then ok "region from the socket: LAN token 200 from $LANREG, loopback token + spoofed XFF from LAN → 401 region"
else fail "region binding: lan=$C1 replay=$R2"; fi

# 10. SSE (/api/run-events) streams through the chain while the run stays open
t; SID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["id"])' "$TMP/sess" 2>/dev/null)
curl -sk -N --max-time 3 -D "$TMP/sse.h" -H "Authorization: Bearer $DEV" "$AP/api/run-events?slug=$SID" -o "$TMP/sse.b"; RC=$?
if [ "$RC" = 28 ] && grep -qi "^content-type: text/event-stream" "$TMP/sse.h" && grep -q "retry:" "$TMP/sse.b"; then
  ok "SSE /api/run-events: 200 event-stream, first event through the chain, stream held open (cut by client at 3s)"
else fail "SSE: rc=$RC $(head -1 "$TMP/sse.h")"; fi

# 11. websocket upgrade through the chain (/rtc → livekit route): 101 then 20000 bytes echoed exact
t; WS=$(python3 - "$APPORT" <<'PY'
import os, socket, ssl, sys
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
c = ctx.wrap_socket(socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5), server_hostname="localhost")
c.sendall(b"GET /rtc?access_token=x HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
          b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
b = b""
while b"\r\n\r\n" not in b:
    b += c.recv(4096)
head, got = b.split(b"\r\n\r\n", 1)
if not head.startswith(b"HTTP/1.1 101"):
    print("no-101", head.split(b"\r\n")[0]); sys.exit()
probe = os.urandom(20000); c.sendall(probe)
while len(got) < len(probe):
    d = c.recv(65536)
    if not d: break
    got += d
print("WS101-EXACT" if got == probe else "WS-MISMATCH %d" % len(got))
PY
)
if [ "$WS" = "WS101-EXACT" ]; then ok "websocket: /rtc upgraded through ap→channel→bridge→signaling, 20000 random bytes echoed exact"
else fail "websocket: $WS"; fi

# 12. the box never listens for the ap: the bridge's ap leg is an OUTBOUND connection
t; if ss -tnp 2>/dev/null | grep "pid=$BR_PID," | grep -q ":$APPORT "; then ok "bridge→ap is an outbound socket (pid $BR_PID → :$APPORT); no inbound port opened for it"
else fail "bridge outbound socket not found"; fi

# 13. bridge restart → the ap drops the link, the bridge re-dials, service resumes
t; kill "$BR_PID"; sleep 0.5
C1=$(curl -sk -o /dev/null -w '%{http_code}' "$AP/")
"$BIN" bridge -c "$TMP/bridge.toml" > "$TMP/bridge2.log" 2>&1 &
BR_PID=$!
for _ in $(seq 100); do grep -q "channel up" "$TMP/bridge2.log" 2>/dev/null && break; sleep 0.1; done
C2=$(curl -sk -o /dev/null -w '%{http_code}' "$AP/")
if [ "$C1" = 503 ] && [ "$C2" = 200 ]; then ok "bridge gone → 503; bridge back → re-registered → 200"
else fail "relink: down=$C1 up=$C2"; fi

echo "AP VERIFY: $PASS/$TOTAL PASS"
[ "$PASS" -eq "$TOTAL" ] && echo "AP VERDICT: GREEN" || exit 1
