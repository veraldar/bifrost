#!/usr/bin/env bash
# PROVIDER-WAVE e2e (10-28): the root's provider system + error visibility, against the mock.
# Scratch only: mock :4141, root :4142, a throwaway store + providers file (never :4100's).
#  1 the live shape — anthropic env provider answering z.ai's 429 code 1310: the turn is an error
#    TURN (200, APIError kind=quota code=1310 resetsAt = the mock's reset, a synthetic headline
#    "provider limit exhausted, resets …"), session.error + blocked{kind,resetsAt} on the bus,
#    /provider/health = exhausted; the SSE client (voice agent) gets the headline as a delta
#    BEFORE its error event; stacked turns each get their own error turn and cost no upstream call
#  2 fallback added live by the CLI (`provider add` + `provider fallback`, hot reload, no restart):
#    the next turn degrades to it (info.fallback from→to, provider.fallback event), the cooling
#    primary is skipped without a request, the synthetic headlines never reach the upstream
#  3 switch: the session model routes the run; `provider use` moves the default (GET /config)
#  4 auth + down: 401 → ProviderAuthError naming the key's source, a dead fallback → network,
#    both in one error turn; POST /provider/check + CLI `check`/`list`; no key ever printed
#  5 a broken providers file keeps the last good registry, reported as reloadError
set -euo pipefail
cd "$(dirname "$0")"
source ~/.cargo/env 2>/dev/null || true
[ -n "${YGG_BIN:-}" ] || cargo build -q
BIN=$(realpath "${YGG_BIN:-./target/debug/yggdrasil}")
MOCK_PORT=4141; YGG=127.0.0.1:4142; M=http://127.0.0.1:$MOCK_PORT
for p in $MOCK_PORT 4142; do
  ss -ltn "sport = :$p" | grep -q LISTEN && { echo "FAIL: port $p is held — another run?"; exit 1; }
done
TMP=$(mktemp -d); PF=$TMP/providers.json
python3 mock/mock_upstream.py $MOCK_PORT 2>$TMP/mock.log & MOCK=$!
SRV=; EV=
trap 'kill $MOCK $SRV $EV 2>/dev/null; rm -rf $TMP' EXIT
for _ in $(seq 50); do curl -sf $M/calls >/dev/null && break; sleep 0.1; done
N=0
pass() { N=$((N + 1)); echo "PASS $N: $*"; }
fail() { echo "FAIL: $*"; echo "--- root log"; tail -30 $TMP/root.log; exit 1; }

# start_root KEY STYLE BASE — the env provider = the pre-wave single upstream; the file = $PF
start_root() {
  [ -n "$SRV" ] && { kill $SRV $EV 2>/dev/null; wait $SRV $EV 2>/dev/null || true; }
  rm -rf $TMP/data $TMP/proj; mkdir -p $TMP/data $TMP/proj
  # the unit's EnvironmentFile twin: the CLI reads it the way a user points it at the root's env
  printf 'YGG_UPSTREAM_BASE_URL=%s\nYGG_UPSTREAM_STYLE=%s\nYGG_UPSTREAM_API_KEY=%s\nYGG_UPSTREAM_MODEL=mock\nYGG_UPSTREAM_RESET_TZ=+08:00\nBACKUP_KEY=good-key\n' \
    "$3" "$2" "$1" >$TMP/unit.env
  env -i HOME=$HOME PATH=$PATH \
    YGG_UPSTREAM_BASE_URL=$3 YGG_UPSTREAM_STYLE=$2 YGG_UPSTREAM_API_KEY=$1 YGG_UPSTREAM_MODEL=mock \
    YGG_UPSTREAM_RESET_TZ=+08:00 BACKUP_KEY=good-key YGG_PROVIDERS=$PF YGG_LISTEN=$YGG YGG_DATA_DIR=$TMP/data \
    YGG_PROJECT_DIR=$TMP/proj YGG_CONTEXT_FILES=$TMP/none.md \
    "$BIN" 2>>$TMP/root.log & SRV=$!
  for _ in $(seq 50); do curl -sf http://$YGG/session >/dev/null && break; sleep 0.1; done
  curl -sf http://$YGG/session >/dev/null || fail "root did not come up"
  : >$TMP/events.txt
  curl -sfN http://$YGG/event >$TMP/events.txt & EV=$!
  sleep 0.3
}
new_sid() { curl -sf -X POST http://$YGG/session -H 'content-type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'; }
post() { curl -s -o "$3" -w '%{http_code}' -X POST http://$YGG/session/$1/message -H 'content-type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$2\"}]}"; }
keycalls() { curl -sf $M/keys | python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',0))"; }
cli() { env -i HOME=$HOME PATH=$PATH "$BIN" provider "$@" --file $PF --env $TMP/unit.env; }

# ---------------------------------------------------------------------------------------- 1
rm -f $PF
start_root mock-1310 anthropic $M
curl -sf http://$YGG/config/providers | python3 -c '
import sys,json; d=json.load(sys.stdin)
assert d["default"] == {"yggdrasil": "mock"}, d
assert [p["id"] for p in d["providers"]] == ["yggdrasil"], d'
[ "$(curl -sf http://$YGG/config | python3 -c 'import sys,json;print(json.load(sys.stdin)["model"])')" = yggdrasil/mock ] || fail "GET /config model"
pass "env-only boot = the old single upstream (catalog default {yggdrasil: mock}, GET /config model)"

S1=$(new_sid)
T0=$(date +%s)
code=$(post $S1 "where are we at" $TMP/r1.json)
[ "$code" = 200 ] || fail "quota turn answered HTTP $code (want 200 + the error turn)"
python3 - $TMP/r1.json $T0 <<'PY' || fail "error turn shape"
import sys, json
m = json.load(open(sys.argv[1])); t0 = int(sys.argv[2])
i = m["info"]; e = i["error"]; d = e["data"]
assert e["name"] == "APIError", e
assert (d["kind"], d["code"], d["statusCode"], d["providerID"]) == ("quota", "1310", 429, "yggdrasil"), d
assert abs(d["resetsAt"] / 1000 - (t0 + 3600)) < 30, (d["resetsAt"], t0)
assert d["message"].startswith("provider limit exhausted, resets "), d["message"]
assert "Weekly/Monthly Limit Exhausted" in d["message"], d["message"]
syn = [p for p in m["parts"] if p["type"] == "text" and p.get("synthetic")]
assert len(syn) == 1 and syn[0]["text"].startswith("⚠ provider limit exhausted, resets "), m["parts"]
assert "No fallback provider is set" in syn[0]["text"], syn[0]["text"]
assert i["time"]["completed"] and i["providerID"] == "yggdrasil", i
print("  " + syn[0]["text"].splitlines()[0])
PY
pass "1310 → an error TURN: 200, APIError quota/1310, resetsAt = the provider's reset (UTC+8 parsed), synthetic headline"

sleep 0.3
python3 - $TMP/events.txt $S1 <<'PY' || fail "bus events for the quota stop"
import sys, json
evs = [json.loads(l[5:]) for l in open(sys.argv[1]) if l.startswith("data:")]
sid = sys.argv[2]
se = [e for e in evs if e["type"] == "session.error" and e["properties"]["sessionID"] == sid]
assert se and se[0]["properties"]["error"]["data"]["resetsAt"], se
bl = [e for e in evs if e["type"] == "session.state" and e["properties"]["state"]["type"] == "blocked"]
st = bl[-1]["properties"]["state"]
assert st["kind"] == "quota" and st["resetsAt"] and st["headline"].startswith("provider limit exhausted"), st
ps = [e for e in evs if e["type"] == "provider.status"]
assert ps and ps[-1]["properties"]["health"]["status"] == "exhausted", ps
PY
curl -sf http://$YGG/provider/health | python3 -c '
import sys,json; h=json.load(sys.stdin)
assert h["default"]["status"] == "exhausted" and h["default"]["resetsAt"] and h["default"]["until"], h
assert h["default"]["headline"].startswith("provider limit exhausted, resets"), h'
curl -sf http://$YGG/session/state | python3 -c "
import sys,json; s=json.load(sys.stdin)['$S1']
assert s['type']=='blocked' and s['kind']=='quota' and s['resetsAt'], s"
pass "session.error + session.state blocked{kind:quota,resetsAt,headline} + provider.status exhausted; /provider/health + /session/state agree"

# the voice agent's path: SSE — the headline arrives as a delta before the error event
curl -sN -X POST http://$YGG/session/$S1/message -H 'content-type: application/json' -H 'Accept: text/event-stream' \
  -d '{"parts":[{"type":"text","text":"say something"}]}' >$TMP/sse.txt
python3 - $TMP/sse.txt <<'PY' || fail "SSE error turn"
import sys
blocks = [b for b in open(sys.argv[1]).read().split("\n\n") if b.startswith("event:")]
kinds = [b.split("\n")[0][7:] for b in blocks]
assert "error" in kinds, kinds
d = kinds.index("message.part.delta")
assert d < kinds.index("error"), kinds
assert "provider limit exhausted" in blocks[d], blocks[d]
PY
pass "SSE client (voice agent): the headline streams as a delta BEFORE the error event"

# stacked turns: each gets its own error turn; the cooling primary costs no request
before=$(keycalls mock-1310)
post $S1 "queued one" $TMP/q1.json >$TMP/q1.code & Q1=$!
post $S1 "queued two" $TMP/q2.json >$TMP/q2.code & Q2=$!
wait $Q1 $Q2
[ "$(cat $TMP/q1.code)$(cat $TMP/q2.code)" = 200200 ] || fail "stacked turns HTTP $(cat $TMP/q1.code)/$(cat $TMP/q2.code)"
[ "$(keycalls mock-1310)" = "$before" ] || fail "a cooling provider was called again ($before → $(keycalls mock-1310))"
curl -sf http://$YGG/session/$S1/message | python3 -c '
import sys,json; ms=json.load(sys.stdin)
users=[m for m in ms if m["info"]["role"]=="user"]; asst=[m for m in ms if m["info"]["role"]=="assistant"]
assert len(users)==4 and len(asst)==4, (len(users), len(asst))
for a in asst:
    assert a["info"]["error"]["data"]["kind"]=="quota", a["info"]
    assert any(p.get("synthetic") and "resets" in p["text"] for p in a["parts"]), a["parts"]'
pass "stacked turns never vanish: 4 user turns → 4 error turns, all with the reset; 0 extra upstream calls while cooling"

# ---------------------------------------------------------------------------------------- 2
cli add backup --base-url $M/v1 --model mock-b --key-env BACKUP_KEY --name "backup (openai-shaped)" >$TMP/cli1.txt || fail "cli add"
cli fallback backup/mock-b >$TMP/cli2.txt || fail "cli fallback"
grep -q 'fallback \[backup/mock-b\]' $TMP/cli2.txt || fail "cli fallback output: $(cat $TMP/cli2.txt)"
[ "$(stat -c %a $PF)" = 600 ] || fail "providers file mode $(stat -c %a $PF), want 600"
grep -q 'good-key' $PF && fail "the key VALUE landed in the file"
grep -q '{env:BACKUP_KEY}' $PF || fail "the key reference is not {env:BACKUP_KEY}"
code=$(post $S1 "reply with exactly: BACK-ON-AIR" $TMP/r2.json)
python3 - $TMP/r2.json <<'PY' || fail "fallback turn"
import sys, json
m = json.load(open(sys.argv[1])); i = m["info"]
assert "error" not in i, i
text = "".join(p["text"] for p in m["parts"] if p["type"] == "text")
assert text == "BACK-ON-AIR", text
assert (i["providerID"], i["modelID"]) == ("backup", "mock-b"), i
f = i["fallback"][0]
assert (f["from"], f["to"], f["kind"]) == ("yggdrasil/mock", "backup/mock-b", "quota") and f["resetsAt"], f
PY
[ "$(keycalls mock-1310)" = "$before" ] || fail "the cooling primary was called during the fallback turn"
grep -q '"type":"provider.fallback"' $TMP/events.txt || fail "no provider.fallback event"
pass "CLI add+fallback, hot-reloaded (no restart): the next turn degrades to backup/mock-b — info.fallback{from,to,kind,resetsAt}, provider.fallback event, primary skipped"

curl -sf $M/last | python3 -c '
import sys,json; b=json.load(sys.stdin)
blob=json.dumps(b["messages"], ensure_ascii=False)
assert b["model"]=="mock-b", b["model"]
assert "⚠" not in blob and "provider limit exhausted" not in blob, blob[:400]
users=[m["content"] for m in b["messages"] if m["role"]=="user"]
assert users[:4]==["where are we at","say something","queued one","queued two"] or set(users[:4])=={"where are we at","say something","queued one","queued two"}, users'
pass "error-turn headlines are synthetic: never in the upstream history; every user turn still is"

curl -sf http://$YGG/provider | python3 -c '
import sys,json; raw=sys.stdin.read(); p=json.loads(raw)
assert "good-key" not in raw and "mock-1310" not in raw, "a key leaked"
ids=[x["id"] for x in p["all"]]; assert ids==["yggdrasil","backup"], ids
assert p["root"]["fallback"]==["backup/mock-b"], p["root"]
k={x["id"]:x["key"] for x in p["root"]["providers"]}
assert k["backup"]=={"source":"env:BACKUP_KEY","resolved":True}, k
assert p["health"]["yggdrasil"]["status"]=="exhausted" and p["health"]["backup"]["status"]=="ok", p["health"]'
pass "GET /provider: opencode {all,default,connected} + root view; key SOURCES only, no key values"

# ---------------------------------------------------------------------------------------- 3
S3=$(new_sid)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://$YGG/api/session/$S3/model -H 'content-type: application/json' \
  -d '{"model":{"id":"nope","providerID":"backup"}}')
[ "$code" = 400 ] || fail "unknown model switch answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://$YGG/api/session/$S3/model -H 'content-type: application/json' \
  -d '{"model":{"id":"mock-b","providerID":"backup"}}')
[ "$code" = 204 ] || fail "switch answered $code"
post $S3 "reply with exactly: PICKED" $TMP/r3.json >/dev/null
python3 -c "
import json; m=json.load(open('$TMP/r3.json')); i=m['info']
assert (i['providerID'], i['modelID'])==('backup','mock-b') and 'fallback' not in i and 'error' not in i, i"
pass "session switch routes the run: backup/mock-b answers directly (no fallback note); unknown model → 400"

cli use backup/mock-b >/dev/null || fail "cli use"
[ "$(curl -sf http://$YGG/config | python3 -c 'import sys,json;print(json.load(sys.stdin)["model"])')" = backup/mock-b ] || fail "default did not move"
S4=$(new_sid)
post $S4 "reply with exactly: NEW-DEFAULT" $TMP/r4.json >/dev/null
python3 -c "
import json; i=json.load(open('$TMP/r4.json'))['info']
assert i['providerID']=='backup' and 'fallback' not in i, i"
curl -sf http://$YGG/config/providers | python3 -c '
import sys,json; d=json.load(sys.stdin); assert d["default"]=={"backup":"mock-b"}, d'
cli use yggdrasil/mock >/dev/null
pass "CLI 'provider use' moves the default live: GET /config + /config/providers follow, a fresh session runs on it"

# ---------------------------------------------------------------------------------------- 4
cat >$PF <<JSON
{ "fallback": ["dead/x", "backup/mock-b"],
  "provider": {
    "dead":   { "options": { "baseURL": "http://127.0.0.1:9/v1" }, "models": { "x": {} } },
    "backup": { "options": { "baseURL": "$M/v1", "apiKey": "{env:BACKUP_KEY}" }, "models": { "mock-b": {} } } } }
JSON
chmod 600 $PF
start_root mock-401 openai $M/v1
S5=$(new_sid)
post $S5 "reply with exactly: VIA-BACKUP" $TMP/r5.json >/dev/null
python3 -c "
import json; m=json.load(open('$TMP/r5.json')); i=m['info']
assert i['providerID']=='backup' and 'error' not in i, i
assert i['fallback'][0]['from']=='yggdrasil/mock' and i['fallback'][0]['kind']=='auth', i['fallback']"
grep -q 'upstream dead/x: request failed' $TMP/root.log || fail "the dead fallback was not tried in order"
pass "401 on the primary + a dead first fallback → the second fallback answers (order kept: auth → network → ok)"

cli fallback dead/x >/dev/null
post $S5 "anyone there" $TMP/r6.json >/dev/null
python3 - $TMP/r6.json <<'PY' || fail "auth + down error turn"
import json, sys
m = json.load(open(sys.argv[1])); e = m["info"]["error"]; d = e["data"]
assert e["name"] == "ProviderAuthError" and d["kind"] == "auth" and d["statusCode"] == 401, e
assert d["tried"][0]["kind"] == "network" and d["tried"][0]["providerID"] == "dead", d["tried"]
t = next(p["text"] for p in m["parts"] if p.get("synthetic"))
assert t.startswith("⚠ provider refused the key") and "env:YGG_UPSTREAM_API_KEY" in t, t
assert "fallback x: provider unreachable" in t and "Every provider in the chain failed" in t, t
print("  " + " | ".join(t.splitlines()))
PY
pass "auth stop names the key's SOURCE (your key, your fix); the dead fallback is listed; one error turn"

curl -sf -X POST http://$YGG/provider/check | python3 -c '
import sys,json; r=json.load(sys.stdin)["results"]
assert r["yggdrasil"]["status"]=="auth" and not r["yggdrasil"]["ok"], r
assert r["dead"]["status"]=="down", r
assert r["backup"]["ok"] and "mock-b listed" in r["backup"]["detail"], r'
RC=0; cli check >$TMP/check.txt || RC=$?
[ $RC = 1 ] || fail "cli check exit $RC with a refused default (want 1)"
grep -q '✓ backup/mock-b' $TMP/check.txt && grep -q '✗ yggdrasil/mock' $TMP/check.txt || fail "cli check: $(cat $TMP/check.txt)"
cli list >$TMP/list.txt
grep -q 'key env:YGG_UPSTREAM_API_KEY ✓' $TMP/list.txt && grep -q 'key env:BACKUP_KEY ✓' $TMP/list.txt || fail "cli list: $(cat $TMP/list.txt)"
grep -qE 'mock-401|good-key' $TMP/check.txt $TMP/list.txt && fail "the CLI printed a key"
RC=0; env -i HOME=$HOME PATH=$PATH "$BIN" provider add k --base-url http://x/v1 --model m --key sk-123 --file $PF 2>/dev/null || RC=$?
[ $RC = 2 ] || fail "a key on the command line was accepted"
pass "health check: POST /provider/check (auth/down/ok) + CLI check (exit 1 on a refused default) + list; keys never printed, never accepted on argv"

# ---------------------------------------------------------------------------------------- 5
cp $PF $TMP/good.json
echo '{ "provider": { broken' >$PF
post $S5 "still there" $TMP/r7.json >/dev/null
curl -sf http://$YGG/provider | python3 -c '
import sys,json; p=json.load(sys.stdin)
assert "reloadError" in p and "providers.json" in p["reloadError"], p.get("reloadError")
assert p["root"]["fallback"]==["dead/x"], p["root"]'
cli use backup/mock-b >/dev/null 2>&1 && fail "the CLI wrote over a broken file without loading it"
cp $TMP/good.json $PF
pass "a broken providers file: the root keeps the last good registry and says so (reloadError); the CLI refuses to edit it"

echo "verify-providers: ALL $N PASS"
