#!/usr/bin/env bash
# M3 finish line (briefs/M3-build.md): the M2 gate updated for method 0.2.0 — pins at method 0.3.1 (+ARI): 9 core sources, 26 series, 25 mapping rows;
# at method 0.4.1 (+GitHub): 10 world sources, 28 mapping rows (divergence 9, transcendence 5), 26 feeds;
# at method 0.5.0 (+tools, M10): 60 series, 31 mapping rows (utopia 10, divergence 11, transcendence 6), 28 feeds;
# at method 0.6.0 (M8 honesty review): 63 series (+github.all_repos_month, +wb.SP_POP_TOTL normalisers, +country conflict deaths), 30 geo rows, manifest 61.
set -e
cd "$(dirname "$0")/.."
step() { echo "== $*"; }

step "1 proofs"
{ bash tests/proofs.sh; bash tests/proofs_m3.sh; } > /tmp/proofs.txt
[ "$(grep -vc '^200 ' /tmp/proofs.txt || true)" = 0 ] && [ "$(wc -l < /tmp/proofs.txt)" = 32 ] || { echo "FAIL line $LINENO"; exit 1; }; echo "proofs 32/32 200"

step "2 catalog"
python3 -m wt check catalog | grep -qx 'catalog OK 63 series 31 rows 30 geo rows' || { echo "FAIL line $LINENO"; exit 1; }; echo "catalog OK 63 series 31 rows 30 geo rows"
python3 - <<'PY'
import csv; from collections import Counter
m=list(csv.DictReader(open('catalog/mapping.csv'))); c=Counter()
for r in m: c[r['realm']]+=int(r['weight'])
assert dict(c)=={'utopia':10,'divergence':11,'drift':3,'control':6,'terminus':6,'stagnation':7,'transcendence':6}, c
assert all(r['weight']=='1' for r in m if r['transform']=='logistic_delta')
print('mapping OK', len(m))
PY
diff <(jq -S '{colors,definitions}' ~/Work/veraldar-site/realms.json) <(jq -S . catalog/realms.static.json) || { echo "FAIL line $LINENO"; exit 1; }; echo static OK
sed 's/^drift,owid.genai_user_share,+1,1,/drift,owid.genai_user_share,+1,2,/' catalog/mapping.csv > /tmp/wt-badmap.csv
if WT_CATALOG=/tmp/wt-badmap.csv python3 -m wt check catalog 2>/dev/null; then echo "negative catalog check passed?!"; exit 1; fi
echo "negative catalog check exits 1"

step "3 integrity"
python3 -m wt check integrity
jq -r '"\(.sha256)  \(.path)"' $(find raw -name '*.prov.json') | sha256sum -c --quiet || { echo "FAIL line $LINENO"; exit 1; }; echo SIDECARS-OK
jq -e -s 'all(.[]; .schema=="worldtree.prov/1" and .http_status==200 and (.license|length>0) and (.sha256|test("^[0-9a-f]{64}$")))' $(find raw -name '*.prov.json')

step "4 series"
for f in arxiv.cs_ai pubmed.ai_biomed fedreg.ai_documents noaa.co2 ari.index; do
  n=$(($(wc -l < series/$f.csv) - 1)); min=72; [ $f = ari.index ] && min=26; [ "$n" -ge $min ] || { echo "series/$f.csv only $n rows"; exit 1; }; echo "series $f $n rows"
done
python3 -m unittest discover -s tests -p 'test_extract.py' 2>&1 | tail -1 | grep -qx OK || { echo "FAIL line $LINENO"; exit 1; }; echo "extract tests OK"

step "5 method"
python3 -m unittest discover -s tests -p 'test_method.py' 2>&1 | tail -1 | grep -qx OK || { echo "FAIL line $LINENO"; exit 1; }; echo "method tests OK"

step "6 provenance"
RUN=$(ls -1d runs/*/ | sort | tail -1)
jq -e '[.[] | select(.scope=="run") | .pass] | all' "$RUN/gates.json"
python3 - <<'PY'
import json
r=json.load(open('out/realms.json')); p=json.load(open('out/realms.provenance.json'))
K=['utopia','divergence','drift','control','terminus','stagnation','transcendence']
assert list(r['weights'])==K and sum(round(r['weights'][k]*10) for k in K)==1000
n=0; srcs=set()
for k in K:
    R=p['realms'][k]; assert R['weight']==r['weights'][k]
    assert R['coverage']>=0.5, k
    c=sum(i['contribution'] for i in R['indicators']); assert abs(c-(R['evidence']-0.5))<1e-3, k
    for i in R['indicators']:
        assert 0<=i['score']<=1 and i['source_url'].startswith('https://') and i['license']
        n+=1; srcs.add(i['source_id'])
assert n>=17 and len(srcs)==10, (n,srcs)
x=[e for e in p['realms']['terminus']['excluded'] if e['series_id']=='wiki.ai_xrisk']
print('PROV-OK', n, 'indicators', sorted(srcs), 'xrisk excluded:', x[0]['reason'] if x else 'no')
PY
tail -1 out/history.csv

step "7 contract"
python3 tests/check_contract.py out/realms.json
if python3 tests/check_contract.py ~/Work/veraldar-site/realms.json >/dev/null; then echo "seed passed?!"; exit 1; fi; echo "seed exit=1"
jq '.weights.drift="x"' out/realms.json > /tmp/wt-bad.json
if python3 tests/check_contract.py /tmp/wt-bad.json >/dev/null; then echo "bad passed?!"; exit 1; fi; echo "bad exit=1"
[ "$(jq '.feeds|length' out/realms.json)" = 28 ] || { echo "FAIL line $LINENO"; exit 1; }; echo "feeds 28"

step "8 queries"
bash tests/queries.sh > /tmp/q.txt 2>&1
[ "$(grep -c ': OK$' /tmp/q.txt)" -ge 4 ] && [ "$(grep -c ALL-RAW-OK /tmp/q.txt)" = 1 ] || { echo "FAIL line $LINENO"; exit 1; }; echo "queries OK"

step "9 determinism"
python3 -m unittest discover -s tests -p 'test_fixture.py' 2>&1 | tail -1 | grep -qx OK || { echo "FAIL line $LINENO"; exit 1; }; echo "fixture byte-identical OK"

step "10 manifest"
jq -r '.raw[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum -c --quiet || { echo "FAIL line $LINENO"; exit 1; }; echo ALL-RAW-OK
jq -e --arg v "$(cat method/VERSION)" '.schema=="worldtree.manifest/1" and .method_version==$v and .last_run.published==true and (.series|length)==61' manifest.json
jq -r '.out.realms.sha256' manifest.json | diff - <(sha256sum out/realms.json | cut -d' ' -f1) || { echo "FAIL line $LINENO"; exit 1; }; echo OUT-HASH-OK
git log --since='2 days ago' --format=%s | grep -qE '^run [0-9]{8}T[0-9]{6}Z: published$'
[ "$(git status --porcelain . | wc -l)" = 0 ] || { echo "FAIL line $LINENO"; exit 1; }; echo "worktree clean"  # lab dir; other sessions' WIP elsewhere is not ours

echo "M3 GREEN"
