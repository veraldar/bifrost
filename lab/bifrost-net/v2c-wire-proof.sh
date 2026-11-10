#!/usr/bin/env bash
# v2c wire proof — candidate hygiene end-to-end, no browser, no deploy.
# Boots the REAL bridge binary on loopback with a temp token, POSTs an offer
# with a poisoned trickle array (100.64/10 + 127/8 + good ip), then checks:
#   [1] offer accepted (200) with a valid answer
#   [2] stderr shows the forbidden trickle candidates were dropped
#   [3] answer carries NO forbidden candidate (filtered emission)
set -euo pipefail
cd "$(dirname "$0")"
BIN=./target/release/bifrost-net
TMP=$(mktemp -d)
trap 'kill $PID 2>/dev/null; rm -rf "$TMP"' EXIT

RAW="bfnt-v2cwireproof-tokenvalue"
HASH=$(python3 -c "import hashlib,sys;print(hashlib.sha256('$RAW'.encode()).hexdigest())")
cat > "$TMP/devices.json" <<EOF
{"devices":[{"id":"dev_v2c","name":"v2c","tokenHash":"$HASH","created":"now","revoked":false}]}
EOF
# NOTE: the devices.json contract is camelCase (pwa/lib/devices.ts,
# tokens.rs serde rename) — the doc comment's token_hash is a lie.
# public-style IP so emission has something real to advertise; media on :0
NODE_KEY=$($BIN keygen | sed -n 's/^private_key *= *"\(.*\)"/\1/p')
cat > "$TMP/bridge.toml" <<EOF
[node]
name = "v2c-proof"
private_key = "$NODE_KEY"

[bridge]
http = "127.0.0.1:0"
media = "127.0.0.1:0"
tokens_file = "$TMP/devices.json"
candidates = ["100.104.229.17", "179.237.67.146", "127.0.0.1"]
EOF

$BIN bridge -c "$TMP/bridge.toml" >"$TMP/out.log" 2>"$TMP/err.log" &
PID=$!
sleep 1

HTTP=$(grep -o '127.0.0.1:[0-9]*' "$TMP/out.log" | head -1)

python3 - "$HTTP" "$RAW" "$TMP" <<'PY'
import json, socket, sys, hashlib, os, struct
http, raw, tmp = sys.argv[1], sys.argv[2], sys.argv[3]
host, port = http.rsplit(":", 1)

# --- build a minimal-but-valid str0m-consumable SDP offer (munged v9 path):
# the selftest V9Client does exactly this; here we hand-roll the POST body and
# borrow its offer construction via the compiled binary is overkill, so reuse
# the exact SDP template the bridge accepts (Chrome trickle-shaped: no a=candidate
# in SDP, candidates in the JSON array — plus one forbidden line IN the SDP to
# prove the strip path too).
sdp = (
    "v=0\r\n"
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n"
    "s=-\r\nt=0 0\r\n"
    "a=group:BUNDLE 0\r\n"
    "a=ice-options:trickle\r\n"
    "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    "c=IN IP4 0.0.0.0\r\n"
    "a=rtcp:9 IN IP4 0.0.0.0\r\n"
    "a=ice-ufrag:V2Cufrag\r\n"
    "a=ice-pwd:v2cwireproofpwdv2cwireproofpwd\r\n"
    "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00\r\n"
    "a=setup:actpass\r\n"
    "a=mid:0\r\n"
    "a=sendrecv\r\n"
    "a=rtcp-mux\r\n"
    "a=rtpmap:111 opus/48000/2\r\n"
    "a=fmtp:111 minptime=10;useinbandfec=1\r\n"
    "a=candidate:1 1 udp 2130706431 100.104.229.17 42311 typ host\r\n"
    "a=candidate:2 1 udp 2130706430 127.0.0.1 8239 typ host\r\n"
    "a=end-of-candidates\r\n"
)
body = json.dumps({
    "type": "offer",
    "sdp": sdp,
    "candidates": [
        "candidate:1 1 udp 2130706431 100.104.229.17 42311 typ host",
        "candidate:2 1 udp 2130706430 127.0.0.1 8239 typ host generation 0",
        "candidate:3 1 udp 2130706429 179.237.67.146 52147 typ host generation 0",
    ],
})
req = (
    f"POST /offer HTTP/1.1\r\nHost: bridge\r\n"
    f"Authorization: Bearer {raw}\r\n"
    f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
    f"Connection: close\r\n\r\n{body}"
)
s = socket.create_connection((host, int(port)), timeout=5)
s.sendall(req.encode())
rawresp = s.recv(65536).decode(errors="replace")
head, _, respbody = rawresp.partition("\r\n\r\n")
status = head.splitlines()[0]
print(f"[1] {status}")
assert " 200 " in status, f"offer rejected: {head}"
ans = json.loads(respbody)
ans_sdp = ans["sdp"] if isinstance(ans, dict) else str(ans)
for bad in ("100.104.229.17", "127.0.0.1"):
    assert bad not in ans_sdp, f"answer leaks forbidden candidate {bad}"
print("[3] answer SDP carries NO forbidden candidate")
PY

echo "[2] bridge stderr hygiene lines:"
grep "candidate hygiene" "$TMP/err.log" | sed 's/^/    /'
grep -q "dropped forbidden trickle" "$TMP/err.log"
grep -q "refused to advertise" "$TMP/err.log"
grep -q "stripped .* a=candidate" "$TMP/err.log"
echo "V2C WIRE PROOF: GREEN — poisoned offer answered clean"
