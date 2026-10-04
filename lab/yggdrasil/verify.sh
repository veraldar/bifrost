#!/usr/bin/env bash
# Smoke test: mock upstream + yggdrasil + curls.
# Slice 1: session create, message post (SSE), history, 404.
# Slice 2: abort mid-stream, global GET /event, persistence across a restart.
# Slice 3: opencode-shaped JSON post, title/parent, get/patch/delete, busy map, catalog.
# Slice 6b: context roll-up — forced threshold, one extra upstream call, summary stored+visible,
#   recursive roll-up, restart, in-run tool-output prune.
# Slice 6a: agent loop — bash/read/write/edit/glob/grep/todowrite round-trips, truncation,
#   step cap, abort mid-tool. (Slice 4 = packaging, verified in ASSESSMENT.md; no slice 5 surface.)
# Slice 7: anthropic upstream dialect — mapping unit tests; one scenario (chat, tool loop, roll-up
#   crossing, post-roll-up turn) run in BOTH dialects, stored transcripts + client SSE compared
#   after id/timestamp normalization; anthropic abort mid-SSE; real-upstream hook self-test.
set -euo pipefail
cd "$(dirname "$0")"
source ~/.cargo/env
cargo build -q
MOCK_PORT=18080; YGG=127.0.0.1:14096
TMP=$(mktemp -d); export YGG_DATA_DIR=$TMP/data
python3 mock/mock_upstream.py $MOCK_PORT & MOCK=$!
start_srv() {
  YGG_UPSTREAM_BASE_URL=${BASE:-http://127.0.0.1:$MOCK_PORT/v1} YGG_UPSTREAM_STYLE=${STYLE:-openai} \
    YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock YGG_LISTEN=$YGG ./target/debug/yggdrasil & SRV=$!
  for _ in $(seq 50); do curl -sf http://$YGG/session >/dev/null && return; sleep 0.1; done
  echo "FAIL: server did not come up"; exit 1
}
SRV=; EV=
trap 'kill $MOCK $SRV $EV 2>/dev/null; rm -rf $TMP' EXIT
start_srv

# Global event listener, connected before anything happens.
curl -sfN http://$YGG/event >$TMP/events.txt & EV=$!
sleep 0.3

SID=$(curl -sf -X POST http://$YGG/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "session: $SID"
for msg in hello again; do
  echo "--- POST message: $msg"
  OUT=$(curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' -H 'accept: text/event-stream' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$msg\"}]}")
  echo "$OUT"
  grep -q "MOCK-REPLY: you said '$msg'" <<<"$OUT" || { echo "FAIL: reply missing in SSE"; exit 1; }
  grep -q '^event: message.part.delta' <<<"$OUT" || { echo "FAIL: no delta events"; exit 1; }
done
echo "--- GET messages"
MSGS=$(curl -sf http://$YGG/session/$SID/message); echo "$MSGS"
python3 - "$MSGS" <<'PY'
import sys, json
m = json.loads(sys.argv[1])
roles = [x["info"]["role"] for x in m]
assert roles == ["user", "assistant", "user", "assistant"], roles
assert m[3]["parts"][0]["text"] == "MOCK-REPLY: you said 'again' (3 msgs)", m[3]
PY
echo "--- 404 check"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://$YGG/session/nope/message)" = 404 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://$YGG/session/nope/abort)" = 404 ]

echo "--- abort mid-stream"
[ "$(curl -sf -X POST http://$YGG/session/$SID/abort)" = false ] || { echo "FAIL: idle abort should be false"; exit 1; }
curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"parts":[{"type":"text","text":"slow please"}]}' >$TMP/slow.txt & SLOW=$!
sleep 1.5   # mock emits a chunk every 0.2s; full reply takes ~10s
T0=$(date +%s.%N)
[ "$(curl -sf -X POST http://$YGG/session/$SID/abort)" = true ] || { echo "FAIL: abort did not report in-flight"; exit 1; }
wait $SLOW
DT=$(python3 -c "import sys;print(round($(date +%s.%N)-$T0,2))"); echo "stream closed ${DT}s after abort"
python3 -c "import sys;sys.exit(0 if $DT < 1.0 else 1)" || { echo "FAIL: abort not prompt"; exit 1; }
cat $TMP/slow.txt | tail -3
grep -q '^event: message.part.delta' $TMP/slow.txt || { echo "FAIL: no deltas before abort"; exit 1; }
grep -q '^event: message.aborted' $TMP/slow.txt || { echo "FAIL: no message.aborted"; exit 1; }
grep -q 'SLOW-END' $TMP/slow.txt && { echo "FAIL: full reply was streamed despite abort"; exit 1; }
grep -q '^event: message.completed' $TMP/slow.txt && { echo "FAIL: completed after abort"; exit 1; }
MSGS=$(curl -sf http://$YGG/session/$SID/message)
python3 - "$MSGS" "$TMP/slow.txt" <<'PY'
import sys, json
m = json.loads(sys.argv[1])
assert [x["info"]["role"] for x in m] == ["user", "assistant"] * 3, m
last = m[-1]
assert last["info"]["error"]["name"] == "MessageAbortedError", last
partial = last["parts"][0]["text"]
assert partial.startswith("MOCK-REPLY: you said 'slow please'") and "SLOW-END" not in partial, partial
# Stored partial == concatenation of the deltas the client actually received.
deltas = [json.loads(l[5:])["text"] for l in open(sys.argv[2]).read().splitlines()
          if l.startswith("data:") and '"text"' in l and '"info"' not in l]
assert "".join(deltas) == partial, ("".join(deltas), partial)
print("partial kept:", repr(partial))
PY
# Session still usable after abort.
OUT=$(curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"parts":[{"type":"text","text":"after"}]}')
grep -q "MOCK-REPLY: you said 'after' (7 msgs)" <<<"$OUT" || { echo "FAIL: post-abort turn"; echo "$OUT"; exit 1; }

echo "--- GET /event (global stream, not the poster)"
sleep 0.3; kill $EV; EV=
python3 - "$TMP/events.txt" "$SID" <<'PY'
import sys, json
evs = [json.loads(l[5:]) for l in open(sys.argv[1]).read().splitlines() if l.startswith("data:")]
types = [e["type"] for e in evs]
sid = sys.argv[2]
assert types[0] == "server.connected", types[:3]
for t in ["session.created", "message.updated", "message.part.delta", "message.completed", "message.aborted"]:
    assert t in types, (t, sorted(set(types)))
assert all(e["properties"]["sessionID"] == sid for e in evs if e["type"] == "message.part.delta")
done = [e for e in evs if e["type"] == "message.completed"]
assert len(done) == 3 and done[-1]["properties"]["info"]["sessionID"] == sid, len(done)
print(f"{len(evs)} global events: {sorted(set(types))}")
PY

echo "--- persistence across restart"
BEFORE=$(curl -sf http://$YGG/session/$SID/message)
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
start_srv
AFTER=$(curl -sf http://$YGG/session/$SID/message)
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: history differs after restart"; echo "$AFTER"; exit 1; }
curl -sf http://$YGG/session | grep -q "$SID" || { echo "FAIL: session missing from list"; exit 1; }
OUT=$(curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"parts":[{"type":"text","text":"reborn"}]}')
grep -q "MOCK-REPLY: you said 'reborn' (9 msgs)" <<<"$OUT" || { echo "FAIL: post-restart turn"; echo "$OUT"; exit 1; }
echo "history ($(python3 -c 'import sys,json;print(len(json.loads(sys.argv[1])))' "$AFTER") msgs) survived restart"
echo "--- slice 3: opencode surface"
J=(-H 'content-type: application/json')
S3=$(curl -sf -X POST http://$YGG/session "${J[@]}" -d '{"title":"s3-parent"}')
P3=$(python3 -c 'import sys,json;d=json.loads(sys.argv[1]);assert d["title"]=="s3-parent",d;print(d["id"])' "$S3")
C3=$(curl -sf -X POST http://$YGG/session "${J[@]}" -d "{\"title\":\"s3-child\",\"parentID\":\"$P3\"}")
python3 -c 'import sys,json;d=json.loads(sys.argv[1]);assert d["parentID"]==sys.argv[2],d' "$C3" "$P3"
# no Accept: event-stream → blocks, returns the completed assistant message as JSON
REPLY=$(curl -sf -X POST http://$YGG/session/$P3/message "${J[@]}" -d '{"parts":[{"type":"text","text":"Reply with exactly: pong"}]}')
python3 - "$REPLY" <<'PY2'
import sys, json
m = json.loads(sys.argv[1])
assert m["info"]["role"] == "assistant" and m["info"]["time"]["completed"] > 0, m
assert m["parts"][0]["text"] == "pong", m
PY2
# a live run shows in the busy map and as an un-completed assistant placeholder
curl -sf -X POST http://$YGG/session/$P3/message "${J[@]}" -d '{"parts":[{"type":"text","text":"sleep 2 then reply: late"}]}' >$TMP/late.json & LATE=$!
sleep 0.7
curl -sf http://$YGG/session/status | grep -q "\"$P3\":{\"type\":\"busy\"}" || { echo "FAIL: busy map"; exit 1; }
curl -sf http://$YGG/session/$P3/message | python3 -c 'import sys,json;m=json.load(sys.stdin)[-1]["info"];assert m["role"]=="assistant" and "completed" not in m["time"],m'
wait $LATE; grep -q '"text":"late"' $TMP/late.json || { echo "FAIL: late reply"; cat $TMP/late.json; exit 1; }
[ "$(curl -sf http://$YGG/session/status)" = "{}" ] || { echo "FAIL: busy map not cleared"; exit 1; }
curl -sf -X PATCH http://$YGG/session/$P3 "${J[@]}" -d '{"title":"s3-renamed"}' | grep -q s3-renamed
curl -sf http://$YGG/session/$P3 | grep -q s3-renamed || { echo "FAIL: rename"; exit 1; }
curl -sf http://$YGG/config/providers | grep -q '"providers"' || { echo "FAIL: providers"; exit 1; }
curl -sf http://$YGG/agent | grep -q '"build"' || { echo "FAIL: agents"; exit 1; }
MID=$(curl -sf http://$YGG/config/providers | python3 -c 'import sys,json;p=json.load(sys.stdin)["providers"][0];print(p["id"]+" "+next(iter(p["models"])))')
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://$YGG/api/session/$P3/model "${J[@]}" -d "{\"model\":{\"providerID\":\"${MID% *}\",\"id\":\"${MID#* }\"}}")" = 204 ] || { echo "FAIL: model switch"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://$YGG/api/session/$P3/agent "${J[@]}" -d '{"agent":"plan"}')" = 204 ] || { echo "FAIL: agent switch"; exit 1; }
curl -sf http://$YGG/session/$P3 | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["agent"]=="plan" and d["model"]["id"],d'
[ "$(curl -sf -X DELETE http://$YGG/session/$P3)" = true ] || { echo "FAIL: delete"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://$YGG/session/$P3)" = 404 ] || { echo "FAIL: deleted session still served"; exit 1; }
echo "slice-3 surface ok"

echo "--- slice 6a: tools + agent loop"
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
PROJ=$TMP/proj; mkdir -p $PROJ
export YGG_PROJECT_DIR=$PROJ YGG_MAX_STEPS=4
start_srv
curl -sfN http://$YGG/event >$TMP/events6.txt & EV=$!
sleep 0.3
# post6 SID TEXT [outfile] — SSE post with a JSON-escaped text part
post6() { curl -sN -X POST http://$YGG/session/$1/message "${J[@]}" -H 'accept: text/event-stream' \
  -d "$(python3 -c 'import sys,json;print(json.dumps({"parts":[{"type":"text","text":sys.argv[1]}]}))' "$2")"; }
S6=$(curl -sf -X POST http://$YGG/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

echo "- bash round-trip"
post6 $S6 'tool:[[["bash",{"command":"echo hi-from-bash > marker.txt; echo out-$((6*7)); echo oops >&2; pwd"}]]]' >$TMP/t1.txt
[ "$(cat $PROJ/marker.txt)" = hi-from-bash ] || { echo "FAIL: bash did not run in project dir"; cat $TMP/t1.txt; exit 1; }
python3 - "$TMP/t1.txt" "$(curl -sf http://$YGG/session/$S6/message)" "$PROJ" <<'PY6'
import sys, json
sse, msgs, proj = open(sys.argv[1]).read(), json.loads(sys.argv[2]), sys.argv[3]
evs = [(b.split("\n")[0][7:], json.loads(b.split("\n", 1)[1][5:])) for b in sse.strip().split("\n\n") if b.startswith("event:")]
kinds = [k for k, _ in evs]
tool_evs = [e["part"]["state"]["status"] for k, e in evs if k == "message.part.updated"]
assert tool_evs == ["running", "completed"], tool_evs
text = "".join(e["text"] for k, e in evs if k == "message.part.delta")
assert "TOOL-FINAL: out-42" in text and "[tools declared: 8]" in text, text
assert kinds[-1] == "message.completed", kinds
a = msgs[-1]
assert a["info"]["role"] == "assistant" and a["info"]["time"]["completed"] and "error" not in a["info"], a["info"]
types = [p["type"] for p in a["parts"]]
assert types == ["text", "tool", "text"], types
t = a["parts"][1]
assert t["tool"] == "bash" and t["callID"] == "call_0_0" and t["state"]["status"] == "completed", t
assert t["state"]["input"]["command"].startswith("echo hi-from-bash"), t
out = t["state"]["output"]
assert "out-42" in out and "oops" in out and proj in out and t["state"]["metadata"]["exit"] == 0, out
assert a["parts"][2]["text"].startswith("TOOL-FINAL: out-42"), a["parts"][2]
print("bash ran, tool part stored:", repr(out))
PY6

echo "- write / edit / read (+ failing edit, two calls in one step)"
post6 $S6 'tool:[[["write",{"filePath":"sub/t.txt","content":"alpha\nbeta\nbeta2\n"}]],[["edit",{"filePath":"sub/t.txt","oldString":"beta\n","newString":"gamma\n"}],["edit",{"filePath":"sub/t.txt","oldString":"nope","newString":"x"}]],[["read",{"filePath":"'$PROJ'/sub/t.txt"}]]]' >$TMP/t2.txt
[ "$(cat $PROJ/sub/t.txt)" = "$(printf 'alpha\ngamma\nbeta2')" ] || { echo "FAIL: write/edit"; cat $PROJ/sub/t.txt; exit 1; }
python3 - "$(curl -sf http://$YGG/session/$S6/message)" <<'PY6'
import sys, json
a = json.loads(sys.argv[1])[-1]
tools = [(p["tool"], p["state"]["status"]) for p in a["parts"] if p["type"] == "tool"]
assert tools == [("write", "completed"), ("edit", "completed"), ("edit", "error"), ("read", "completed")], tools
bad = [p for p in a["parts"] if p["type"] == "tool"][2]["state"]
assert "not found" in bad["error"], bad
final = a["parts"][-1]["text"]
assert "     2\tgamma" in final, final
# history replay: previous turn's 1 tool result + this turn's 4
assert "[tool msgs in history: 5]" in final, final
print("write/edit/read ok; failing edit fed back as error, loop continued")
PY6

echo "- glob / grep / todowrite / webfetch / bash truncation + timeout"
post6 $S6 'tool:[[["glob",{"pattern":"**/*.txt"}],["grep",{"pattern":"gam+a","include":"*.txt"}],["todowrite",{"todos":[{"content":"ship 6a","status":"in_progress","priority":"high"},{"content":"6b roll-up","status":"pending"}]}],["bash",{"command":"seq 1 100000"}],["webfetch",{"url":"http://'$YGG'/session/'$S6'/todo"}],["bash",{"command":"sleep 5; echo late","timeout":300}]]]' >$TMP/t3.txt
python3 - "$(curl -sf http://$YGG/session/$S6/message)" "$(curl -sf http://$YGG/session/$S6/todo)" "$PROJ" <<'PY6'
import sys, json
a, todo, proj = json.loads(sys.argv[1])[-1], json.loads(sys.argv[2]), sys.argv[3]
parts = [p["state"] for p in a["parts"] if p["type"] == "tool"]
timed_out = parts.pop()
assert timed_out["status"] == "error" and "timed out after 300 ms" in timed_out["error"], timed_out
t = {p["tool"]: p["state"] for p in a["parts"] if p["type"] == "tool" and p["state"] is not timed_out and p["state"]["status"] == "completed"}
assert len(t) == 5 and len(parts) == 5, list(t)
assert "ship 6a" in t["webfetch"]["output"] and t["webfetch"]["metadata"]["status"] == 200, t["webfetch"]
assert f"{proj}/sub/t.txt" in t["glob"]["output"] and f"{proj}/marker.txt" in t["glob"]["output"], t["glob"]
assert "t.txt:2:gamma" in t["grep"]["output"], t["grep"]
assert [x["content"] for x in todo] == ["ship 6a", "6b roll-up"] and todo[0]["status"] == "in_progress", todo
b = t["bash"]
assert b["metadata"]["truncated"] and len(b["output"]) < 31000 and "truncated" in b["output"], len(b["output"])
assert b["output"].startswith("1\n2\n") and b["output"].rstrip().endswith("100000"), b["output"][-40:]
print("glob/grep/todo/webfetch ok, bash timeout -> error; 588KB bash output stored as", len(b["output"]), "chars (head+tail)")
PY6
python3 -c 'import sys;sys.exit(0 if open(sys.argv[1]).read().count("todo.updated") else 1)' $TMP/events6.txt \
  || { echo "FAIL: no todo.updated on bus"; exit 1; }

echo "- loop safety: model that never stops calling tools"
S7=$(curl -sf -X POST http://$YGG/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
timeout 20 bash -c "$(declare -f post6); J=(-H 'content-type: application/json'); YGG=$YGG post6 $S7 'tool:forever'" >$TMP/t4.txt \
  || { echo "FAIL: forever loop hung"; exit 1; }
grep -q '^event: error' $TMP/t4.txt || { echo "FAIL: no error event at cap"; tail -5 $TMP/t4.txt; exit 1; }
grep -q 'step cap (4' $TMP/t4.txt || { echo "FAIL: error does not name the cap"; exit 1; }
grep -q '^event: message.completed' $TMP/t4.txt && { echo "FAIL: completed despite cap"; exit 1; }
[ "$(wc -l <$PROJ/loop.txt)" = 4 ] || { echo "FAIL: expected 4 tool runs, got $(wc -l <$PROJ/loop.txt)"; exit 1; }
[ "$(curl -sf http://$YGG/session/status)" = "{}" ] || { echo "FAIL: session still busy after cap"; exit 1; }
curl -sf http://$YGG/session/$S7/message | python3 -c '
import sys,json; a=json.load(sys.stdin)[-1]
assert "step cap" in a["info"]["error"]["data"]["message"] and a["info"]["time"]["completed"], a["info"]
assert sum(p["type"]=="tool" for p in a["parts"]) == 4, a["parts"]'
echo "capped at 4 steps with an error event, session idle"

echo "- abort mid-tool kills the command"
# Process hygiene: identify the tool's process group by the pid it writes itself — never by
# pattern (a pgrep -f pattern also matches the shell running the check and can kill it).
post6 $S7 'tool:[[["bash",{"command":"echo $$ > tool.pid; sleep 31.5; echo never > never.txt"}]]]' >$TMP/t5.txt & SLOW=$!
for _ in $(seq 30); do [ -s $PROJ/tool.pid ] && break; sleep 0.1; done
TPID=$(cat $PROJ/tool.pid 2>/dev/null) || { echo "FAIL: tool command not running"; exit 1; }
[ "$TPID" != $$ ] && [ "$(ps -o pgid= -p $$ | tr -d ' ')" != "$TPID" ] || { echo "FAIL: tool shares our process group"; exit 1; }
pgrep -g "$TPID" >/dev/null || { echo "FAIL: tool process group $TPID not running"; exit 1; }
T0=$(date +%s.%N)
[ "$(curl -sf -X POST http://$YGG/session/$S7/abort)" = true ] || { echo "FAIL: abort mid-tool"; exit 1; }
wait $SLOW
python3 -c "import sys;sys.exit(0 if $(date +%s.%N)-$T0 < 1.0 else 1)" || { echo "FAIL: abort not prompt"; exit 1; }
sleep 0.3
pgrep -g "$TPID" >/dev/null && { echo "FAIL: tool process group $TPID survived abort"; exit 1; }
grep -q '^event: message.aborted' $TMP/t5.txt || { echo "FAIL: no message.aborted"; exit 1; }
curl -sf http://$YGG/session/$S7/message | python3 -c '
import sys,json; a=json.load(sys.stdin)[-1]
assert a["info"]["error"]["name"] == "MessageAbortedError", a["info"]
t=[p for p in a["parts"] if p["type"]=="tool"][-1]["state"]
assert t["status"] == "error" and t["error"] == "aborted", t'
[ -e $PROJ/never.txt ] && { echo "FAIL: aborted command completed"; exit 1; }
echo "abort killed the bash process group, tool part marked aborted"

echo "- tool trace on the global bus + survives restart"
sleep 0.3; kill $EV; EV=
python3 - "$TMP/events6.txt" <<'PY6'
import sys, json
evs = [json.loads(l[5:]) for l in open(sys.argv[1]).read().splitlines() if l.startswith("data:")]
st = [(e["properties"]["part"]["tool"], e["properties"]["part"]["state"]["status"]) for e in evs if e["type"] == "message.part.updated"]
assert ("bash", "running") in st and ("bash", "completed") in st and ("edit", "error") in st, st
print(len(st), "message.part.updated events on /event")
PY6
BEFORE=$(curl -sf http://$YGG/session/$S6/message)
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
start_srv
[ "$BEFORE" = "$(curl -sf http://$YGG/session/$S6/message)" ] || { echo "FAIL: tool trace lost on restart"; exit 1; }
curl -sf http://$YGG/session/$S6/todo | grep -q 'ship 6a' || { echo "FAIL: todo lost on restart"; exit 1; }
echo "slice-6a tools ok"
echo "--- slice 6b: context roll-up (forced threshold)"
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
export YGG_ROLLUP_TOKENS=300 YGG_ROLLUP_KEEP_TOKENS=60 YGG_MAX_STEPS=10
start_srv
calls() { curl -sf http://127.0.0.1:$MOCK_PORT/calls; }
S8=$(curl -sf -X POST http://$YGG/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
LOREM=$(printf 'lorem %.0s' $(seq 40))
ROLLED=0
for k in $(seq 1 12); do
  C0=$(calls)
  post6 $S8 "marathon turn $k: $LOREM" >$TMP/m$k.txt
  grep -q '^event: message.completed' $TMP/m$k.txt || { echo "FAIL: turn $k incomplete"; tail -3 $TMP/m$k.txt; exit 1; }
  if grep -q '^event: session.compacted' $TMP/m$k.txt; then
    ROLLED=$((ROLLED+1))
    python3 - "$TMP/m$k.txt" "$C0" "$(calls)" "$(curl -sf http://$YGG/session/$S8/message)" $k $ROLLED <<'PY6B'
import sys, json
sse, c0, c1, msgs, k, n = open(sys.argv[1]).read(), json.loads(sys.argv[2]), json.loads(sys.argv[3]), json.loads(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
evs = [(b.split("\n")[0][7:], json.loads(b.split("\n", 1)[1][5:])) for b in sse.strip().split("\n\n") if b.startswith("event:")]
comp = [e for kind, e in evs if kind == "session.compacted"][0]
assert comp["tokensAfter"] < comp["tokensBefore"], comp
# exactly one extra upstream call, tool-less
assert c1["summary"] - c0["summary"] == 1 and c1["chat"] - c0["chat"] == 1 and c1["summary_with_tools"] == 0, (c0, c1)
text = "".join(e["text"] for kind, e in evs if kind == "message.part.delta")
assert f"you said 'marathon turn {k}:" in text and text.endswith("(3 msgs)"), text[-60:]
# stored: ..., compaction user, summary assistant, current user, reply
ask, summ, cur = msgs[-4], msgs[-3], msgs[-2]
assert ask["info"]["role"] == "user" and ask["parts"][0]["type"] == "compaction" and ask["parts"][0]["auto"] is True, ask
assert summ["info"]["role"] == "assistant" and summ["info"]["summary"] is True and summ["info"]["id"] == comp["messageID"], summ["info"]
st = summ["parts"][0]["text"]
first = "USER: marathon turn 1:" if n == 1 else "USER: What did we do so far?"
assert st.startswith("MOCK-SUMMARY: " + first), st[:80]
assert cur["parts"][0]["text"].startswith(f"marathon turn {k}:"), cur
assert len(msgs) == 2 * k + 2 * n, (len(msgs), k, n)
print(f"turn {k}: roll-up #{n} — 1 extra call, ~{comp['tokensBefore']} -> ~{comp['tokensAfter']} tokens, summary visible: {st[:60]!r}")
PY6B
  else
    [ "$(calls | python3 -c 'import sys,json;print(json.load(sys.stdin)["summary"])')" = "$(python3 -c 'import sys,json;print(json.loads(sys.argv[1])["summary"])' "$C0")" ] \
      || { echo "FAIL: summary call without session.compacted"; exit 1; }
  fi
  [ $ROLLED = 2 ] && break
done
[ $ROLLED = 2 ] || { echo "FAIL: expected two roll-ups (got $ROLLED)"; exit 1; }
# the turn after a roll-up continues from the summary (no new call), and survives a restart
BEFORE=$(curl -sf http://$YGG/session/$S8/message)
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
start_srv
[ "$BEFORE" = "$(curl -sf http://$YGG/session/$S8/message)" ] || { echo "FAIL: roll-up lost on restart"; exit 1; }
C0=$(calls); post6 $S8 "after restart: short" >$TMP/m-after.txt
grep -q "you said 'after restart: short' (5 msgs)" $TMP/m-after.txt || { echo "FAIL: post-roll-up turn should send 5 msgs"; grep -o '([0-9]* msgs)' $TMP/m-after.txt; exit 1; }
[ "$(calls)" = "$(python3 -c 'import sys,json;d=json.loads(sys.argv[1]);d["chat"]+=1;print(json.dumps(d))' "$C0")" ] || { echo "FAIL: unexpected extra call"; calls; exit 1; }
echo "post-roll-up turn: 5 msgs upstream (summary + tail), survived restart"

echo "- in-run prune: big tool outputs within one run"
S9=$(curl -sf -X POST http://$YGG/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
C0=$(calls)
post6 $S9 'tool:[[["bash",{"command":"seq 1 3000"}]],[["bash",{"command":"seq 1 3001"}]],[["bash",{"command":"seq 1 3002"}]]]' >$TMP/p1.txt
python3 - "$TMP/p1.txt" "$(curl -sf http://$YGG/session/$S9/message)" "$C0" "$(calls)" <<'PY6B'
import sys, json
sse, msgs, c0, c1 = open(sys.argv[1]).read(), json.loads(sys.argv[2]), json.loads(sys.argv[3]), json.loads(sys.argv[4])
final = msgs[-1]["parts"][-1]["text"]
assert "[tool msgs in history: 3] [pruned: 2]" in final and final.rstrip().split("[tools")[0].rstrip().endswith("3002"), final[-120:]
outs = [p["state"]["output"] for p in msgs[-1]["parts"] if p["type"] == "tool"]
assert len(outs) == 3 and all(len(o) > 13000 for o in outs), [len(o) for o in outs]
assert c1["summary"] == c0["summary"], (c0, c1)
print("pruned 2 old tool outputs upstream (latest kept), stored outputs intact:", [len(o) for o in outs])
PY6B
unset YGG_ROLLUP_TOKENS YGG_ROLLUP_KEEP_TOKENS
echo "slice-6b roll-up ok"

echo "--- slice 7: anthropic upstream dialect"
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
cargo test -q >$TMP/unit.txt 2>&1 && grep -q 'test result: ok' $TMP/unit.txt || { echo "FAIL: unit tests"; cat $TMP/unit.txt; exit 1; }
echo "mapping unit tests: $(grep -o '[0-9]* passed' $TMP/unit.txt)"
export YGG_ROLLUP_TOKENS=300 YGG_ROLLUP_KEEP_TOKENS=60 YGG_MAX_STEPS=10 YGG_MAX_TOKENS=777
S7TOOL='tool:[[["bash",{"command":"echo s7-$((6*7)) > s7.txt; cat s7.txt"}]],[["write",{"filePath":"w.txt","content":"one\ntwo\n"}],["edit",{"filePath":"w.txt","oldString":"zzz","newString":"x"}]],[["read",{"filePath":"w.txt"}]]]'
# scenario7 DIALECT BASE — the same turns against a fresh store: chat, tool loop (3 steps, one
# with two calls + a failing edit), marathon turns until the roll-up crosses, one turn after it.
scenario7() {
  local d=$TMP/s7-${1:0:3} k   # equal-length dirs: tool outputs carry the path
  mkdir -p $d/proj
  export YGG_DATA_DIR=$d/data YGG_PROJECT_DIR=$d/proj
  STYLE=$1 BASE=$2 start_srv
  calls >$d/c0
  S=$(curl -sf -X POST http://$YGG/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  post6 $S "hello s7" >$d/sse-1.txt
  post6 $S "$S7TOOL" >$d/sse-2.txt
  for k in 3 4 5 6 7 8; do
    post6 $S "marathon $k: $LOREM" >$d/sse-$k.txt
    grep -q '^event: session.compacted' $d/sse-$k.txt && break
  done
  post6 $S "after roll-up" >$d/sse-9.txt
  curl -sf http://$YGG/session/$S/message >$d/transcript.json
  calls >$d/c1
}
scenario7 openai http://127.0.0.1:$MOCK_PORT/v1
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
scenario7 anthropic http://127.0.0.1:$MOCK_PORT
python3 - "$TMP" <<'PY7'
import sys, json, re, glob, os, difflib
tmp = sys.argv[1]
# tokensBefore (session.compacted) is an estimate over the stored history, which holds upstream-minted
# call ids — the mock's short call_0_0 vs the re-keyed call_<32 hex> — so only its direction is compared.
TS = {"created", "updated", "completed", "start", "end", "tokensBefore"}
def norm(text, d):
    text = text.replace(f"{d}/proj", "<PROJ>")
    ids = {}
    def rep(m):
        fam = "call" if m.group(1) in ("call", "toolu") else m.group(1)
        if m.group(0) not in ids:
            ids[m.group(0)] = f"{fam}#{sum(v.startswith(fam + '#') for v in ids.values()) + 1}"
        return ids[m.group(0)]
    text = re.sub(r"\b(ses|msg|prt|call|toolu)_[A-Za-z0-9_]+", rep, text)
    def walk(v):
        if isinstance(v, dict):
            return {k: (0 if k in TS and isinstance(x, int) else walk(x)) for k, x in v.items()}
        return [walk(x) for x in v] if isinstance(v, list) else v
    return walk(json.loads(text))
def sse(path, d):
    blocks = [b for b in open(path).read().strip().split("\n\n") if b.startswith("event:")]
    return [(b.split("\n")[0][7:], norm(b.split("\n", 1)[1][5:], d)) for b in blocks]
def same(a, b, what):
    if a != b:
        da, db = (json.dumps(x, indent=1, sort_keys=True).splitlines() for x in (a, b))
        print("\n".join(list(difflib.unified_diff(da, db, "openai", "anthropic", lineterm=""))[:60]))
        sys.exit(f"FAIL: {what} differs between dialects")
dirs = {s: f"{tmp}/s7-{s[:3]}" for s in ("openai", "anthropic")}
raw = {s: open(f"{d}/transcript.json").read() for s, d in dirs.items()}
tr = {s: norm(raw[s], d) for s, d in dirs.items()}
same(tr["openai"], tr["anthropic"], "stored transcript")
files = sorted(os.path.basename(f) for f in glob.glob(f"{dirs['openai']}/sse-*.txt"))
for d in dirs.values():
    comps = [json.loads(b.split("\n", 1)[1][5:]) for f in files for b in open(f"{d}/{f}").read().split("\n\n")
             if b.startswith("event: session.compacted")]
    assert len(comps) == 1 and comps[0]["tokensAfter"] < comps[0]["tokensBefore"], comps
assert files == sorted(os.path.basename(f) for f in glob.glob(f"{dirs['anthropic']}/sse-*.txt")), files
for f in files:
    same(sse(f"{dirs['openai']}/{f}", dirs["openai"]), sse(f"{dirs['anthropic']}/{f}", dirs["anthropic"]), f"client SSE {f}")
# dialect-blind: no upstream (toolu_) ids anywhere, callIDs re-keyed to yggdrasil ids
blob = raw["anthropic"] + "".join(open(f"{dirs['anthropic']}/{f}").read() for f in files)
assert "toolu_" not in blob, "anthropic tool_use id leaked into the transcript/stream"
a = json.loads(raw["anthropic"])
ids = [p["callID"] for m in a for p in m["parts"] if p["type"] == "tool"]
assert len(ids) == 4 and all(re.fullmatch(r"call_[0-9a-f]{32}", i) for i in ids), ids
# what the shared transcript holds
tools = [(p["tool"], p["state"]["status"]) for m in a for p in m["parts"] if p["type"] == "tool"]
assert tools == [("bash", "completed"), ("write", "completed"), ("edit", "error"), ("read", "completed")], tools
bash = next(p for m in a for p in m["parts"] if p["type"] == "tool")["state"]
assert bash["output"].strip() == "s7-42" and bash["metadata"]["exit"] == 0, bash
final = a[3]["parts"][-1]["text"]
assert final.startswith("TOOL-FINAL:") and "[tools declared: 8] [tool msgs in history: 4]" in final, final
comp = [i for i, m in enumerate(a) if any(p["type"] == "compaction" for p in m["parts"])]
assert len(comp) == 1, comp
summ = a[comp[0] + 1]
assert summ["info"]["summary"] is True and summ["parts"][0]["text"].startswith("MOCK-SUMMARY: USER: hello s7"), summ
assert "you said 'after roll-up' (5 msgs)" in a[-1]["parts"][-1]["text"], a[-1]["parts"]
# each dialect hit only its own endpoint, same number of calls, one tool-less summary call, nothing rejected
c = {s: [json.load(open(f"{d}/c{i}")) for i in (0, 1)] for s, d in dirs.items()}
dl = {s: {k: c[s][1][k] - c[s][0][k] for k in c[s][0] if k != "a_max_tokens"} for s in c}
o, an = dl["openai"], dl["anthropic"]
assert o["summary"] == 1 and o["summary_with_tools"] == 0 and not any(v for k, v in o.items() if k.startswith("a_")), o
assert an["a_summary"] == 1 and an["a_summary_with_tools"] == 0 and an["a_rejected"] == 0, an
assert an["chat"] == an["summary"] == 0 and an["a_chat"] == o["chat"] > 0, (o, an)
assert c["anthropic"][1]["a_max_tokens"] == 777, c["anthropic"][1]
print(f"identical transcripts ({len(a)} msgs) + identical client SSE ({len(files)} turns) in both dialects; "
      f"{an['a_chat']} /v1/messages calls (validated: headers, alternation, tool_result pairing) + 1 roll-up; "
      f"tool_use ids re-keyed; YGG_MAX_TOKENS honoured")
PY7

echo "- anthropic abort mid-SSE drops the upstream connection"
SA=$(curl -sf -X POST http://$YGG/session | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
D0=$(calls | python3 -c 'import sys,json;print(json.load(sys.stdin)["disconnects"])')
post6 $SA "slow please" >$TMP/a-slow.txt & SLOW=$!
sleep 1.5
T0=$(date +%s.%N)
[ "$(curl -sf -X POST http://$YGG/session/$SA/abort)" = true ] || { echo "FAIL: anthropic abort did not report in-flight"; exit 1; }
wait $SLOW
python3 -c "import sys;sys.exit(0 if $(date +%s.%N)-$T0 < 1.0 else 1)" || { echo "FAIL: anthropic abort not prompt"; exit 1; }
grep -q '^event: message.aborted' $TMP/a-slow.txt || { echo "FAIL: no message.aborted"; exit 1; }
grep -q '^event: message.completed' $TMP/a-slow.txt && { echo "FAIL: completed after abort"; exit 1; }
grep -q 'SLOW-END' $TMP/a-slow.txt && { echo "FAIL: full reply streamed despite abort"; exit 1; }
for _ in $(seq 30); do [ "$(calls | python3 -c 'import sys,json;print(json.load(sys.stdin)["disconnects"])')" -gt "$D0" ] && break; sleep 0.1; done
[ "$(calls | python3 -c 'import sys,json;print(json.load(sys.stdin)["disconnects"])')" -gt "$D0" ] || { echo "FAIL: mock never saw the upstream connection drop"; exit 1; }
python3 - "$(curl -sf http://$YGG/session/$SA/message)" "$TMP/a-slow.txt" <<'PY7'
import sys, json
last = json.loads(sys.argv[1])[-1]
assert last["info"]["error"]["name"] == "MessageAbortedError", last["info"]
partial = last["parts"][0]["text"]
deltas = [json.loads(l[5:])["text"] for l in open(sys.argv[2]).read().splitlines()
          if l.startswith("data:") and '"text"' in l and '"info"' not in l]
assert partial.startswith("MOCK-REPLY: you said 'slow please'") and "".join(deltas) == partial, (deltas, partial)
print(f"aborted after {len(deltas)} deltas; upstream connection dropped (mock saw the disconnect); partial kept == streamed")
PY7
kill $SRV; wait $SRV 2>/dev/null || true; SRV=
unset YGG_ROLLUP_TOKENS YGG_ROLLUP_KEEP_TOKENS YGG_MAX_TOKENS

echo "- real-upstream hook self-test (against the mock: dry-run PASS, 429 balance + 401 -> FAIL-AUTH, no key -> FAIL-AUTH)"
RU="env -u YGG_DATA_DIR -u YGG_PROJECT_DIR -u YGG_MAX_STEPS YGG_UPSTREAM_BASE_URL=http://127.0.0.1:$MOCK_PORT YGG_UPSTREAM_MODEL=mock"
$RU YGG_UPSTREAM_API_KEY=mock-key ./verify-real-upstream.sh >$TMP/ru-ok.txt 2>&1 || { echo "FAIL: real-upstream dry run"; tail -20 $TMP/ru-ok.txt; exit 1; }
grep -q '^PASS-REAL' $TMP/ru-ok.txt || { echo "FAIL: dry run did not print PASS-REAL"; tail -5 $TMP/ru-ok.txt; exit 1; }
for key in mock-429 mock-401 ""; do
  RC=0; $RU YGG_UPSTREAM_API_KEY=$key ./verify-real-upstream.sh >$TMP/ru-auth.txt 2>&1 || RC=$?
  [ $RC = 3 ] && grep -q '^FAIL-AUTH' $TMP/ru-auth.txt || { echo "FAIL: key '$key' should give FAIL-AUTH/exit 3 (rc=$RC)"; tail -5 $TMP/ru-auth.txt; exit 1; }
  echo "key '${key:-<unset>}': $(grep '^FAIL-AUTH' $TMP/ru-auth.txt | cut -c1-110)"
done
echo "slice-7 anthropic dialect ok"
echo PASS
