#!/usr/bin/env bash
# scratch e2e for coordinator ≤5s law (mock upstream; scratch brain :14103; NEVER :4100)
set -u
D=/tmp/lat-e2e; rm -rf $D/data $D/*.log; BIN=~/Work/bifrost/lab/yggdrasil/target/release/yggdrasil
Y=127.0.0.1:14103; U=http://$Y
python3 ~/Work/bifrost/lab/yggdrasil/mock/lat_mini_mock.py 18103 >$D/mock.log 2>&1 & MOCK=$!
YGG_DATA_DIR=$D/data YGG_LISTEN=$Y YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18103/v1 YGG_UPSTREAM_STYLE=openai \
 YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock YGG_MAIN_BASH_TIMEOUT_MS=2000 YGG_MAIN_MAX_STEPS=3 \
 YGG_PROJECT_DIR=$D $BIN 2>$D/ygg.log & SRV=$!
trap 'kill $MOCK $SRV 2>/dev/null' EXIT
for _ in $(seq 50); do curl -sf $U/session >/dev/null && break; sleep 0.1; done
mk() { curl -sf -X POST $U/session -H 'content-type: application/json' -d "{\"title\":\"$1\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'; }
post() { # sid text [auto]
  local meta=""; [ "${3:-}" = auto ] && meta=',"meta":{"auto":true}'
  python3 -c 'import json,sys;print(json.dumps({"parts":[{"type":"text","text":sys.argv[1]}]}))' "$2" | sed "s/}\$/$meta}/" | \
   curl -s -X POST $U/session/$1/message -H 'content-type: application/json' -d @- -o /dev/null -w '%{http_code}'; }
FAIL=0; chk() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1: got '$2' want '$3'"; FAIL=1; fi; }

echo "== 1. ordering + coalesce (non-MAIN session)"
S=$(mk lane)
P=(); post $S "OWNER1 NAP4" >/dev/null & P+=($!); sleep 1
post $S "AUTO1" auto >/dev/null & P+=($!); sleep 0.3
post $S "AUTO2" auto >/dev/null & P+=($!); sleep 0.3
post $S "OWNER2" >/dev/null & P+=($!); wait "${P[@]}"
curl -s $U/session/$S/message | python3 -c '
import json,sys
ms=json.load(sys.stdin)
order=[]
for m in ms:
    if m["info"]["role"]=="assistant":
        t="".join(p.get("text","") for p in m["parts"] if p["type"]=="text")
        order.append((m["info"]["time"]["completed"], (__import__("re").findall(r"OWNER\d|AUTO\d",t) or ["?"])[0], bool(m["info"].get("meta",{}).get("autoReply"))))
order.sort()
print("ORDER", " > ".join(t+("[auto]" if a else "") for _,t,a in order))
print("AUTOREPLIES", sum(1 for _,_,a in order if a))' | tee $D/order.txt
grep -q "ORDER OWNER1 > OWNER2 > OWNER2\[auto\]" $D/order.txt && echo "PASS owner2 completed before the queued auto turn" || { echo "FAIL ordering"; FAIL=1; }
chk "N pending autos -> 1 turn" "$(grep AUTOREPLIES $D/order.txt | awk '{print $2}')" 1

echo "== 2. [MAIN] caps vs lane (NL bash call, no timeout arg = tool default 120s; env cap 2000ms)"
M=$(mk "[MAIN]"); L=$(mk lane2)
t0=$(date +%s.%N); post $M 'RUN: timeout 20 tail -f /dev/null' >/dev/null; t1=$(date +%s.%N)
python3 -c "
d=$t1-$t0; print(f'MAIN bash returned after {d:.1f}s'); import sys; sys.exit(0 if 1.5<d<6 else 1)"
[ $? = 0 ] && echo "PASS MAIN bash capped (~2s, not 20s)" || { echo "FAIL cap"; FAIL=1; }
curl -s $U/session/$M/message | grep -o 'timed out after [0-9]* ms' | head -1
t0=$(date +%s.%N); post $L 'RUN: timeout 3 tail -f /dev/null' >/dev/null; t1=$(date +%s.%N)
python3 -c "
d=$t1-$t0; print(f'lane bash returned after {d:.1f}s'); import sys; sys.exit(0 if d>=2.9 else 1)"
[ $? = 0 ] && echo "PASS lane session not capped (3s run completed)" || { echo "FAIL lane"; FAIL=1; }
echo "-- step cap: second scratch brain :14104 with YGG_MAIN_MAX_STEPS=1"
YGG_DATA_DIR=$D/data2 YGG_LISTEN=127.0.0.1:14104 YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18103/v1 YGG_UPSTREAM_STYLE=openai \
 YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock YGG_MAIN_MAX_STEPS=1 YGG_PROJECT_DIR=$D $BIN 2>$D/ygg2.log & SRV2=$!
for _ in $(seq 50); do curl -sf http://127.0.0.1:14104/session >/dev/null && break; sleep 0.1; done
U2=http://127.0.0.1:14104
M2=$(curl -sf -X POST $U2/session -H 'content-type: application/json' -d '{"title":"[MAIN]"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
L2=$(curl -sf -X POST $U2/session -H 'content-type: application/json' -d '{"title":"lane3"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "MAIN step cap (1)" "$(curl -s -X POST $U2/session/$M2/message -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"RUN: echo hi"}]}' | grep -o 'step cap ([0-9]* upstream')" "step cap (1 upstream"
chk "lane unaffected by MAIN step cap" "$(curl -s -X POST $U2/session/$L2/message -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"RUN: echo hi"}]}' | grep -o 'TOOL-DONE hi')" "TOOL-DONE hi"
kill $SRV2
echo "== 3. LAT rows"; grep "LAT phase" $D/ygg.log | sed 's/ttfb_ms.*voice_note/... voice_note/' | head -12
echo "== 4. lat-p95 against scratch journal"
MAINID=$M LOG_FILE=$D/ygg.log SES_ID=$S OUT_TSV=$D/p95.tsv STATUS_FILE=$D/sub.tsv STATE_FILE=$D/p95.state ~/Work/bifrost/scripts/lat-p95.sh
echo "FAIL=$FAIL"
