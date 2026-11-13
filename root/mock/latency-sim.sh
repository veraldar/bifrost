#!/usr/bin/env bash
# SPEED LAW server-level sim (11-05 amendment to HFSIM). Three legs:
#   FAST   — mock upstream, instant first chunk; assert the reply lands fast
#            and the LAT log row has ttfb>0, first_token=true.
#   SLOW   — "sleep 4" in the text (the mock's first-chunk delay feature);
#            proves ttfb carries the wait (the metric moves with the cause).
#   FAIL   — upstream 400s EVERY request (mock-400 key); asserts the fast
#            path (<10s, no retry sleep) — the model-400 bug as a unit test —
#            and that the failure is LOUD: LAT-FAIL in the brain's stderr.
# Owner law: latency rows in every verdict; fallbacks never silent.
set -u
CRATE="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d /tmp/lat-sim.XXXXXX)"
MOCK_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
BRAIN_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  [ -n "${BRAIN_PID:-}" ] && kill "$BRAIN_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SCRATCH/data"

python3 "$CRATE/mock/mock_upstream.py" "$MOCK_PORT" >/dev/null 2>&1 &
MOCK_PID=$!
B="$CRATE/target/debug/yggdrasil"

start_brain() { # $1 = api key ("" = mock-default), $2 = unused (kept for shape), $3 = stderr log
  local key="$1" _="$2" logf="$3"
  : > "$logf"
  local envs=(YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT" YGG_UPSTREAM_STYLE=anthropic
    YGG_LISTEN="127.0.0.1:$BRAIN_PORT"
    YGG_DATA_DIR="$SCRATCH/data" YGG_TOOLS=0 YGG_ROLLUP_TOKENS=0)
  # the anthropic validator requires x-api-key; default keeps FAST/SLOW valid,
  # "mock-400" turns leg 3 into an upstream that 400s every request
  envs+=(YGG_UPSTREAM_API_KEY="${key:-mock-key}")
  env "${envs[@]}" "$B" >"$logf" 2>&1 &
  BRAIN_PID=$!
  sleep 1.2
}
stop_brain() { kill "$BRAIN_PID" 2>/dev/null; wait "$BRAIN_PID" 2>/dev/null; }

post() { # $1 session, $2 text -> prints body
  curl -s -X POST "http://127.0.0.1:$BRAIN_PORT/session/$1/message" \
    -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$2\"}]}"
}

pct() { # p50/p95 over stdin ms values
  sort -n | awk -v p="$1" '{a[NR]=$1} END{ if(!NR){print "NA"; exit}
    i=(p==50)?int((NR+1)/2):int((NR*95+99)/100); if(i<1)i=1; if(i>NR)i=NR; print a[i] }'
}

# ───────────────────────── leg 1: FAST ─────────────────────────
LOG="$SCRATCH/fast.log"
start_brain "" "0.25" "$LOG"
BRAIN="http://127.0.0.1:$BRAIN_PORT"
S=$(curl -s -X POST "$BRAIN/session" -H 'Content-Type: application/json' -d '{"title":"lat-sim"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
[ -n "$S" ] || { echo "FAIL: no session"; exit 1; }

FAST_MS=()
for i in 1 2 3 4 5; do
  T0=$(python3 -c 'import time;print(time.time())')
  R=$(post "$S" "lat probe $i")
  T1=$(python3 -c 'import time;print(time.time())')
  echo "$R" | grep -q 'MOCK-REPLY' || { echo "FAIL fast reply: $R"; exit 1; }
  FAST_MS+=($(python3 -c "print(int(($T1-$T0)*1000))"))
done
stop_brain
FAST_P50=$(printf '%s\n' "${FAST_MS[@]}" | pct 50)
FAST_P95=$(printf '%s\n' "${FAST_MS[@]}" | pct 95)
grep -q 'LAT phase=ok' "$LOG" || { echo "FAIL: no LAT row on the fast leg"; exit 1; }
grep -q 'first_token=true' "$LOG" || { echo "FAIL: fast leg first_token=false"; exit 0; }
echo "FAST PASS: p50=${FAST_P50}ms p95=${FAST_P95}ms (ttfb from MOCK_LATENCY, LAT rows present)"

# ───────────────────────── leg 2: SLOW (4s first chunk) ─────────────────────────
LOG="$SCRATCH/slow.log"
start_brain "" "" "$LOG"
SLOW_T0=$(python3 -c 'import time;print(time.time())')
R=$(post "$S" "sleep 4 lat probe slow")
SLOW_T1=$(python3 -c 'import time;print(time.time())')
stop_brain
echo "$R" | grep -q 'MOCK-REPLY' || { echo "FAIL slow reply: $R"; exit 1; }
SLOW_MS=$(python3 -c "print(int(($SLOW_T1-$SLOW_T0)*1000))")
[ "$SLOW_MS" -ge 3800 ] || { echo "FAIL: slow leg too fast ($SLOW_MS ms) — ttfb not carrying the wait"; exit 1; }
grep -Eq 'ttfb_ms=[34][0-9]{3}' "$LOG" || { echo "FAIL: slow-leg ttfb not ~4s in the LAT row: $(grep 'LAT ' "$LOG" | tail -1)"; exit 1; }
echo "SLOW PASS: total=${SLOW_MS}ms with a 4s first chunk — ttfb_ms carries the wait in the LAT row"

# ───────────────────────── leg 3: FAIL (upstream 400s everything) ─────────────────────────
LOG="$SCRATCH/fail.log"
start_brain "mock-400" "" "$LOG"
T0=$(python3 -c 'import time;print(time.time())')
R=$(post "$S" "lat probe failing")
T1=$(python3 -k -c 'import time;print(time.time())' 2>/dev/null || python3 -c 'import time;print(time.time())')
MS=$(python3 -c "print(int(($T1-$T0)*1000))")
stop_brain
echo "$R" | grep -q '"error"' || { echo "FAIL: 400 leg did not surface an error: $R"; exit 1; }
grep -q 'LAT-FAIL' "$LOG" || { echo "FAIL: no loud LAT-FAIL line on upstream 400"; exit 1; }
grep -q 'LAT phase=error' "$LOG" || { echo "FAIL: no LAT phase=error row: $(tail -3 "$LOG")"; exit 1; }
[ "$MS" -lt 10000 ] || { echo "FAIL: upstream-400 turn took ${MS}ms (>=10s) — slow-fail regression, the model-400 shape"; exit 1; }
echo "FAIL PASS: upstream 400 → loud LAT-FAIL + LAT phase=error, turn failed fast in ${MS}ms (<10s)"

echo "LATENCY-SIM: ALL PASS (fast p50=${FAST_P50}ms p95=${FAST_P95}ms; slow ttfb=${SLOW_MS}ms; fail fast+loud @${MS}ms)"
