#!/usr/bin/env bash
# test-send-lane.sh — E2E for send-lane.sh + watch-landings SEND-WILL (send-reliability-r1). Scratch brain on a
# random port + mock upstream with MOCK_LATENCY=60 (queue delay). NEVER touches :4100.
set -u
R="$(cd "$(dirname "$0")/.." && pwd)"; B="${YGG_BIN:-$R/lab/yggdrasil/target/release/yggdrasil}"
S="$(mktemp -d /tmp/send-e2e.XXXXXX)"; export SEND_WILL_DIR="$S/will" SEND_ACK_DIR="$S/acks"
port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
MP=$(port); BP=$(port); BU="http://127.0.0.1:$BP"; PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null; pkill -f "$S" 2>/dev/null; rm -rf "$S"' EXIT
python3 "$R/lab/yggdrasil/mock/mock_upstream.py" "$MP" >/dev/null 2>&1 & PIDS+=($!)
mkdir -p "$S/data"
YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MP" YGG_UPSTREAM_STYLE=anthropic YGG_LISTEN="127.0.0.1:$BP" \
  YGG_DATA_DIR="$S/data" YGG_TOOLS=0 YGG_ROLLUP_TOKENS=0 YGG_UPSTREAM_API_KEY=mock-key "$B" >"$S/brain.log" 2>&1 & BRAIN=$!; PIDS+=($BRAIN)
sleep 1.5
SID=$(curl -s -X POST "$BU/session" -H 'content-type: application/json' -d '{"title":"send-e2e"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "scratch brain $BU session $SID mock-delay ${DELAY:-60}s"

echo "== case 1: caller killed at 15 s while the POST queues behind a ${DELAY:-60}s turn =="
T0=$(date +%s)
# the "coordinator bash": 15 s cap kills the whole process group of its caller
timeout -s KILL 15 setsid bash -c "BRAIN_URL=$BU '$R/scripts/send-lane.sh' -s $SID -t E2E-DELAY -m 'dispatch brief E2E sleep ${DELAY:-60}' -w 60" ; echo "caller rc=$? after $(( $(date +%s)-T0 ))s (137 = killed)"
ls "$SEND_ACK_DIR" 2>/dev/null; echo "ack present at kill time: $(cat "$SEND_ACK_DIR"/*.txt 2>/dev/null | wc -l) line(s)"
for i in $(seq 1 90); do [ -s "$(ls "$SEND_ACK_DIR"/*.txt 2>/dev/null | head -1)" ] && break; sleep 1; done
echo "ack after $(( $(date +%s)-T0 ))s:"; cat "$SEND_ACK_DIR"/*.txt
N=$(curl -s "$BU/session/$SID/message" | python3 -c 'import json,sys;print(sum(1 for m in json.load(sys.stdin) if m["info"]["role"]=="user"))')
echo "user messages in transcript: $N (1 = no double-send)"
[ "$N" = 1 ] && [ -s "$SEND_ACK_DIR"/*.txt ] && echo CASE1 PASS || echo CASE1 FAIL

echo "== case 2: dead-client retry = dup-ack, not re-POST =="
W=$(ls "$SEND_WILL_DIR"/*[0-9Z].json | grep -v payload | head -1)
BRAIN_URL=$BU "$R/scripts/send-lane.sh" --resend "$W" >/dev/null; sleep 3
tail -1 "$SEND_ACK_DIR"/*.txt | tr '\t' ' '
N=$(curl -s "$BU/session/$SID/message" | python3 -c 'import json,sys;print(sum(1 for m in json.load(sys.stdin) if m["info"]["role"]=="user"))')
echo "user messages: $N"; [ "$N" = 1 ] && grep -q 'mode=dup' "$SEND_ACK_DIR"/*.txt && echo CASE2 PASS || echo CASE2 FAIL

echo "== case 3: truly lost send (no brain) → SEND-WILL flags + re-sends once, then escalates =="
rm -rf "$SEND_WILL_DIR" "$SEND_ACK_DIR"; ST="$S/status.tsv"; : >"$ST"; : >"$S/log.tsv"
export SEND_TRIES=2 SEND_BACKOFF=1
BRAIN_URL=http://127.0.0.1:1 "$R/scripts/send-lane.sh" -s ses_none -t E2E-LOST -m 'lost brief' -w 5; echo "send rc=$? (3 = still retrying/no ack)"
STATUS_FILE="$ST" SEND_LOG_TSV="$S/log.tsv" SEND_SCAN_SECS=2 SEND_ROW_SECS=5 POLL_SECS=3600 LF_SWEEP=0 \
  BRAIN_URL=http://127.0.0.1:1 "$R/scripts/watch-landings.sh" >"$S/watch.out" 2>&1 & PIDS+=($!)
sleep 22
echo "--- status rows"; cat "$ST"; echo "--- watch.log"; cat "$SEND_WILL_DIR/watch.log"
[ "$(grep -c '^[^ ]*.SEND-LOST E2E-LOST' "$ST")" = 1 ] && [ "$(grep -c ESCALATED "$ST")" = 1 ] && echo CASE3 PASS || echo CASE3 FAIL
sleep 8; echo "rows after extra 8s (must not grow): $(wc -l <"$ST")"
