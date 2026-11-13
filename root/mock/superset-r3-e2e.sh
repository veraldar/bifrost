#!/usr/bin/env bash
# scratch e2e for superset-r3 (mock upstream :18107; scratch brain :14107; NEVER :4100)
# seeds: (a) normal pair, (b) interrupted exchange user,user,assistant, (c) reply-less owner turn
set -u
D=/tmp/superset-r3-e2e; rm -rf $D; mkdir -p $D
CRATE=$(cd "$(dirname "$0")/.." && pwd); BIN=${BIN:-$CRATE/target/release/yggdrasil}
Y=127.0.0.1:14107; U=http://$Y
python3 $CRATE/mock/mock_upstream.py 18107 >$D/mock.log 2>&1 & MOCK=$!
start() { YGG_DATA_DIR=$D/data YGG_LISTEN=$Y YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18107/v1 YGG_UPSTREAM_STYLE=openai \
 YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock YGG_PROJECT_DIR=$D $BIN 2>>$D/ygg.log & SRV=$!
 for _ in $(seq 50); do curl -sf $U/session >/dev/null && break; sleep 0.1; done; }
trap 'kill $MOCK $SRV 2>/dev/null' EXIT
start
SID=$(curl -sf -X POST $U/session -H 'content-type: application/json' -d '{"title":"[MAIN]"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
kill $SRV; wait $SRV 2>/dev/null
python3 - $D/data/session/$SID.json $SID <<'PY'
import json,sys,uuid
f,sid=sys.argv[1:3]; d=json.load(open(f)); FAT="filler "*300; t=[1794000000000]
def msg(role,text,done=False):
    t[0]+=1000; mid="msg_"+uuid.uuid4().hex
    info={"id":mid,"role":role,"sessionID":sid,"time":{"created":t[0]}}
    if done: info["time"]["completed"]=t[0]+500
    return {"info":info,"parts":[{"id":"prt_"+uuid.uuid4().hex,"messageID":mid,"sessionID":sid,"type":"text","text":text}]}
m=[]
m+= [msg("user",f"A-NORMAL ask\n{FAT}"),msg("assistant",f"A-REPLY\n{FAT}",True)]                 # (a)
m+= [msg("user",f"B1-BURST ask\n{FAT}"),msg("user",f"B2-BURST ask\n{FAT}"),msg("assistant",f"B-REPLY\n{FAT}",True)]  # (b)
m+= [msg("user",f"C-NOREPLY ask\n{FAT}")]                                                   # (c)
for i in (1,2,3):
    m+= [msg("user",f"TAIL{i} ask\n{FAT}"),msg("assistant",f"TAIL{i}-REPLY\n{FAT}",True)]
d["messages"]=m; json.dump(d,open(f,"w"))
PY
start
curl -s -X POST $U/session/$SID/message -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"TRIGGER ask"}]}' -o /dev/null
curl -s http://127.0.0.1:18107/last > $D/last.json
python3 - $D <<'PY'
import json,sys
D=sys.argv[1]; fail=0
def chk(n,ok):
    global fail; print(("PASS " if ok else "FAIL ")+n); fail|=not ok
msgs=json.load(open(D+"/last.json"))["messages"]
t=[m["content"] if isinstance(m["content"],str) else json.dumps(m["content"]) for m in msgs]
size=len(json.dumps(msgs)); unfolded=2*(1+2+1+3)*len("filler "*300)+5*len("filler "*300)
print("upstream_history bytes:",size)
for k in ("A-NORMAL","B1-BURST","B2-BURST","C-NOREPLY"):
    chk(f"{k} digested", any(x.startswith("[earlier turn] "+k) for x in t))
chk("C digest marks no reply", any("C-NOREPLY ask => (no reply recorded)" in x for x in t))
chk("no fat older reply leaked", not any(r in x and "filler filler" in x for r in ("A-REPLY","B-REPLY") for x in t))
chk("A pair + B pair + C + TAIL1-2 fold to 6 lines (fold-tighten-r1 window 2)", sum(x.startswith("[earlier turn]") for x in t)==6)
chk("tail-2 (TAIL3, TRIGGER) verbatim", all(any(f"TAIL{i} ask" in x and "filler filler" in x for x in t) and any(f"TAIL{i}-REPLY" in x and "filler filler" in x for x in t) for i in (3,)) and any(x.startswith("TRIGGER ask") or "TRIGGER ask" in x and not x.startswith("[earlier") for x in t))
chk("size shrank (<60% of unfolded history)", size < 0.6*(unfolded+7*len("filler "*300)))
sys.exit(1 if fail else 0)
PY
