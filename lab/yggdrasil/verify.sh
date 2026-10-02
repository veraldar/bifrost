#!/usr/bin/env bash
# Smoke test: mock upstream + yggdrasil + curls.
# Slice 1: session create, message post (SSE), history, 404.
# Slice 2: abort mid-stream, global GET /event, persistence across a restart.
set -euo pipefail
cd "$(dirname "$0")"
source ~/.cargo/env
cargo build -q
MOCK_PORT=18080; YGG=127.0.0.1:14096
TMP=$(mktemp -d); export YGG_DATA_DIR=$TMP/data
python3 mock/mock_upstream.py $MOCK_PORT & MOCK=$!
start_srv() {
  YGG_UPSTREAM_BASE_URL=http://127.0.0.1:$MOCK_PORT/v1 YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock \
    YGG_LISTEN=$YGG ./target/debug/yggdrasil & SRV=$!
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
  OUT=$(curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' \
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
curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' \
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
OUT=$(curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' \
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
OUT=$(curl -sfN -X POST http://$YGG/session/$SID/message -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"reborn"}]}')
grep -q "MOCK-REPLY: you said 'reborn' (9 msgs)" <<<"$OUT" || { echo "FAIL: post-restart turn"; echo "$OUT"; exit 1; }
echo "history ($(python3 -c 'import sys,json;print(len(json.loads(sys.argv[1])))' "$AFTER") msgs) survived restart"
echo PASS
