#!/usr/bin/env bash
# M10 tools (briefs/M10-tools.md, method 0.5.0): the tool ecosystem co-evolving with the models — parse fixtures,
# budget guard, series in stored data w/ sidecars, the growth curve printed, world mapping rows live, the older gates
# still green, live page TOOLS block + screenshot. Prints M10 TOOLS GREEN.
set -e
cd "$(dirname "$0")/.."
step() { echo "== $*"; }
fail() { echo "FAIL line $1" >&2; exit 1; }
SITE=https://veraldar.org
SHOT=~/Work/bifrost/artifacts/worldtree-tools.png

step "1 unit tests (frozen search-repos page, url round-trip, every-topic rule, newest-wins, tools block, budget order)"
python3 -m unittest tests.test_tools 2>&1 | grep -q '^OK$' || fail $LINENO; echo "test_tools OK"
python3 -m unittest tests.test_github 2>&1 | grep -q '^OK$' || fail $LINENO; echo "test_github OK"

step "2 budget guard (keyless: ≤ 45 core + ≤ 150 search a night; 403/429 stops the bucket; the rest next night)"
python3 - <<'PY'
import datetime as dt
from wt import github as GH
from wt.fetch import GH_ORDER, GH_SLEEP, wiki_end
assert (GH.CORE_BUDGET, GH.SEARCH_BUDGET) == (45, 150) and GH_SLEEP == {"core": 1.0, "search": 6.5}
core = len(GH.REPOS) + len(GH.TOOL_REPOS)
assert core <= GH.CORE_BUDGET, core
print(f"nightly snapshots {core} core (12 model-stack + {len(GH.TOOL_REPOS)} tool-layer stars) ≤ {GH.CORE_BUDGET}; "
      f"search re-check {len(GH.REPOS) + len(GH.COUNTS['tool_repos'][0]) + 2}/night ≤ {GH.SEARCH_BUDGET} at ≥ 6.5 s")
print("order:", " → ".join(sorted(GH_ORDER, key=lambda k: (GH_ORDER[k], k))))
PY
grep -h "budget used" nightly.log | tail -1 || true

step "3 stored data w/ provenance sidecars (sha256, url, license) + series"
python3 - <<'PY'
import glob, hashlib, json
n = {}
for kind in ("tool_repos", "lean_repos", "mathlib", "tool_stars"):
    for sc in glob.glob(f'raw/github/{kind}/*.prov.json'):
        m = json.load(open(sc))
        assert m['schema'] == 'worldtree.prov/1' and m['http_status'] == 200 and m['source_id'] == 'github', sc
        assert m['url'].startswith('https://api.github.com/') and 'GitHub ToS' in m['license'], sc
        assert hashlib.sha256(open(m['path'], 'rb').read()).hexdigest() == m['sha256'], sc
        n[kind] = n.get(kind, 0) + 1
assert set(n) == {"tool_repos", "lean_repos", "mathlib", "tool_stars"}, n
print('sidecars OK', dict(sorted(n.items())))
PY
for f in tool_repos_month lean_repos_month mathlib_commits_month tool_stars_snapshot; do echo "series github.$f $(($(wc -l < series/github.$f.csv) - 1)) rows"; done
for f in tool_repos_month lean_repos_month mathlib_commits_month; do
  [ $(($(wc -l < series/github.$f.csv) - 1)) -ge 93 ] || fail $LINENO  # 2019-01 → 2026-09, no hole
done
[ $(($(wc -l < series/github.tool_stars_snapshot.csv) - 1)) -ge 1 ] || fail $LINENO

step "4 the curve: new AI-tool repos by year (and by topic), Lean, mathlib — growth evidence"
python3 - <<'PY'
import csv, math
from collections import defaultdict
rows = list(csv.DictReader(open('series/github.tool_repos_month.csv')))
T = [c for c in rows[0] if c.startswith('topic_')]
y = defaultdict(lambda: defaultdict(int)); nm = defaultdict(int)
for r in rows:
    k = int(r['period'][:4]); nm[k] += 1; y[k]['all'] += int(r['value'])
    for t in T: y[k][t] += int(r[t])
last = rows[-1]['period']; Y, M = int(last[:4]), int(last[5:7])
print(f"{'year':>6} {'months':>6} {'all 4 topics':>12} " + ' '.join(f"{t[6:]:>10}" for t in T))
for k in sorted(y):
    print(f"{k:>6} {nm[k]:>6} {y[k]['all']:>12,} " + ' '.join(f"{y[k][t]:>10,}" for t in T))
same = lambda yr, t='all': sum(int(r['value'] if t == 'all' else r[t]) for r in rows if r['period'][:4] == str(yr) and int(r['period'][5:7]) <= M)
print(f"like for like, Jan–{M:02d}: 2024 {same(2024):,} → 2025 {same(2025):,} → {Y} {same(Y):,} (×{same(Y)/same(2024):.1f} vs 2024)")
print(f"topic:mcp Jan–{M:02d}: 2024 {same(2024,'topic_mcp'):,} → 2025 {same(2025,'topic_mcp'):,} → {Y} {same(Y,'topic_mcp'):,}"
      f" (×{same(Y,'topic_mcp')/max(1,same(2024,'topic_mcp')):.0f} vs 2024; MCP released 2024-11)")
v = [int(r['value']) for r in rows]
a, b = sum(v[-24:-12]), sum(v[-12:])
print(f"last 12 months {b:,} vs the 12 before {a:,} → ×{b/a:.1f}")
full = sorted(k for k in y if nm[k] == 12 and k >= 2019)
xs, ys = full, [math.log(y[k]['all']) for k in full]
mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
g = sum((p - mx) * (q - my) for p, q in zip(xs, ys)) / sum((p - mx) ** 2 for p in xs)
print(f"log-linear fit {full[0]}–{full[-1]} (complete years): ×{math.exp(g):.2f} a year, doubling every {12*math.log(2)/g:.1f} months")
assert b > 2 * a, (a, b)                                # the curve still bends up: last 12 months > 2× the 12 before
assert y[2025]['all'] > 10 * y[2021]['all']              # an order of magnitude in four years
for sid, lab in (('github.lean_repos_month', 'Lean repos'), ('github.mathlib_commits_month', 'mathlib commits')):
    r = list(csv.DictReader(open(f'series/{sid}.csv')))
    by = defaultdict(int)
    for x in r: by[int(x['period'][:4])] += int(x['value'])
    w = [int(x['value']) for x in r]
    print(f"{lab}/yr: " + ' · '.join(f"{k} {by[k]:,}" for k in sorted(by)) + f" ({r[-1]['period'][:4]} to {r[-1]['period'][5:]})"
          f" · last 12 mo {sum(w[-12:]):,} vs prior 12 {sum(w[-24:-12]):,} (×{sum(w[-12:])/max(1,sum(w[-24:-12])):.1f})")
c = list(csv.DictReader(open('series/github.commits_month.csv')))
m = [int(x['value']) for x in c]
print(f"model stack (12 repos) commits, same idea: last 12 mo {sum(m[-12:]):,} vs prior 12 {sum(m[-24:-12]):,} (×{sum(m[-12:])/sum(m[-24:-12]):.2f})"
      f" — the tools curve vs the model curve, one tab")
s = list(csv.DictReader(open('series/github.tool_stars_snapshot.csv')))
print(f"tool-layer stars Σ{len([k for k in s[0] if k.startswith('stars_')])} repos: {len(s)} night(s), {s[-1]['period']} {int(s[-1]['value']):,}")
PY

step "5 github-trends.json tools block (schema, provenance sha256, every raw file verified)"
python3 - <<'PY'
import hashlib, json
from wt import github as GH
d = json.load(open('out/github-trends.json')); v = open('method/VERSION').read().strip()
assert d['schema'] == 'worldtree.github/1' and d['method_version'] == v == '0.5.0', (d['schema'], v)
t = d['tools']
assert len(t['tool_repos_by_month']) >= 93 and len(t['lean_repos_by_month']) >= 93 and len(t['mathlib_commits_by_month']) >= 93
assert [x['topic'] for x in t['topics']] == list(GH.TOOL_TOPICS) and len(t['stars']) == len(GH.TOOL_REPOS)
assert all(sum(m['by_topic'].values()) == m['repos'] for m in t['tool_repos_by_month'])
assert set(GH.TOOLS_SERIES) <= set(d['provenance']['series'])
p = open('out/github-trends.provenance.json', 'rb').read()
assert hashlib.sha256(p).hexdigest() == d['provenance']['sha256']
files = json.loads(p)['files']; assert len(files) == d['provenance']['raw_files']
for f in files:
    assert hashlib.sha256(open(f['path'], 'rb').read()).hexdigest() == f['sha256'], f['path']
tools = [f for f in files if f['path'].split('/')[2] in ('tool_repos', 'lean_repos', 'mathlib', 'tool_stars')]
print(f"tools block OK · {len(t['tool_repos_by_month'])} months · {len(files)} raw files verified ({len(tools)} tools)")
PY

step "6 world mapping rows live (tool repos → divergence w2 + transcendence w1, Lean → utopia w1; B16) + the move"
python3 - <<'PY'
import json
p = json.load(open('out/realms.provenance.json'))
for realm, sid, w in (('divergence', 'github.tool_repos_month', 2), ('transcendence', 'github.tool_repos_month', 1),
                      ('utopia', 'github.lean_repos_month', 1)):
    R = p['realms'][realm]
    u = [i for i in R['indicators'] if i['series_id'] == sid]
    assert u, (realm, sid, [e for e in R['excluded'] if e['series_id'] == sid])
    i = u[0]
    assert i['weight'] == w and 'B16' in i['bias'] and i['source_url'].startswith('https://api.github.com/search/repositories')
    print(f"{realm:13} {sid:24} w{w} score {i['score']:.2f} (pct {i['pct']}, ref_n {i['ref_n']}, y {i['y_latest']:+.3f} = log 12-mo growth,"
          f" contribution {i['contribution']:+.4f})")
for sid in ('github.mathlib_commits_month', 'github.tool_stars_snapshot'):
    assert not any(i['series_id'] == sid for R in p['realms'].values() for i in R['indicators']), sid
K = list(p['realms'])
old = json.load(open('tests/fixtures/0.4.1/realms.json'))['weights']
fx = json.load(open('tests/fixtures/0.5.0/realms.json'))['weights']
now = {k: p['realms'][k]['weight'] for k in K}
print('weights 0.4.1 fixture  ', ' '.join(f"{k} {old[k]}" for k in K))
print('weights 0.5.0 fixture  ', ' '.join(f"{k} {fx[k]}" for k in K))
print('weights live (out/)    ', ' '.join(f"{k} {now[k]}" for k in K))
print('move (fixture→fixture) ', ' '.join(f"{k} {fx[k]-old[k]:+.1f}" for k in K))
PY

step "7 m3 + m5 + m6_github + m6_countries green"
bash tests/m3_green.sh > /tmp/m3.txt 2>&1 || { tail -5 /tmp/m3.txt; fail $LINENO; }; tail -1 /tmp/m3.txt
bash tests/m5_green.sh > /tmp/m5.txt 2>&1 || { tail -5 /tmp/m5.txt; fail $LINENO; }; tail -1 /tmp/m5.txt
bash tests/m6_github.sh > /tmp/m6g.txt 2>&1 || { tail -5 /tmp/m6g.txt; fail $LINENO; }; tail -1 /tmp/m6g.txt
bash tests/m6_countries.sh > /tmp/m6c.txt 2>&1 || { tail -5 /tmp/m6c.txt; fail $LINENO; }; tail -1 /tmp/m6c.txt

step "8 live: github-trends.json tools block + page TOOLS block + screenshot"
L=$(curl -s "$SITE/github-trends.json?m10=$(date +%s)")
echo "$L" | jq -e '.schema=="worldtree.github/1" and .method_version=="0.5.0" and (.tools.tool_repos_by_month|length)>=93' > /dev/null || fail $LINENO
[ "$(echo "$L" | sha256sum | cut -d' ' -f1)" = "$(sha256sum out/github-trends.json | cut -d' ' -f1)" ] || fail $LINENO
for f in data/series/github.tool_repos_month.csv data/series/github.lean_repos_month.csv data/out/github-trends.provenance.json; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/$f"); [ "$c" = 200 ] || { echo "$f → $c"; fail $LINENO; }
done
curl -s "$SITE/data/catalog/mapping.csv" | grep -q '^divergence,github.tool_repos_month,+1,2,' || fail $LINENO
echo "live github-trends.json = out/ (sha256), tools series + mapping rows on /data/"
curl -s "$SITE/world-tree.html" | grep -q 'id="etools"' || fail $LINENO; echo "live page carries the TOOLS block"
R=$(node tests/shot_tools.cjs "$SITE/world-tree.html?m10=$(date +%s)" "$SHOT" 1200)
echo "$R" | jq -c .info
echo "$R" | jq -e '.info.selected=="AI EVOLUTION" and .info.h2=="The tools are evolving too" and .info.rep==1 and .info.lean==1
  and .info.math==1 and (.info.call|length)>=3 and .info.stars>=1 and (.info.thesis|test("tools curve sits beside the model curves"))
  and (.info.dataLinks|index("/data/")!=null) and .info.modelCharts>=5 and (.errs|length)==0' > /dev/null || fail $LINENO
echo "screenshot $SHOT"

echo "M10 TOOLS GREEN"
