#!/usr/bin/env bash
# Slice 7 real-upstream hook: the verify.sh round-trip (chat, tool loop, roll-up crossing, abort
# mid-SSE, transcript shape) through yggdrasil against a REAL provider.
#
# Env (the driver supplies the key; nothing is read from config files):
#   YGG_UPSTREAM_BASE_URL  e.g. https://api.z.ai/api/anthropic  (anthropic dialect: {base}/v1/messages)
#   YGG_UPSTREAM_API_KEY   provider key
#   YGG_UPSTREAM_STYLE     anthropic (default here) | openai
#   YGG_UPSTREAM_MODEL     default glm-5.3-flash
#   YGG_MAX_TOKENS         default 4096 here (keeps the bill small; the server default is 16384)
#   YGG_REAL_LISTEN        default 127.0.0.1:14199
# Exit: 0 PASS-REAL · 1 FAIL (yggdrasil / mapping) · 3 FAIL-AUTH (no key, 401/403, 429, balance/quota).
# Throwaway store + project dir (data/ is never touched); the only network peer is the provider.
# Model-dependent wording checks are WARN only; the hard checks are the protocol ones.
set -uo pipefail
cd "$(dirname "$0")"
fail() { echo "FAIL: $*"; exit 1; }
fail_auth() { echo "FAIL-AUTH: $*"; echo "(script ready: re-run with a working key in YGG_UPSTREAM_API_KEY)"; exit 3; }
[ -n "${YGG_UPSTREAM_BASE_URL:-}" ] || fail_auth "YGG_UPSTREAM_BASE_URL not set"
[ -n "${YGG_UPSTREAM_API_KEY:-}" ] || fail_auth "YGG_UPSTREAM_API_KEY not set (no key in the environment)"
export YGG_UPSTREAM_STYLE=${YGG_UPSTREAM_STYLE:-anthropic} YGG_UPSTREAM_MODEL=${YGG_UPSTREAM_MODEL:-glm-5.3-flash}
export YGG_MAX_TOKENS=${YGG_MAX_TOKENS:-4096} YGG_ROLLUP_TOKENS=100 YGG_ROLLUP_KEEP_TOKENS=20 YGG_MAX_STEPS=8
L=${YGG_REAL_LISTEN:-127.0.0.1:14199}
source ~/.cargo/env 2>/dev/null
cargo build -q || fail "cargo build"
TMP=$(mktemp -d); mkdir -p $TMP/proj
SRV=; BG=
trap 'kill $SRV $BG 2>/dev/null; rm -rf $TMP' EXIT
YGG_LISTEN=$L YGG_DATA_DIR=$TMP/data YGG_PROJECT_DIR=$TMP/proj ./target/debug/yggdrasil 2>$TMP/ygg.log & SRV=$!
for _ in $(seq 50); do curl -sf http://$L/session >/dev/null && break; sleep 0.1; done
curl -sf http://$L/session >/dev/null || fail "yggdrasil did not come up on $L: $(tail -3 $TMP/ygg.log)"
echo "upstream: $YGG_UPSTREAM_STYLE $YGG_UPSTREAM_BASE_URL model=$YGG_UPSTREAM_MODEL max_tokens=$YGG_MAX_TOKENS"

# Turn checker: an error event is classified (auth/balance → exit 3, else exit 1); a stream must
# end in message.completed (or message.aborted with ABORT=1). Prints the streamed text.
cat >$TMP/check.py <<'PY'
import sys, json, re, os
turn, path = sys.argv[1], sys.argv[2]
blocks = [b for b in open(path).read().strip().split("\n\n") if b.startswith("event:")]
evs = [(b.split("\n")[0][7:], json.loads(b.split("\n", 1)[1][5:])) for b in blocks]
errs = [str(e.get("error", "")) for k, e in evs if k == "error"]
if errs:
    m = re.search(r"upstream (\d{3})", errs[0])
    if (m and int(m.group(1)) in (401, 403, 429)) or re.search(
            r"balance|quota|insufficient|recharge|billing|credit|expired|api.?key|unauthori|forbidden|rate.?limit", errs[0], re.I):
        print(f"FAIL-AUTH: {turn}: {errs[0][:300]}"); sys.exit(3)
    print(f"FAIL: {turn}: {errs[0][:300]}"); sys.exit(1)
end = "message.aborted" if os.environ.get("ABORT") else "message.completed"
if not evs or evs[-1][0] != end:
    print(f"FAIL: {turn}: stream did not end in {end} (last events: {[k for k, _ in evs][-3:]})"); sys.exit(1)
print("".join(e["text"] for k, e in evs if k == "message.part.delta"))
PY
# Callers run it in $(...): failures go to stderr and come back as the return code.
check() {
  local out rc
  out=$(python3 $TMP/check.py "$1" "$2"); rc=$?
  if [ $rc != 0 ]; then
    echo "$out" >&2
    if [ $rc = 3 ]; then echo "(script ready: re-run with a working key in YGG_UPSTREAM_API_KEY)" >&2; else tail -3 $TMP/ygg.log >&2; fi
    return $rc
  fi
  printf '%s' "$out"
}
post() { curl -sN --max-time ${3:-300} -X POST http://$L/session/$1/message -H 'content-type: application/json' \
  -H 'accept: text/event-stream' -d "$(python3 -c 'import sys,json;print(json.dumps({"parts":[{"type":"text","text":sys.argv[1]}]}))' "$2")"; }
new_session() { curl -sf -X POST http://$L/session -H 'content-type: application/json' -d "{\"title\":\"$1\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'; }
WARN=0
warn() { echo "WARN: $*"; WARN=$((WARN+1)); }

S=$(new_session ygg-real-upstream) || fail "session create"
echo "- turn 1: chat"
post $S "Reply with exactly: pong" >$TMP/t1.txt
T1=$(check "turn 1" $TMP/t1.txt) || exit $?
echo "  reply: ${T1:0:120}"
grep -qi pong <<<"$T1" || warn "turn 1 reply has no 'pong'"

echo "- turn 2: tool loop"
post $S 'Use the bash tool to run `echo ygg-real-$((6*7))` and then tell me exactly what it printed.' >$TMP/t2.txt
T2=$(check "turn 2" $TMP/t2.txt) || exit $?
echo "  reply: ${T2:0:160}"
python3 - "$TMP/t2.txt" "$(curl -sf http://$L/session/$S/message)" <<'PY' || exit 1
import sys, json
sse, msgs = open(sys.argv[1]).read(), json.loads(sys.argv[2])
tools = [p for p in msgs[-1]["parts"] if p["type"] == "tool"]
if not tools:
    sys.exit("FAIL: turn 2: the model made no tool call (tool loop not exercised)")
ran = [p for p in tools if p["tool"] == "bash" and p["state"]["status"] == "completed" and "ygg-real-42" in p["state"]["output"]]
if not ran:
    sys.exit(f"FAIL: turn 2: no completed bash part printing ygg-real-42: {[(p['tool'], p['state']['status'], p['state'].get('output', '')[:80]) for p in tools]}")
if "message.part.updated" not in sse:
    sys.exit("FAIL: turn 2: no message.part.updated on the stream")
print(f"  {len(tools)} tool part(s); bash ran: {ran[0]['state']['input']} -> {ran[0]['state']['output'].strip()!r}")
PY
grep -q 'ygg-real-42' <<<"$T2" || warn "turn 2 final text does not repeat ygg-real-42"

echo "- turn 3: roll-up crossing (YGG_ROLLUP_TOKENS=$YGG_ROLLUP_TOKENS)"
post $S "In one short sentence: what did that command print?" >$TMP/t3.txt
T3=$(check "turn 3" $TMP/t3.txt) || exit $?
echo "  reply: ${T3:0:160}"
grep -q '42' <<<"$T3" || warn "turn 3 (after the roll-up) does not recall 42 — summary quality, not protocol"
python3 - "$(curl -sf http://$L/session/$S/message)" "$TMP/t2.txt" "$TMP/t3.txt" <<'PY' || exit 1
import sys, json
msgs = json.loads(sys.argv[1])
compacted = sum(open(f).read().count("event: session.compacted") for f in sys.argv[2:])
comp = [i for i, m in enumerate(msgs) if any(p["type"] == "compaction" for p in m["parts"])]
if not compacted or not comp:
    sys.exit(f"FAIL: no roll-up crossed (session.compacted events: {compacted}, compaction parts: {len(comp)})")
summ = msgs[comp[-1] + 1]
text = summ["parts"][0]["text"] if summ["parts"] else ""
if not (summ["info"].get("summary") is True and text.strip()):
    sys.exit(f"FAIL: roll-up summary missing or empty: {summ['info']}")
print(f"  roll-up stored: summary {len(text)} chars: {text[:100]!r}")
PY

echo "- abort mid-SSE"
SA=$(new_session ygg-real-abort) || fail "session create"
post $SA "Count from 1 to 300, one number per line, no other text." >$TMP/t4.txt & BG=$!
for _ in $(seq 900); do grep -qE '^event: (message.part.delta|error)' $TMP/t4.txt && break; sleep 0.1; done
if grep -q '^event: error' $TMP/t4.txt; then wait $BG; BG=; check "abort turn" $TMP/t4.txt >/dev/null || exit $?; fi
grep -q '^event: message.part.delta' $TMP/t4.txt || fail "abort turn: no delta within 90s"
T0=$(date +%s.%N)
[ "$(curl -sf -X POST http://$L/session/$SA/abort)" = true ] || fail "abort: run was not in flight (model finished first?)"
wait $BG; BG=
python3 -c "import sys;sys.exit(0 if $(date +%s.%N)-$T0 < 2.0 else 1)" || fail "abort: stream did not close within 2s"
ABORT=1 check "abort turn" $TMP/t4.txt >/dev/null || exit $?
python3 - "$(curl -sf http://$L/session/$SA/message)" "$TMP/t4.txt" <<'PY' || exit 1
import sys, json
last = json.loads(sys.argv[1])[-1]
if last["info"].get("error", {}).get("name") != "MessageAbortedError":
    sys.exit(f"FAIL: aborted message not flagged: {last['info']}")
deltas = [json.loads(l[5:])["text"] for l in open(sys.argv[2]).read().splitlines()
          if l.startswith("data:") and '"text"' in l and '"info"' not in l]
stored = "".join(p.get("text", "") for p in last["parts"] if p["type"] == "text")
if "".join(deltas) != stored:
    sys.exit(f"FAIL: stored partial != streamed deltas ({len(stored)} vs {len(''.join(deltas))} chars)")
print(f"  aborted after {len(deltas)} deltas; partial kept == streamed ({len(stored)} chars)")
PY

echo "- transcript shape (opencode-shaped, dialect-blind)"
python3 - "$(curl -sf http://$L/session/$S/message)" "$YGG_UPSTREAM_STYLE" <<'PY' || exit 1
import sys, json, re
msgs, style = json.loads(sys.argv[1]), sys.argv[2]
raw = sys.argv[1]
for m in msgs:
    i = m["info"]
    assert {"id", "sessionID", "role", "time"} <= set(i) and isinstance(i["time"]["created"], int), i
    if i["role"] == "assistant":
        assert isinstance(i["time"].get("completed"), int), i
    for p in m["parts"]:
        assert {"id", "messageID", "sessionID", "type"} <= set(p) and p["messageID"] == i["id"], p
        if p["type"] == "tool":
            s = p["state"]
            assert {"callID", "tool"} <= set(p) and {"status", "input", "output", "title", "metadata", "time"} <= set(s), p
            assert {"start", "end"} <= set(s["time"]), s
            if style == "anthropic":
                assert re.fullmatch(r"call_[0-9a-f]{32}", p["callID"]), p["callID"]
assert "toolu_" not in raw, "upstream tool_use id leaked into the transcript"
print(f"  {len(msgs)} messages, parts {sorted({p['type'] for m in msgs for p in m['parts']})}")
PY
echo "PASS-REAL ($YGG_UPSTREAM_STYLE, $YGG_UPSTREAM_MODEL): chat, tool loop, roll-up crossing, abort mid-SSE, transcript shape — $WARN warning(s)"
