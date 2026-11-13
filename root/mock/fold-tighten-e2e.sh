#!/usr/bin/env bash
# fold-tighten-r1 scratch e2e + LAT check (prefill mock :18106; scratch brain :14106; NEVER :4100).
# Same 8 owner + 8 auto fat-turn session on BASE_BIN (live lineage, window 3) and BIN (window 2,
# station hard fold): fold counts on the wire + last-turn LAT ttfb_ms must drop.
set -u
D=/tmp/fold-tighten-e2e; rm -rf $D; mkdir -p $D
CRATE=$(cd "$(dirname "$0")/.." && pwd); BIN=${BIN:-$CRATE/target/release/yggdrasil}
BASE_BIN=${BASE_BIN:-$HOME/.local/share/bifrost/brain/yggdrasil-async-r1-e662bde7}
Y=127.0.0.1:14106; U=http://$Y; M=http://127.0.0.1:18106
python3 $CRATE/mock/prefill_mock.py 18106 >$D/mock.log 2>&1 & MOCK=$!
SRV=; trap 'kill $MOCK $SRV 2>/dev/null' EXIT
FAT=$(python3 -c 'print("filler "*300)')
run() { # $1 = tag, $2 = binary
  local d=$D/$1 sid n=0 i; mkdir -p $d
  YGG_DATA_DIR=$d/data YGG_LISTEN=$Y YGG_UPSTREAM_BASE_URL=$M/v1 YGG_UPSTREAM_STYLE=openai \
   YGG_UPSTREAM_API_KEY=dummy YGG_UPSTREAM_MODEL=mock YGG_PROJECT_DIR=$D $2 2>$d/ygg.log & SRV=$!
  for _ in $(seq 50); do curl -sf $U/session >/dev/null && break; sleep 0.1; done
  sid=$(curl -sf -X POST $U/session -H 'content-type: application/json' -d '{"title":"[MAIN]"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  post() { python3 -c 'import json,sys;d={"parts":[{"type":"text","text":sys.argv[1]}]}
if sys.argv[2]=="auto": d["meta"]={"auto":True}
print(json.dumps(d))' "$1" "$2" | curl -s -X POST $U/session/$sid/message -H 'content-type: application/json' -d @- -o /dev/null; curl -s $M/last >$d/last.$3.json; }
  for i in 1 2 3 4 5 6 7 8; do
    post "OWNER$i ask
$FAT" owner $((++n)); post "AUTO$i landing
$FAT" auto $((++n))
  done
  curl -s -X DELETE $U/session/$sid -o /dev/null
  kill $SRV; wait $SRV 2>/dev/null; SRV=
}
run base "$BASE_BIN"; run new "$BIN"
python3 - $D <<'PY'
import json, re, sys
D = sys.argv[1]; fail = 0
def chk(name, ok):
    global fail; print(("PASS " if ok else "FAIL ") + name); fail |= not ok
def body(tag, k): return json.load(open(f"{D}/{tag}/last.{k}.json"))["messages"]
def txt(m): return m["content"] if isinstance(m["content"], str) else json.dumps(m["content"])
def lat(tag):
    rows = [l for l in open(f"{D}/{tag}/ygg.log") if l.startswith("LAT phase=")]
    return [int(re.search(r"ttfb_ms=(\d+)", r).group(1)) for r in rows]
t = [txt(m) for m in body("new", 16)]
verb = lambda w: any(w + "\nfiller filler" in x for x in t)
chk("owner window 2: OWNER7-8 verbatim", all(verb(f"OWNER{i} ask") for i in (7, 8)))
chk("owner 1-6 folded to [earlier turn] lines", not any(verb(f"OWNER{i} ask") for i in range(1, 7))
    and sum(x.startswith("[earlier turn] OWNER") for x in t) == 6)
chk("station window 2: AUTO7-8 verbatim", all(verb(f"AUTO{i} landing") for i in (7, 8)))
chk("auto 1-6 hard-folded to [station turn] lines", not any(verb(f"AUTO{i} landing") for i in range(1, 7))
    and sum(x.startswith("[station turn] AUTO") for x in t) == 6)
tb = [txt(m) for m in body("base", 16)]
chk("base (live lineage) kept 3 owners verbatim", sum("ask\nfiller filler" in x for x in tb) == 3)
a, b = [txt(m) for m in body("new", 14)], t
common = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
chk(f"prefix stable across adjacent turns (first {common} msgs identical)", common >= 6)
bs = [len(json.dumps(body(g, 16))) for g in ("base", "new")]
lb, ln = lat("base"), lat("new")
print(f"last-turn upstream bytes base={bs[0]} new={bs[1]}  LAT ttfb_ms last-4 base={lb[-4:]} new={ln[-4:]}")
chk("LAT rows present for all 16 turns on both", len(lb) == 16 and len(ln) == 16)
chk("upstream body shrinks >=25%", bs[1] <= 0.75 * bs[0])
chk("LAT ttfb (steady state, last 4 turns mean) drops >=20%", sum(ln[-4:]) <= 0.8 * sum(lb[-4:]))
sys.exit(1 if fail else 0)
PY
