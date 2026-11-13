#!/usr/bin/env bash
# async-dispatch-r1 LIVE proof. Waits for the watcher's SWAP-DONE row for $NAME (never restarts
# anything itself), then on live :4100 with two throwaway [E2E] sessions (deleted after): origin
# made busy by an owner turn, dispatch to target with ?async=1&origin=<origin>, check instant 200,
# held turn completes later, completion auto-turn (meta.auto + meta.async) lands in origin's store
# and origin's reply to it is autoReply-stamped. Result: $OUT transcript, verdict line rewritten in
# $ART, one row in /tmp/sub-status.tsv.
set -u
NAME=${NAME:-yggdrasil-async-r1-e662bde7}
U=${U:-http://127.0.0.1:4100}
ART=${ART:-$HOME/Work/bifrost/artifacts/async-dispatch-r1.md}
OUT=${OUT:-$HOME/Work/bifrost/artifacts/async-dispatch-r1-live.txt}
STATUS=${STATUS:-/tmp/sub-status.tsv}
D=$(mktemp -d /tmp/async-live-proof.XXXX)
for _ in $(seq 1440); do   # up to 12 h, 30 s polls
  grep -qE "SWAP-DONE $NAME" $STATUS 2>/dev/null && break
  grep -qE "SWAP-ESCALATE $NAME" $STATUS 2>/dev/null && { printf 'async-dispatch-r1 LIVE-PROOF RED %s — swap escalated, binary never went live\n' "$(date -Iseconds)" >>$STATUS; exit 1; }
  sleep 30
done
grep -qE "SWAP-DONE $NAME" $STATUS || { printf 'async-dispatch-r1 LIVE-PROOF RED %s — no SWAP-DONE in 12 h (MAIN never idle with no lane)\n' "$(date -Iseconds)" >>$STATUS; exit 1; }
sleep 5
EXE=$(basename "$(readlink /proc/$(systemctl --user show lk-yggdrasil -p MainPID --value)/exe)")
mk() { curl -sf -X POST $U/session -H 'content-type: application/json' -d "{\"title\":\"$1\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'; }
ORIG=$(mk '[E2E] async-origin'); TGT=$(mk '[E2E] async-target')
post() { curl -s -o "$3" -w '%{http_code} %{time_total}' --max-time 20 -X POST "$U/session/$1/message$2" -H 'content-type: application/json' -d "$4"; }
B=$(post $ORIG '?async=1&origin=none' $D/busy.json '{"parts":[{"type":"text","text":"Reply with exactly: ORIGIN-BUSY-OK (no tools)"}]}')
BUSY=$(curl -s $U/session/status | grep -c $ORIG)
T1=$(date +%s%3N)
R=$(post $TGT "?async=1&origin=$ORIG" $D/dispatch.json '{"parts":[{"type":"text","text":"Reply with exactly: ASYNC-LIVE-OK (no tools)"}]}')
curl -s $U/session/$TGT/message >$D/tgt-at-ack.json
for _ in $(seq 360); do
  curl -s "$U/session/$ORIG/message?internal=1" >$D/orig.json
  python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); sys.exit(0 if any(x["info"].get("meta",{}).get("autoReply") and x["info"]["time"].get("completed") for x in m) else 1)' $D/orig.json 2>/dev/null && break
  sleep 0.5
done
curl -s $U/session/$TGT/message >$D/tgt.json
python3 - $D "$ORIG" "$TGT" "$R" "$T1" "$BUSY" "$EXE" "$B" >$OUT 2>&1 <<'PY'
import json,sys
D,ORIG,TGT,R,T1,BUSY,EXE,B=sys.argv[1:9]; fail=0
def chk(n,ok):
    global fail; print(("PASS " if ok else "FAIL ")+n); fail|=not ok
print(f"live :4100 exe={EXE} origin={ORIG} target={TGT} busy-post={B}")
chk("live brain runs the async build", EXE.startswith("yggdrasil-async-r1-"))
code,secs=R.split(); ack=json.load(open(D+"/dispatch.json"))
print("dispatch ack:", json.dumps(ack), f"http={code} t={float(secs)*1000:.0f}ms")
chk("origin busy (owner turn running) at dispatch", BUSY=="1")
chk("async POST 200 at once (<500 ms) with turn_id + origin", code=="200" and float(secs)<0.5 and ack.get("origin")==ORIG and ack.get("turn_id","").startswith("msg_"))
at=json.load(open(D+"/tgt-at-ack.json"))
chk("held: turn stored, no completed reply at ack", any(m["info"]["id"]==ack.get("turn_id") for m in at) and not any(m["info"]["role"]=="assistant" and m["info"]["time"].get("completed") for m in at))
tg=json.load(open(D+"/tgt.json")); rep=[m for m in tg if m["info"]["role"]=="assistant"]
done=rep[-1]["info"]["time"].get("completed",0) if rep else 0
chk("held turn completed later", done > int(T1))
o=json.load(open(D+"/orig.json"))
comp=[m for m in o if m["info"]["role"]=="user" and m["info"].get("meta",{}).get("async",{}).get("turn_id")==ack.get("turn_id")]
c=comp[-1] if comp else {"info":{"meta":{}},"parts":[{}]}
print("completion meta:", json.dumps(c["info"].get("meta"))); print("completion text:", json.dumps(c["parts"][0].get("text",""))[:400])
chk("completion auto-turn in origin store (meta.auto, async.status=completed, replyID)", c["info"]["meta"].get("auto") is True and c["info"]["meta"]["async"].get("status")=="completed" and c["info"]["meta"]["async"].get("replyID")==(rep[-1]["info"]["id"] if rep else None))
ar=[m for m in o if m["info"]["role"]=="assistant" and m["info"].get("meta",{}).get("autoReply")]
chk("origin's reply to the completion stamped autoReply", len(ar)>=1)
print("VERDICT", "GREEN" if not fail else "RED")
sys.exit(1 if fail else 0)
PY
RC=$?
curl -s -X DELETE $U/session/$ORIG >/dev/null; curl -s -X DELETE $U/session/$TGT >/dev/null
if [ $RC = 0 ]; then
  sed -i '1s/.*/# async-dispatch-r1 — DONE-GREEN (live :4100 e2e by the armed prover, transcript async-dispatch-r1-live.txt)/' $ART
  sed -i '/^Next-actions:/,/^- follow-up/d' $ART
  printf 'async-dispatch-r1 LIVE-PROOF GREEN %s — ?async=1 live on :4100 (%s); transcript artifacts/async-dispatch-r1-live.txt\n' "$(date -Iseconds)" "$EXE" >>$STATUS
else
  printf 'async-dispatch-r1 LIVE-PROOF RED %s — see artifacts/async-dispatch-r1-live.txt\n' "$(date -Iseconds)" >>$STATUS
fi
exit $RC
