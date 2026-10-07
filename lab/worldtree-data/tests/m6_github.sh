#!/usr/bin/env bash
# M6 GitHub (briefs/M6-github.md, method 0.4.1): AI evolution speed — stored data + provenance, exponential evidence,
# budget guard, trends file, world mapping, m3+m5 still green, live page lines + screenshot. Prints M6 GITHUB GREEN.
set -e
cd "$(dirname "$0")/.."
step() { echo "== $*"; }
fail() { echo "FAIL line $1" >&2; exit 1; }
SITE=https://veraldar.org
SHOT=~/Work/bifrost/artifacts/worldtree-github-chart.png

step "1 unit tests (frozen release page, Link-count + search-count parse, extraction rules, budget guard)"
python3 -m unittest tests.test_github 2>&1 | grep -q '^OK$' || fail $LINENO; echo "test_github OK"

step "2 stored data w/ provenance sidecars (sha256, url, license)"
python3 - <<'PY'
import glob, hashlib, json
n = {}
for sc in glob.glob('raw/github/*/*.prov.json'):
    m = json.load(open(sc)); kind = sc.split('/')[2]
    assert m['schema'] == 'worldtree.prov/1' and m['http_status'] == 200 and m['source_id'] == 'github', sc
    assert m['url'].startswith('https://api.github.com/') and 'GitHub ToS' in m['license'], sc
    assert hashlib.sha256(open(m['path'], 'rb').read()).hexdigest() == m['sha256'], sc
    n[kind] = n.get(kind, 0) + 1
print('sidecars OK', dict(sorted(n.items())))
PY
for f in releases_year commits_month stars_snapshot; do echo "series github.$f $(($(wc -l < series/github.$f.csv) - 1)) rows"; done
[ $(($(wc -l < series/github.commits_month.csv) - 1)) -ge 72 ] || fail $LINENO  # backfill 2019-01 → last complete month

step "3 exponential evidence"
python3 - <<'PY'
import csv, json
r = {int(x['period']): x for x in csv.DictReader(open('series/github.releases_year.csv'))}
ys = sorted(y for y in r if int(r[y]['value']) > 0)
first, last = ys[:3], ys[-3:]
mf = sum(int(r[y]['value']) for y in first) / 3; ml = sum(int(r[y]['value']) for y in last) / 3
print(f"releases/yr {', '.join(f'{y} {r[y]["value"]}' for y in ys)}")
print(f"releases/yr 2019 → 2025: {r[2019]['value']} → {r[2025]['value']} (×{int(r[2025]['value'])/int(r[2019]['value']):.1f})")
print(f"mean {first[0]}-{first[-1]} {mf:.1f} vs {last[0]}-{last[-1]} {ml:.1f} → ×{ml/mf:.1f} (gate > 3×)")
assert ml > 3 * mf
pr = lambda y: int(r[y]['value']) / max(1, int(r[y]['n_repos']))
print(f"per releasing repo {first[0]} {pr(first[0]):.1f} → {last[-1]} {pr(last[-1]):.1f} (×{pr(last[-1])/pr(first[0]):.1f}; growth net of repo births)")
print(f"median days between releases {first[0]} {r[first[0]]['median_gap_days']} → {last[-1]} {r[last[-1]]['median_gap_days']}")
c = list(csv.DictReader(open('series/github.commits_month.csv')))
a = sum(int(x['value']) for x in c[:12]); b = sum(int(x['value']) for x in c[-12:])
print(f"commits/12mo {c[0]['period']}…{c[11]['period']} {a:,} → {c[-12]['period']}…{c[-1]['period']} {b:,} (×{b/a:.1f})")
s = list(csv.DictReader(open('series/github.stars_snapshot.csv')))
print(f"stars Σ12 repos: {len(s)} night(s) {s[0]['period']} {int(s[0]['value']):,} → {s[-1]['period']} {int(s[-1]['value']):,} (accumulating since 2026-10)")
PY

step "4 github-trends.json (schema, provenance sha256, every raw file verified)"
python3 - <<'PY'
import hashlib, json
d = json.load(open('out/github-trends.json')); v = open('method/VERSION').read().strip()
assert d['schema'] == 'worldtree.github/1' and d['method_version'] == v
assert d['releases_by_year'] and d['commits_by_month'] and len(d['stars']) == 12
p = open('out/github-trends.provenance.json', 'rb').read()
assert hashlib.sha256(p).hexdigest() == d['provenance']['sha256']
files = json.loads(p)['files']; assert len(files) == d['provenance']['raw_files']
for f in files:
    assert hashlib.sha256(open(f['path'], 'rb').read()).hexdigest() == f['sha256'], f['path']
print(f"trends OK · {len(files)} raw files verified · repos:", ', '.join(f"{x['repo'].split('/')[1]}={x['releases'].split(':')[0]}" for x in d['repos']))
PY

step "5 world mapping (releases → divergence + transcendence, commits → divergence, stars unmapped; B15)"
python3 - <<'PY'
import json
p = json.load(open('out/realms.provenance.json'))
for realm, sid in (('divergence', 'github.releases_year'), ('transcendence', 'github.releases_year'), ('divergence', 'github.commits_month')):
    R = p['realms'][realm]
    u = [i for i in R['indicators'] if i['series_id'] == sid]; x = [e for e in R['excluded'] if e['series_id'] == sid]
    assert u or x, (realm, sid)
    if u:
        assert 'B15' in u[0]['bias'] and u[0]['source_url'].startswith('https://api.github.com/')
        print(f"{realm:13} {sid:22} score {u[0]['score']:.2f} (pct {u[0]['pct']}, ref_n {u[0]['ref_n']}, contribution {u[0]['contribution']:+.4f})")
    else:
        print(f"{realm:13} {sid:22} excluded: {x[0]['reason']} {x[0]['detail']}")
assert not any(i['series_id'] == 'github.stars_snapshot' for R in p['realms'].values() for i in R['indicators'])
print('weights', ' '.join(f"{k} {v['weight']}" for k, v in p['realms'].items()))
PY

step "6 m3 + m5 green"
bash tests/m3_green.sh > /tmp/m3.txt 2>&1 || { tail -5 /tmp/m3.txt; fail $LINENO; }; tail -1 /tmp/m3.txt
bash tests/m5_green.sh > /tmp/m5.txt 2>&1 || { tail -5 /tmp/m5.txt; fail $LINENO; }; tail -1 /tmp/m5.txt

step "7 live: github-trends.json + page lines + screenshot"
L=$(curl -s "$SITE/github-trends.json")
echo "$L" | jq -e --arg v "$(cat method/VERSION)" '.schema=="worldtree.github/1" and .method_version==$v' > /dev/null || fail $LINENO
[ "$(echo "$L" | sha256sum | cut -d' ' -f1)" = "$(sha256sum out/github-trends.json | cut -d' ' -f1)" ] || fail $LINENO
c=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/data/out/github-trends.provenance.json"); [ "$c" = 200 ] || fail $LINENO
echo "live github-trends.json = out/ (sha256), /data/out/github-trends.provenance.json 200"
curl -s "$SITE/world-tree.html" | grep -q "github-trends.json" || fail $LINENO; echo "live page fetches github-trends.json"
R=$(node tests/shot_github.cjs "$SITE/world-tree.html?m6=$(date +%s)" "$SHOT" 1200)
echo "$R"
echo "$R" | jq -e '.info.rel >= 5 and .info.com >= 3 and (.errs|length)==0' > /dev/null || fail $LINENO
echo "screenshot $SHOT"

echo "M6 GITHUB GREEN"
