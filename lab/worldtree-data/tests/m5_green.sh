#!/usr/bin/env bash
# M5 RUN A finish line (briefs/M5-runA-data.md): method 0.3.0 history + refresh/geography blocks + open /data/ live;
# pins at method 0.3.1 (briefs/ARI-incorporate.md): +ARI source/series/feed, test_ari, /data/series/ari.index.csv live.
set -e
cd "$(dirname "$0")/.."
step() { echo "== $*"; }
fail() { echo "FAIL line $1"; exit 1; }
SITE=https://veraldar.org

step "1 m3 still green"
bash tests/m3_green.sh > /tmp/m3.txt 2>&1 || { tail -5 /tmp/m3.txt; fail $LINENO; }
tail -1 /tmp/m3.txt | grep -qx 'M3 GREEN' || fail $LINENO; echo "M3 GREEN"

step "2 history unit tests (no-lookahead, determinism, sum-100, provisional) + ARI (parse, gate, provenance, unborn)"
python3 -m unittest tests.test_history 2>&1 | tail -1 | grep -qx OK || fail $LINENO; echo "test_history OK"
python3 -m unittest tests.test_ari 2>&1 | tail -1 | grep -qx OK || fail $LINENO; echo "test_ari OK"
head -2 series/ari.index.csv | cut -d, -f1-3; tail -1 series/ari.index.csv | cut -d, -f1-3
jq -e '[.realms.control.indicators[] | select(.series_id=="ari.index") | .ref_n >= 24] == [true]' out/realms.provenance.json > /dev/null || fail $LINENO; echo "ARI in control, ref_n ≥ 24"

step "3 history determinism on live data (pinned --now, byte-identical)"
ASOF=$(jq -r .as_of out/realms.provenance.json)
python3 -m wt history --as-of "$ASOF" --now 2026-01-01T00:00:00Z --out /tmp/wt-h1/realms-history.json > /dev/null
python3 -m wt history --as-of "$ASOF" --now 2026-01-01T00:00:00Z --out /tmp/wt-h2/realms-history.json > /dev/null
cmp /tmp/wt-h1/realms-history.json /tmp/wt-h2/realms-history.json || fail $LINENO
cmp /tmp/wt-h1/realms-history.provenance.json /tmp/wt-h2/realms-history.provenance.json || fail $LINENO
jq -r '.series[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum -c --quiet || fail $LINENO  # history left series/ as the run built it
echo "history byte-identical, series/ untouched"

step "4 no-lookahead on live data (future rows invisible to past years)"
python3 - <<'PY'
import json
a = json.load(open('/tmp/wt-h1/realms-history.json'))
b = json.load(open('out/realms-history.json'))
# same data, different --now: every year's numbers identical (only run_id/updated differ)
for x, y in zip(a['years'], b['years']):
    assert {k: x[k] for k in ('weights', 'coverage', 'provisional', 'ref_n_min')} == \
           {k: y[k] for k in ('weights', 'coverage', 'provisional', 'ref_n_min')}, x['year']
p = json.load(open('out/realms-history.provenance.json'))
for y in b['years']:
    for R in p['years'][str(y['year'])]['realms'].values():
        for i in R['indicators']:
            assert i['latest_date'] <= y['as_of'], (y['year'], i['series_id'], i['latest_date'])
print('every indicator of every year dated ≤ its cut')
PY

step "5 schema"
python3 - <<'PY'
import hashlib, json
from datetime import date
K = ['utopia', 'divergence', 'drift', 'control', 'terminus', 'stagnation', 'transcendence']
r = json.load(open('out/realms.json')); h = json.load(open('out/realms-history.json'))
v = open('method/VERSION').read().strip()
assert r['method_version'] == h['method_version'] == v, v
for doc in (r, h):
    f = doc['refresh']
    assert f['cadence'] == 'nightly' and f['local_time'] == '14:30 Europe/Berlin' and f['utc_time'] == '12:30 UTC'
    assert f['timer'] == 'worldtree-fetch.timer' and f['pipeline'] == f'worldtree-data method {v}'
    ids = [s['id'] for s in f['sources']]
    assert set(['owid', 'worldbank', 'epoch', 'wikimedia', 'arxiv', 'pubmed', 'fedreg', 'noaa_gml', 'ari']) <= set(ids), ids
    g = doc['geography']
    allowed = {'NA', 'LATAM', 'EUR', 'AF', 'MENA', 'ASIA', 'OC', 'GLOBAL'}
    for sid in ids:
        e = g[sid]
        assert e['regions'] and set(e['regions']) <= allowed and e['detail'] and e['license'] and e['source_doc'].startswith('https://'), sid
    assert g['fedreg']['regions'] == ['NA'] and g['owid']['regions'] == ['GLOBAL'] and g['ari']['regions'] == ['GLOBAL']
assert r['history'] == {'file': 'realms-history.json',
                        'sha256': hashlib.sha256(open('out/realms-history.json', 'rb').read()).hexdigest()}
assert h['schema'] == 'worldtree.history/1' and h['as_of'] == json.load(open('out/realms.provenance.json'))['as_of']
assert h['provenance']['sha256'] == hashlib.sha256(open('out/realms-history.provenance.json', 'rb').read()).hexdigest()
ys = h['years']; asof = date.fromisoformat(h['as_of'])
assert [y['year'] for y in ys] == list(range(2015, asof.year + 1))
for y in ys:
    assert list(y['weights']) == K and sum(round(y['weights'][k] * 10) for k in K) == 1000, y['year']
    assert all(y['provisional'][k] == (y['coverage'][k] < 0.5) for k in K), y['year']
    assert y['as_of'] == (f"{y['year']}-12-31" if y['year'] < asof.year else h['as_of'])
assert ys[-1]['weights'] == r['weights'], 'as-of year must equal the published weights'
assert r['sources']['Mac Studio ARI pipeline'] == 1 and len(r['sources']) == 9, r['sources']
assert len(r['feeds']) == 24 and [f for f in r['feeds'] if f['name'] == 'Agent Restriction Index (ARI)'], len(r['feeds'])
assert any(ys[0]['provisional'].values()) and not any(ys[-1]['provisional'].values())
print('schema OK ·', len(ys), 'years ·', 'provisional 2015:', ','.join(k for k in K if ys[0]['provisional'][k]))
PY

step "6 /data/ live"
for f in data/ data/DATA.md data/series/noaa.co2.csv data/series/ari.index.csv data/catalog/mapping.csv data/out/realms-history.json realms-history.json; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/$f"); [ "$c" = 200 ] || { echo "$f → $c"; fail $LINENO; }; echo "200 $f"
done
curl -s "$SITE/data/manifest.json" | jq -r '.series[] | "\(.sha256)  \(.path)"' | grep ' series/noaa.co2.csv$' \
  | diff - <(echo "$(curl -s "$SITE/data/series/noaa.co2.csv" | sha256sum | cut -d' ' -f1)  series/noaa.co2.csv") || fail $LINENO
echo "live series matches live manifest"
curl -s "$SITE/llms.txt" | grep -qxF "Open data: $SITE/data/ (series CSVs + catalog + per-number provenance)" || fail $LINENO; echo "llms.txt line OK"
[ "$(curl -s "$SITE/llms.txt" | grep -c 'Open data:')" = 1 ] || fail $LINENO

step "7 live realms.json"
L=$(curl -s "$SITE/realms.json")
echo "$L" | jq -e '.refresh.cadence=="nightly" and .refresh.timer=="worldtree-fetch.timer" and .method_version=="0.3.1" and (.geography|has("owid")) and (.geography|has("ari")) and .sources["Mac Studio ARI pipeline"]==1' > /dev/null || fail $LINENO
[ "$(echo "$L" | jq -r .history.sha256)" = "$(curl -s "$SITE/realms-history.json" | sha256sum | cut -d' ' -f1)" ] || fail $LINENO
echo "live refresh block + history pointer OK ($(echo "$L" | jq -r .updated))"
systemctl --user is-enabled worldtree-fetch.timer | grep -qx enabled || fail $LINENO
echo "timer enabled · next $(systemctl --user show worldtree-fetch.timer -p NextElapseUSecRealtime --value)"

echo "M5 GREEN"
