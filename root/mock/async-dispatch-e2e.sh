#!/usr/bin/env bash
# scratch e2e for async-dispatch-r1 (mock upstream :18111; scratch brain :14111; NEVER :4100)
# [MAIN] busy on an owner turn (sleep 4) dispatches to a lane session with ?async=1 (sleep 3):
# the POST answers at once, the held turn completes later, the completion auto-turn lands in
# [MAIN]'s store (meta.auto + meta.async) and [MAIN]'s reply to it is stamped autoReply.
set -u
D=/tmp/async-dispatch-e2e; rm -rf $D; mkdir -p $D
CRATE=$(cd "$(dirname "$0")/.." && pwd); BIN=${BIN:-$CRATE/target/release/yggdrasil}
Y=127.0.0.1:14111; U=http://$Y
python3 $CRATE/mock/mock_upstream.py 18111 >$D/mock.log 2>&1 & MOCK=$!
YGG_DATA_DIR=$D/data YGG_LISTEN=$Y YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18111/v1 YGG_UPSTREAM_STYLE=openai \
 YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock YGG_PROJECT_DIR=$D $BIN 2>>$D/ygg.log & SRV=$!
trap 'kill $MOCK $SRV 2>/dev/null' EXIT
for _ in $(seq 50); do curl -sf $U/session >/dev/null && break; sleep 0.1; done
mk() { curl -sf -X POST $U/session -H 'content-type: application/json' -d "{\"title\":\"$1\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'; }
MAIN=$(mk '[MAIN]'); LANE=$(mk '[LANE] async-e2e')
echo "MAIN=$MAIN LANE=$LANE"
post() { curl -s -o "$3" -w '%{http_code} %{time_total}' -X POST "$U/session/$1/message$2" -H 'content-type: application/json' -d "$4"; }
# MAIN busy: an owner turn that takes 4 s
post $MAIN '' $D/main-owner.json '{"parts":[{"type":"text","text":"OWNER ask sleep 4"}]}' >$D/main-owner.code &
OWN=$!
for _ in $(seq 40); do curl -s $U/session/status | grep -q $MAIN && break; sleep 0.1; done
BUSY=$(curl -s $U/session/status | grep -c $MAIN)
# validation: unknown origin / self origin = 400, nothing stored
V1=$(post $LANE '?async=1&origin=ses_nope' $D/v1.json '{"parts":[{"type":"text","text":"x"}]}')
V2=$(post $LANE "?async=1&origin=$LANE" $D/v2.json '{"parts":[{"type":"text","text":"x"}]}')
# the dispatch: no origin given -> derived [MAIN]
T0=$(date +%s%3N)
R=$(post $LANE '?async=1' $D/dispatch.json '{"parts":[{"type":"text","text":"LANE-WORK reply: LANE-GREEN sleep 3"}]}')
T1=$(date +%s%3N)
curl -s $U/session/$LANE/message >$D/lane-at-ack.json
curl -s $U/session/status >$D/status-at-ack.json
for _ in $(seq 150); do
  curl -s "$U/session/$MAIN/message?internal=1" >$D/main-final.json
  python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); sys.exit(0 if any(x["info"].get("meta",{}).get("autoReply") for x in m) else 1)' $D/main-final.json && break
  sleep 0.2
done
wait $OWN
curl -s $U/session/$LANE/message >$D/lane-final.json
python3 - $D "$MAIN" "$LANE" "$R" "$T0" "$T1" "$BUSY" "$V1" "$V2" <<'PY'
import json,sys
D,MAIN,LANE,R,T0,T1,BUSY,V1,V2=sys.argv[1:10]; fail=0
def chk(n,ok):
    global fail; print(("PASS " if ok else "FAIL ")+n); fail|=not ok
code,secs=R.split(); ack=json.load(open(D+"/dispatch.json"))
print("dispatch ack:", json.dumps(ack), f"http={code} t={float(secs)*1000:.0f}ms")
chk("MAIN busy (owner turn running) when it dispatched", BUSY=="1")
chk("unknown origin -> 400", V1.split()[0]=="400")
chk("origin == target -> 400", V2.split()[0]=="400")
chk("async POST answered 200 at once (<500 ms)", code=="200" and float(secs)<0.5)
chk("ack = {turn_id, origin=[MAIN] (derived), status=queued}", ack.get("turn_id","").startswith("msg_") and ack.get("origin")==MAIN and ack.get("status")=="queued" and ack.get("sessionID")==LANE)
lane_ack=json.load(open(D+"/lane-at-ack.json"))
held=[m for m in lane_ack if m["info"]["id"]==ack["turn_id"]]
chk("turn stored at ack with meta.origin, reply not done yet", held and held[0]["info"]["meta"]["origin"]==MAIN and not any(m["info"]["role"]=="assistant" and m["info"]["time"].get("completed") for m in lane_ack))
lane=json.load(open(D+"/lane-final.json")); rep=[m for m in lane if m["info"]["role"]=="assistant"]
done_ms=rep[-1]["info"]["time"].get("completed",0) if rep else 0
chk("held turn completed later (>=2.5 s after the ack)", done_ms - int(T1) >= 2500 and "LANE-GREEN" in json.dumps(rep[-1]["parts"]))
main=json.load(open(D+"/main-final.json"))
comp=[m for m in main if m["info"]["role"]=="user" and m["info"].get("meta",{}).get("async")]
c=comp[-1] if comp else {"info":{"meta":{}},"parts":[{}]}
a=c["info"]["meta"].get("async",{})
print("completion meta:", json.dumps(c["info"].get("meta")))
print("completion text:", json.dumps(c["parts"][0].get("text","")))
chk("completion auto-turn in [MAIN] store: meta.auto + async{turn_id,sessionID,status=completed,replyID}", c["info"]["meta"].get("auto") is True and a.get("turn_id")==ack["turn_id"] and a.get("sessionID")==LANE and a.get("status")=="completed" and a.get("replyID")==rep[-1]["info"]["id"])
chk("completion text header names turn + status", c["parts"][0].get("text","").startswith(f"ASYNC-DONE turn={ack['turn_id']} session={LANE}") and "status=completed" in c["parts"][0]["text"])
owner_done=[m for m in main if m["info"]["role"]=="assistant" and not m["info"].get("meta",{}).get("autoReply")]
chk("completion arrived after the held turn ended", c["info"]["time"]["created"] >= done_ms)
ar=[m for m in main if m["info"]["role"]=="assistant" and m["info"].get("meta",{}).get("autoReply")]
chk("[MAIN]'s reply to the completion is stamped autoReply (quiet law)", len(ar)==1 and ar[0]["info"]["time"].get("completed"))
chk("[MAIN] owner turn untouched (completed, not autoReply)", len(owner_done)==1 and owner_done[0]["info"]["time"].get("completed"))
sys.exit(1 if fail else 0)
PY
RC=$?; grep -E '^async ' $D/ygg.log; exit $RC
