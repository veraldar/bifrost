#!/usr/bin/env bash
# M8 honesty review (briefs/M8-review.md, method 0.6.0): the referee for docs/worldtree/honesty-review.md — every fix the
# review made still holds in the data, the catalog, the nightly, the live files and the live page. Prints M8 HONESTY GREEN.
set -e
cd "$(dirname "$0")/.."
step() { echo "== $*"; }
fail() { echo "FAIL line $1" >&2; exit 1; }
SITE=https://veraldar.org

step "1 catalog: every series says what it measures; normalisers are never mapped; tool + Lean counts normalised"
python3 - <<'PY'
import csv
S = {r['series_id']: r for r in csv.DictReader(open('catalog/series.csv', encoding='utf-8'))}
M = list(csv.DictReader(open('catalog/mapping.csv', encoding='utf-8')))
assert all(r['measures'] in ('ai', 'world', 'norm') for r in S.values())
assert all(S[r['series_id']]['measures'] in ('ai', 'world') for r in M)
for r in M:
    if r['series_id'] in ('github.tool_repos_month', 'github.lean_repos_month'):
        assert 'norm=github.all_repos_month' in r['params'], r
    if r['series_id'] == 'owid.conflict_deaths':
        assert 'not AI' in r['rationale'] and 'weapons arm' not in r['rationale'], r['rationale']
w = sorted(k for k, r in S.items() if r['measures'] == 'world' and any(m['series_id'] == k for m in M))
print('mapped world-condition series:', ', '.join(w))
G = list(csv.DictReader(open('catalog/mapping_geo.csv', encoding='utf-8')))
stag = [r for r in G if r['realm'] == 'stagnation']
assert stag and all(r['direction'] == '-1' for r in stag), stag  # R&D, researchers, patents are evidence AGAINST the stall
tot = [r['series_id'] for r in G if 'percap=wb.SP_POP_TOTL' in r['params']]
assert len(tot) == 9, tot  # 8 absolute-total rows + country conflict deaths
print(f'geo: stagnation rows {len(stag)} all −1; per-capita rows {len(tot)}')
PY

step "2 realms.json: the lenses are real numbers; every feed carries its tier; STRICT = the AI indicators only"
python3 - <<'PY'
import csv, json
K = ['utopia', 'divergence', 'drift', 'control', 'terminus', 'stagnation', 'transcendence']
S = {r['series_id']: r for r in csv.DictReader(open('catalog/series.csv', encoding='utf-8'))}
r = json.load(open('out/realms.json')); p = json.load(open('out/realms.provenance.json'))
m = r['modes']
assert m['wide'] == r['weights'] and sum(round(m['strict'][k] * 10) for k in K) == 1000
assert all(f.get('tier') in ('ai', 'world') for f in r['feeds']), [f for f in r['feeds'] if f.get('tier') not in ('ai', 'world')]
for k in K:
    st = p['realms'][k]['strict']
    assert st['weight'] == m['strict'][k] and all(S[s]['measures'] == 'ai' for s in st['series']), (k, st)
    assert set(st['series']) == {i['series_id'] for i in p['realms'][k]['indicators'] if S[i['series_id']]['measures'] == 'ai'}, k
lead = max(K, key=lambda k: r['weights'][k]); slead = max(K, key=lambda k: m['strict'][k])
print('headline ', ' '.join(f"{k} {r['weights'][k]}" for k in K), '· leader', lead)
print('STRICT AI', ' '.join(f"{k} {m['strict'][k]}" for k in K), '· leader', slead)
print('gap      ', ' '.join(f"{k} {r['weights'][k] - m['strict'][k]:+.1f}" for k in K))
for k in K:
    st = p['realms'][k]['strict']
    if not st['series']:
        print(f'{k}: no AI-specific indicator in use (w_map {st["w_map"]}) → neutral under STRICT AI')
PY

step "3 GitHub: platform total stored + used; bots + like-for-like computable from the published file"
python3 - <<'PY'
import csv, json
a = list(csv.DictReader(open('series/github.all_repos_month.csv')))
assert len(a) >= 93 and a[0]['period'] == '2019-01', (len(a), a[0]['period'])
by = {x['period']: int(x['value']) for x in a}
last = a[-1]['period']; y, mo = int(last[:4]), int(last[5:])
prev = f'{y - 1}-{mo:02d}'
print(f'all new public repos {prev} {by[prev]:,} → {last} {by[last]:,} (×{by[last] / by[prev]:.2f})')
p = json.load(open('out/realms.provenance.json'))
for realm, sid in (('divergence', 'github.tool_repos_month'), ('transcendence', 'github.tool_repos_month'), ('utopia', 'github.lean_repos_month')):
    i = [x for x in p['realms'][realm]['indicators'] if x['series_id'] == sid][0]
    assert i['norm_snapshot']['path'].startswith('raw/github/all_repos/'), i['norm_snapshot']
    print(f'{realm:13} {sid:24} score {i["score"]:.2f} (per million new repos; y {i["y_latest"]:+.3f})')
t = json.load(open('out/github-trends.json'))
assert len(t['tools']['all_repos_by_month']) >= 93 and 'series/github.all_repos_month.csv' in t['provenance']['series']
r = t['releases_by_year'][-1]; ry = t['releases_by_repo_year']
same = [k for k in ry if ry[k].get('2019', 0) > 0 and ry[k].get(str(r['year']), 0) > 0]
sa, sb = sum(ry[k]['2019'] for k in same), sum(ry[k][str(r['year'])] for k in same)
print(f"releases {r['year']}: {r['releases']} ({r['bot_releases']} cut by bots) · like for like 2019 → {r['year']}: {len(same)} repos {sa} → {sb} (×{sb / sa:.1f})")
PY

step "4 countries.json: per-capita meta, conflict deaths in terminus, stagnation sign sane, no-AI note"
python3 -m wt countries --as-of "$(date -u +%F)" --no-commit >/dev/null
python3 - <<'PY'
import csv, json
c = json.load(open('out/countries.json'))
assert 'None of these indicators measures AI' in c['note']
assert c['indicators']['owid_geo.deaths_in_armed_conflicts_by_country']['per_capita'] == 'wb.SP_POP_TOTL'
rd = {}
for x in csv.DictReader(open('series/wb.GB_XPD_RSDV_GD_ZS.csv')):
    rd[x['geo']] = float(x['value'])  # rows sorted by year: the last kept is the latest
S = c['realms']['stagnation']['countries']
ranked = sorted((v['score'], k) for k, v in S.items() if v['score'] is not None and k in rd)
lo, hi = ranked[:10], ranked[-10:]
m = lambda xs: sum(rd[k] for _, k in xs) / len(xs)
print(f'stagnation: R&D % GDP of the 10 least stagnant {m(lo):.2f} vs the 10 most {m(hi):.2f}')
assert m(lo) > m(hi)  # more research ⇒ further from the stall (0.5.0 had it backwards)
print('terminus indicators', c['realms']['terminus']['n_indicators'], '· transcendence', c['realms']['transcendence']['n_indicators'],
      '· drift', c['realms']['drift']['n_indicators'])
PY
grep -q 'wt countries' scripts/nightly.sh || fail $LINENO; echo "nightly recomputes the atlas"

step "5 live files = out/ (realms.json, countries.json, github-trends.json)"
for f in realms.json countries.json github-trends.json; do
  [ "$(curl -s "$SITE/$f?m8=$(date +%s)" | sha256sum | cut -d' ' -f1)" = "$(sha256sum out/$f | cut -d' ' -f1)" ] || { echo "live $f differs from out/"; fail $LINENO; }
done
echo "live realms.json, countries.json, github-trends.json = out/"

step "6 live page: what a visitor reads"
R=$(node tests/shot_honesty.cjs "$SITE/world-tree.html?m8=$(date +%s)")
echo "$R" | jq -c '.checks'
echo "$R" | jq -e '(.errs|length)==0 and ([.checks[]]|all)' > /dev/null || { echo "$R" | jq '.detail'; fail $LINENO; }

echo "M8 HONESTY GREEN"
