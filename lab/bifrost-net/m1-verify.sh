#!/usr/bin/env bash
# bifrost-net M1 verification — one command, one verifiable output.
# Slices: config/keys, mesh service (timers+rekey+chaos), webrtc relay
# (signaling+cross-forward), serve boot. Refuses to lie: exits non-zero on any FAIL.
set -uo pipefail
cd "$(dirname "$0")"

PASS=0; TOTAL=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; }

echo "== bifrost-net M1 =="
cargo build --release -q || { echo "build failed"; exit 1; }
BIN=./target/release/bifrost-net

# 1. config + keys
TOTAL=$((TOTAL+1))
KP=$("$BIN" keygen)
PRIV=$(echo "$KP" | grep private | sed 's/.*"\(.*\)"/\1/')
PUB=$(echo "$KP" | grep public | sed 's/.*"\(.*\)".*/\1/')
TMP=$(mktemp -d)
sed -e "s|REPLACE_WITH_bifrost-net_keygen_OUTPUT|$PRIV|" -e "s|REPLACE_WITH_PEER_PUBLIC_KEY|$PUB|" \
  config.example.toml > "$TMP/cfg.toml"
if "$BIN" check -c "$TMP/cfg.toml" | grep -q "VALID" && \
   "$BIN" check -c "$TMP/cfg.toml" | grep -q "WARNING no candidates pinned"; then
  ok "S1 config: generated config VALID + livekit-scar warning present"
else
  fail "S1 config"
fi

# 2. M0 regression
TOTAL=$((TOTAL+1))
OUT=$("$BIN" selftest m0)
if echo "$OUT" | grep -q "M0.1 PASS" && echo "$OUT" | grep -q "M0.2 PASS"; then
  ok "M0 regression: both seams still green"
else
  fail "M0 regression"
fi

# 3. mesh service
TOTAL=$((TOTAL+1))
OUT=$("$BIN" selftest m1 2>&1 || true)
MESH=$(echo "$OUT" | grep -o "M1.1 PASS[^ ]*" | head -1)
echo "$OUT" | grep -q "M1.1 PASS" && ok "S2 mesh: $MESH" || { fail "S2 mesh: $(echo "$OUT" | grep M1.1)"; }

# 4. webrtc relay (same run)
TOTAL=$((TOTAL+1))
if echo "$OUT" | grep -q "M1.2 PASS"; then
  ok "S3 relay: $(echo "$OUT" | grep -o '[0-9]* A-frames relayed to B[^,]*, [0-9]* B-frames relayed to A')"
else
  fail "S3 relay: $(echo "$OUT" | grep M1.2)"
fi

# 5. serve boot smoke: both halves LIVE + signaling answers
TOTAL=$((TOTAL+1))
PORT=$((20000 + RANDOM % 20000))
sed -e "s|0.0.0.0:17880|127.0.0.1:$PORT|" -e "s|0.0.0.0:17881|127.0.0.1:$((PORT+1))|" \
  "$TMP/cfg.toml" > "$TMP/serve.toml"
"$BIN" serve -c "$TMP/serve.toml" > "$TMP/serve.log" 2>&1 &
SERVE_PID=$!
sleep 1.5
if kill -0 "$SERVE_PID" 2>/dev/null \
   && grep -q "mesh: udp .* — LIVE" "$TMP/serve.log" \
   && grep -q "webrtc: signaling .* — LIVE" "$TMP/serve.log" \
   && curl -s -m 2 -X POST "http://127.0.0.1:$PORT/offer" -d '{}' | grep -q "bad offer"; then
  ok "S4 serve: one process, mesh+webrtc LIVE, signaling answering"
else
  fail "S4 serve boot"
fi
kill "$SERVE_PID" 2>/dev/null
rm -rf "$TMP"

echo "M1 VERIFY: $PASS/$TOTAL PASS"
[ "$PASS" -eq "$TOTAL" ] && echo "M1 VERDICT: GREEN" || exit 1
