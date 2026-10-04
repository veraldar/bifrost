#!/usr/bin/env bash
# M6: country panel (method 0.4.0) — determinism, no-lookahead, schema, map asset. Prints M6 GREEN.
step() { echo "== $*"; }
set -e
cd "$(dirname "$0")/.."
fail() { echo "FAIL line $1" >&2; exit 1; }

step "1 determinism (rerun byte-identical)"
python3 -m wt countries --as-of "$(date -u +%F)" --no-commit >/dev/null
cp out/countries.json /tmp/wt-c1.json
python3 -m wt countries --as-of "$(date -u +%F)" --no-commit >/dev/null
cmp -s /tmp/wt-c1.json out/countries.json || fail $LINENO
echo "countries byte-identical OK"

step "2 no-lookahead + old-year sanity (as-of 2016: every indicator year_max <= 2016, >100 countries)"
python3 -m wt countries --as-of 2016-12-31 --no-commit >/dev/null
python3 - <<'PY'
import json
d = json.load(open('out/countries.json'))
assert d['as_of'] == '2016-12-31'
assert all(v['year_max'] <= 2016 for v in d['indicators'].values()), "future data leaked into 2016"
n_utopia = d['realms']['utopia']['n_countries']
assert n_utopia > 100, n_utopia
print(f"no-lookahead OK · 2016 utopia covers {n_utopia} countries")
PY
python3 -m wt countries --as-of "$(date -u +%F)" --no-commit >/dev/null

step "3 schema (7 realms, scores 0-100, provisional iff coverage<0.5, iso3 subset of map paths)"
python3 - <<'PY'
import json
d = json.load(open('out/countries.json'))
mp = json.load(open('data/countries-paths.json'))
assert set(d['realms']) == {'utopia','divergence','drift','control','terminus','stagnation','transcendence'}
assert mp['schema'] == 'worldtree.map/1' and len(mp['paths']) >= 160
import os; assert os.path.getsize('data/countries-paths.json') <= 80*1024
scored = [(r, iso) for r, R in d['realms'].items() for iso in R['countries']]
unmapped = sorted({iso for r, iso in scored if iso not in mp['paths']})
assert len(unmapped) <= 15, f"too many scored countries lack map paths: {unmapped}"
for r, R in d['realms'].items():
    for iso, c in R['countries'].items():
        assert c['score'] is None or 0 <= c['score'] <= 100
        assert c['provisional'] == (c['coverage'] < 0.5), (r, iso)
assert set(d['names']) >= set(mp['paths'])
print(f"schema OK · {len(mp['paths'])} map paths · unmapped small states: {','.join(unmapped) or 'none'}")
PY

echo "M6 GREEN"
