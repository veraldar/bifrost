#!/usr/bin/env bash
# scratch e2e for p95-fold-r1 (mock upstream :18105; scratch brain :14105; NEVER :4100)
set -u
D=/tmp/p95-fold-e2e; rm -rf $D; mkdir -p $D
CRATE=$(cd "$(dirname "$0")/.." && pwd); BIN=${BIN:-$CRATE/target/release/yggdrasil}
Y=127.0.0.1:14105; U=http://$Y
python3 $CRATE/mock/mock_upstream.py 18105 >$D/mock.log 2>&1 & MOCK=$!
YGG_DATA_DIR=$D/data YGG_LISTEN=$Y YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18105/v1 YGG_UPSTREAM_STYLE=openai \
 YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock YGG_PROJECT_DIR=$D $BIN 2>$D/ygg.log & SRV=$!
trap 'kill $MOCK $SRV 2>/dev/null' EXIT
for _ in $(seq 50); do curl -sf $U/session >/dev/null && break; sleep 0.1; done
SID=$(curl -sf -X POST $U/session -H 'content-type: application/json' -d '{"title":"[MAIN]"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
FAT=$(python3 -c 'print("filler "*300)')
post() { python3 -c 'import json,sys;d={"parts":[{"type":"text","text":sys.argv[1]}]}
if sys.argv[2]=="auto": d["meta"]={"auto":True}
print(json.dumps(d))' "$1" "$2" | curl -s -X POST $U/session/$SID/message -H 'content-type: application/json' -d @- -o /dev/null; curl -s http://127.0.0.1:18105/last > $D/last.$3.json; }
n=0
for i in 1 2 3 4 5 6 7 8; do
  post "OWNER$i ask
$FAT" owner $((++n)); post "AUTO$i landing
$FAT" auto $((++n))
done
python3 - $D $n <<'PY'
import json,sys
D,n=sys.argv[1],int(sys.argv[2]); fail=0
def chk(name,ok):
    global fail; print(("PASS " if ok else "FAIL ")+name); fail|=not ok
def body(k): return json.load(open(f"{D}/last.{k}.json"))["messages"]
def txt(m): return m["content"] if isinstance(m["content"],str) else json.dumps(m["content"])
sizes=[len(json.dumps(body(k))) for k in range(1,n+1)]
print("upstream body bytes per turn:",sizes)
last=body(n); t=[txt(m) for m in last]
chk("digest lines present (earlier turn + station turn)", any(x.startswith("[earlier turn] OWNER1 ask") for x in t) and any(x.startswith("[station turn] AUTO1 landing") for x in t))
chk("last 2 owner turns verbatim (OWNER7-8 full text; fold-tighten-r1 window 2)", all(any(f"OWNER{i} ask" in x and "filler filler" in x for x in t) for i in (7,8)))
chk("owner 1-6 not verbatim", not any(f"OWNER{i} ask\nfiller" in x for i in range(1,7) for x in t))
chk("body bounded: last turn smaller than 2x the 7th-pair size, not linear", sizes[-1] < sizes[7]*1.3)
# a fully-linear history would have ~ n*2*2100 bytes; folded must be far under
chk("shrink vs unfolded estimate", sizes[-1] < 0.6*(n*2*len(json.dumps("filler "*300))))
# prefix stability: consecutive turns share the digest prefix byte-for-byte
a,b=[txt(m) for m in body(n-2)],[txt(m) for m in body(n)]
common=0
for x,y in zip(a,b):
    if x!=y: break
    common+=1
chk(f"prefix stable across adjacent turns (first {common} msgs identical)", common>=3)
sys.exit(1 if fail else 0)
PY
