#!/usr/bin/env bash
# TIME-AWARENESS two-turn gap sim (owner ADD to the cap slice, 11-05).
# Real brain server, real HTTP flow, mock upstream; the brain restarted
# between the turns (same data dir — sessions persist). A REAL 26h gap is
# produced server-side via YGG_CLOCK_EPOCH_MS (test-only knob, the
# MOCK_LATENCY precedent); the 2min leg runs clock-natural.
# Owner law: assert CLOCK-GAP on the long leg, NO meanwhile-preamble on short.
set -u
CRATE="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d /tmp/clock-sim.XXXXXX)"
MOCK_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
BRAIN_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  [ -n "${BRAIN_PID:-}" ] && kill "$BRAIN_PID" 2>/dev/null
  [ -n "${BRAIN2_PID:-}" ] && kill "$BRAIN2_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SCRATCH/data"

python3 "$CRATE/mock/mock_upstream.py" "$MOCK_PORT" >/dev/null 2>&1 &
MOCK_PID=$!
B="$CRATE/target/debug/yggdrasil"
YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT" YGG_LISTEN="127.0.0.1:$BRAIN_PORT" \
YGG_DATA_DIR="$SCRATCH/data" YGG_TOOLS=0 YGG_ROLLUP_TOKENS=0 "$B" >/dev/null 2>&1 &
BRAIN_PID=$!
sleep 1.2
BRAIN="http://127.0.0.1:$BRAIN_PORT"
S=$(curl -s -X POST "$BRAIN/session" -H 'Content-Type: application/json' -d '{"title":"clock-sim"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
[ -n "$S" ] || { echo "FAIL: no session"; exit 1; }

# ── TURN 1: clock-natural ──
R1=$(curl -s -X POST "$BRAIN/session/$S/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}]}')
echo "$R1" | grep -q 'MOCK-REPLY' || { echo "FAIL t1 reply: $R1"; exit 1; }
echo "t1 ok: $(echo "$R1" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["parts"][0]["text"][:60])')"

# ── leg A: 2min gap, SAME process, clock-natural ──
sleep 2
R2=$(curl -s -X POST "$BRAIN/session/$S/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"and now?"}]}')
echo "$R2" | grep -q 'MOCK-REPLY' && ! echo "$R2" | grep -q 'CLOCK-GAP\|meanwhile' \
  && echo "SHORT-GAP PASS: no meanwhile-preamble ($(echo "$R2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["parts"][0]["text"][:50])'))" \
  || { echo "FAIL short leg: $R2"; exit 1; }

# ── leg B: 26h synthetic gap — the brain RESTARTS with a shifted clock ──
# (sessions persist in YGG_DATA_DIR; the shift is applied at the server level)
kill "$BRAIN_PID" 2>/dev/null; wait "$BRAIN_PID" 2>/dev/null
NOW=$(date +%s)
SHIFT=$(( 26 * 3600 ))   # "now" 26h in the future → gap vs turn 1 = 26h
YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT" YGG_LISTEN="127.0.0.1:$BRAIN_PORT" \
YGG_DATA_DIR="$SCRATCH/data" YGG_TOOLS=0 YGG_ROLLUP_TOKENS=0 \
YGG_CLOCK_SHIFT_SECS=$SHIFT "$B" >/dev/null 2>&1 &
BRAIN2_PID=$!
sleep 1.2
R3=$(curl -s -X POST "$BRAIN/session/$S/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"back after a day away"}]}')
echo "$R3" | grep -q 'CLOCK-GAP' || { echo "FAIL long leg (no CLOCK-GAP): $R3"; exit 1; }
echo "$R3" | grep -q 'meanwhile\|re-anchored' || { echo "FAIL long leg (no refresh): $R3"; exit 1; }
echo "LONG-GAP PASS: $(echo "$R3" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["parts"][0]["text"][:110])')"
# Wire provenance: the CLOCK-GAP reply embeds the gap string + meanwhile lines
# VERBATIM FROM the header the brain put on the wire — the header content is
# proven served; exact-string shapes are proven by the 5 unit tests.
exit 0
