# M2 — pipeline v0 (cut)

Goal, in one line: **4 free sources fetched for real → raw stored append-only
with sidecars → 20 series → 7 percentages with per-number provenance →
`out/realms.json` that the frozen page accepts.** Green = `tests/m2_green.sh`
exits 0 (step 11). The brief's floor is ≥ 2 sources; the plan wires all four
`core` sources because the coverage gate (prediction.md §5.1) holds the run
unless every realm has ≥ 50 % of its mapped weight — fewer sources cannot end
green honestly.

Inputs (read these, nothing else is needed): `README.md`, `sources.md`
(endpoints, UA, rate rules), `schema.md` (layout, sidecar, manifest, query
contract), `prediction.md` (registry, mapping, transforms, gates, provenance).

Out of scope for M2: M3 sources, agent votes (`WT_AGENT_VOTES` unset), the
daily timer, copying to `/var/www/veraldar/` (cutover = user's go, README).

## Conventions
- Repo `R=~/Work/lab/worldtree-data` (exists: `briefs/`, `m0.py` — keep them).
  All commands run from `$R`.
- Code: `wt/` package, **Python ≥ 3.11 stdlib only** (`urllib`, `csv`, `json`,
  `hashlib`, `math`, `datetime`, `unittest`). Entry `python3 -m wt <cmd>`:

  | cmd | does |
  |---|---|
  | `check catalog` | catalog gate (prediction.md §5.1) → prints `catalog OK <n_series> series <n_rows> rows` or exits 1 |
  | `check integrity` | every sidecar: sha256 of file == sidecar → `integrity OK <n>` |
  | `fetch [--source a,b]` | all `core` series of the given/all sources → `raw/` + sidecars + fetch-log, dedupe |
  | `series --as-of D` | raw → `series/*.csv` (prediction.md §1.1) |
  | `run --as-of D [--now ISO] [--no-fetch] [--commit]` | fetch (unless `--no-fetch`) → series → compute → gates → `runs/<run_id>/` → if passed copy to `out/` → append `out/history.csv` → rewrite `manifest.json` → optional git commit. Whole run under `flock /tmp/worldtree-data.lock`. `--now` pins `updated`/`run_id` (tests) |
- Every step below ends with its **verify** block; a step is done only when
  the block prints what is stated. Commit after each green step
  (`git commit -m "M2 step N: …"`). A step failing twice → stop and surface
  (lab-playbook rule 5).

---

### Step 0 — prerequisites + repo
Do: `git init` in `$R`; `.gitignore` (`__pycache__/`, `*.pyc`, `*.tmp`);
create the schema.md §1 dirs; 10-line `README.md` pointing to
`~/Work/bifrost/docs/worldtree/`.
```bash
for t in python3 jq sqlite3 curl git uv flock sha256sum; do command -v $t >/dev/null || echo MISSING $t; done
python3 -c 'import sys; assert sys.version_info >= (3,11); print("py OK")'
git -C ~/Work/lab/worldtree-data rev-parse --is-inside-work-tree
ls -d catalog method raw series runs out wt tests/fixtures
```
Expect: no `MISSING`, `py OK`, `true`, six dirs listed. (Install anything
missing — do not stop on it.)

### Step 1 — re-prove the four sources from this host
Do: `tests/proofs.sh` — one `curl -sSL -A "$UA" -o /dev/null -w '%{http_code} <id>\n'`
per URL below, `UA='worldtree-data/0.1 (+https://veraldar.org; dweeb.xyz@gmail.com)'`:
the 9 OWID `.csv` + 9 `.metadata.json` (slugs in prediction.md §1), the 2 World
Bank codes, `https://epoch.ai/data/notable_ai_models.csv`, the 5 Wikimedia
articles (`…/monthly/20150701/<last day of previous month>`), the Wikimedia
aggregate (`…/aggregate/en.wikipedia/all-access/user/monthly/2015070100/<YYYYMMDD>00`).
```bash
bash tests/proofs.sh | tee /tmp/proofs.txt; grep -vc '^200 ' /tmp/proofs.txt; wc -l < /tmp/proofs.txt
```
Expect: `0` non-200 lines, `27` lines.

### Step 2 — catalog
Do: write `catalog/series.csv` (21 rows: prediction.md §1 table + the
`owid.large_scale_ai_systems` candidate row), `catalog/mapping.csv` (20 rows,
prediction.md §2, header `realm,series_id,direction,weight,transform,params,dimension,rationale`),
`catalog/sources.json` (`{id: {title, license, license_url, attribution, homepage, status}}`
for the 4 core + M3/candidate ids from sources.md; titles: `Our World in Data`,
`World Bank`, `Epoch AI`, `Wikimedia`), `catalog/realms.static.json`
(`colors` + `definitions` copied verbatim from `~/Work/veraldar-site/realms.json`),
`method/VERSION` = `0.1.0`, `method/CHANGELOG.md` first entry. Implement
`wt check catalog`.
```bash
python3 -m wt check catalog
python3 - <<'EOF'
import csv; from collections import Counter
m=list(csv.DictReader(open('catalog/mapping.csv'))); c=Counter()
for r in m: c[r['realm']]+=int(r['weight'])
assert dict(c)=={'utopia':7,'divergence':7,'drift':3,'control':2,'terminus':5,'stagnation':5,'transcendence':4}, c
assert all(r['weight']=='1' for r in m if r['transform']=='logistic_delta')
print('mapping OK', len(m))
EOF
diff <(jq -S '{colors,definitions}' ~/Work/veraldar-site/realms.json) <(jq -S . catalog/realms.static.json) && echo static OK
```
Expect: `catalog OK 21 series 20 rows`, `mapping OK 20`, `static OK`.
Negative check: copy mapping.csv to /tmp, set one `logistic_delta` row to w=2,
`WT_CATALOG=/tmp/... python3 -m wt check catalog` must exit 1.

### Step 3 — fetcher (`wt/fetch.py`)
Do: per series slug → URL from sources.md / prediction.md §1; UA header; 30 s
timeout, 3 tries, backoff 5/15/45 s; Wikimedia end = last day of the previous
month; OWID also fetches `.metadata.json` (stored as `<ts>.metadata.json`);
sidecar exactly per schema.md §2 (`attribution` for OWID = the value column's
`citationShort` in metadata); dedupe on sha256 vs newest file in the slug dir;
append `fetch-log.csv` on every attempt. The 4 Epoch series share one raw
file (`raw/epoch/notable_ai_models/`). Pitfalls observed: Python's default
urllib UA gets **403** from OWID; OWID entity names contain commas and quotes
(`"o3-mini (Jan 2025), medium"`) → always `csv` module; WB `value` may be `null`.
```bash
python3 -m wt fetch
find raw -name '*.prov.json' | wc -l
python3 -m wt check integrity
jq -r '"\(.sha256)  \(.path)"' $(find raw -name '*.prov.json') | sha256sum -c --quiet && echo SIDECARS-OK
jq -e -s 'all(.[]; .schema=="worldtree.prov/1" and .http_status==200 and (.license|length>0) and (.sha256|test("^[0-9a-f]{64}$")))' $(find raw -name '*.prov.json')
n=$(find raw -type f ! -name fetch-log.csv | wc -l); python3 -m wt fetch --source owid,worldbank,wikimedia
m=$(find raw -type f ! -name fetch-log.csv | wc -l); [ "$n" = "$m" ] && echo DEDUPE-OK
grep -h ',0,$' raw/owid/*/fetch-log.csv | wc -l
```
Expect: `27` sidecars (18 OWID + 2 WB + 1 Epoch + 6 Wikimedia),
`integrity OK`, `SIDECARS-OK`, `true`, `DEDUPE-OK`, ≥ 18 `stored=0` rows.

### Step 4 — series (`wt/extract.py`)
Do: prediction.md §1.1 exactly, incl. the as-of drop rule and Epoch
derivations; output `period,date,value,snapshot_sha256` per schema.md §3.3.
```bash
D=$(date -u +%F); python3 -m wt series --as-of $D
ls series/*.csv | wc -l
head -1 series/owid.life_expectancy.csv
for s in owid.life_expectancy owid.conflict_deaths wb.unemployment owid.genai_user_share \
         epoch.open_weights_share epoch.frontier_compute wiki.deepfake wiki.en_total owid.frontiermath_best; do
  printf '%-28s %s\n' $s "$(tail -1 series/$s.csv | cut -d, -f1-3)"; done
awk -F, -v d=$D 'FNR>1 && $2>d {print FILENAME; exit 1}' series/*.csv && echo NO-FUTURE-ROWS
sqlite3 :memory: -cmd '.mode csv' -cmd '.import series/owid.extreme_poverty.csv s' 'select count(*) from s;'
```
Expect (as of 2026-10-03; later runs move forward): `20` files; header
`period,date,value,snapshot_sha256`; life_expectancy `2023`, conflict_deaths
`2025` (not 2026), unemployment `2025`, genai_user_share `2026-03-31,…,17.8`,
open_weights_share / frontier_compute / deepfake / en_total `2026-09`,
frontiermath_best `2026-09,…,93.7…`; `NO-FUTURE-ROWS`; poverty count > 30.

### Step 5 — method (`wt/method.py`) + unit tests
Do: transforms (prediction.md §3), aggregation + mass/coverage + largest
remainder (§4). Pure functions, no I/O. `tests/test_method.py` must contain at
least these hand-computed cases:
- `pct`: R=[1,2,3,4], y*=3 → (2+0.5)/4 = 0.625; dir −1 → 0.375.
- `rank_delta lag=1 diff=log`: series with a missing year → that delta undefined, not interpolated.
- history floor: annual with |R| = 7 → `short_history`.
- `logistic_delta`: d = d0 → 0.5; d = d0 + k → 0.7311 (4 dp).
- `logit` clamp: p = 100 → uses 99.5.
- aggregation: all s = 0.5 → e = 0.5 everywhere; one realm with W_used = 2,
  s = 1 → mass 1/3, e = 0.6667.
- rounding: 7 equal e → `[14.3,14.3,14.3,14.3,14.3,14.3,14.2]` in realm order;
  any random e vector → Σ round(w·10) == 1000.
```bash
python3 -m unittest discover -s tests -p 'test_method.py' -v 2>&1 | tail -3
```
Expect: `OK`, ≥ 7 tests, no skips.

### Step 6 — run: gates, provenance, realms.json (`wt/run.py`)
Do: prediction.md §4.1 (every field), §5.1 gates → `gates.json`
(`[{gate, scope: "run" | "<series_id>@<realm>", pass, reason}]`), §5.2
provenance; on pass copy the three files to `out/` (`realms.json`,
`realms.provenance.json`) and append `out/history.csv` (schema.md §3.5) —
history row is appended on held runs too.
```bash
python3 -m wt run --as-of $(date -u +%F) --no-fetch
RUN=$(ls -1d runs/*/ | tail -1); echo $RUN; ls $RUN
jq -e '[.[] | select(.scope=="run") | .pass] | all' $RUN/gates.json
cmp $RUN/realms.json out/realms.json && cmp $RUN/provenance.json out/realms.provenance.json && echo OUT-COPIED
python3 - <<'EOF'
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
assert n>=12 and len(srcs)>=2, (n,srcs)
x=[e for e in p['realms']['terminus']['excluded'] if e['series_id']=='wiki.ai_xrisk']
print('PROV-OK', n, 'indicators', sorted(srcs), 'xrisk excluded:', x[0]['reason'] if x else 'no')
EOF
tail -1 out/history.csv
```
Expect: run dir with `gates.json provenance.json realms.json`; `true`;
`OUT-COPIED`; `PROV-OK ≥17 indicators ['epoch','owid','wikimedia','worldbank']`;
until ~2026-12 `xrisk excluded: short_history` (proves exclusion on real
data); last history row `published=1`.

### Step 7 — page contract (`tests/check_contract.py`)
Do: a checker that mirrors `world-tree.html` (`setData`/fetch handler) +
the realm contract: JSON object; `weights` has all 7 keys, each a finite
number (the page's own rejection rule); Σ = 100.0 (×10 integer); `updated`
matches `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$` and is ≤ now; `colors` 7 × `#rrggbb`;
`definitions` == `catalog/realms.static.json`; `window` string without
`items`; `world_weights` 7 finite; `dimensions` object of finite numbers;
`top` realm → list[str] ≤ 2; `sources` str → int ≥ 0; `feeds` list of
`{name: str, state: str}` with one entry per distinct mapped series (19).
Prints `CONTRACT OK` or the first violation, exit 1.
```bash
python3 tests/check_contract.py out/realms.json
python3 tests/check_contract.py ~/Work/veraldar-site/realms.json; echo "seed exit=$?"
jq '.weights.drift="x"' out/realms.json > /tmp/bad.json; python3 tests/check_contract.py /tmp/bad.json; echo "bad exit=$?"
jq -r '.window, (.weights|tojson), (.feeds|length)' out/realms.json
```
Expect: `CONTRACT OK`; seed exits 1 (no `feeds`/`world_weights` — proves the
checker is stricter than the page, not that the seed is broken); `bad exit=1`;
window line, 7 weights, `19`.
Browser proof (optional, if a browser tool exists): serve a temp dir with
`world-tree.html` + `out/realms.json`, page badge reads `LIVE`.

### Step 8 — agent query contract
Do: `tests/queries.sh` = every command in schema.md §5 verbatim (except the
`less` pager and the `runs/A`/`runs/B` diff, replaced by the last two run
dirs), `set -euo pipefail`.
```bash
bash tests/queries.sh > /tmp/q.txt 2>&1; echo "exit=$?"
grep -c ': OK$' /tmp/q.txt; grep -c ALL-RAW-OK /tmp/q.txt
```
Expect: `exit=0`; ≥ 4 `: OK` lines (one per distinct snapshot used);
`ALL-RAW-OK` once.

### Step 9 — determinism + frozen fixture
Do: `tests/fixtures/0.1.0/`: `as_of`, `now`, a copy of the `raw/` subtree
referenced by this run's provenance (with sidecars), and expected
`realms.json` + `provenance.json`; `wt run` accepts `WT_ROOT=<dir>` so it can
run against the fixture tree in a temp copy. `tests/test_fixture.py`: copy
fixture to tmp, run, `cmp` both outputs.
```bash
D=$(date -u +%F); N=${D}T06:00:00Z
python3 -m wt run --as-of $D --now $N --no-fetch; cp out/realms.json /tmp/a.json; cp out/realms.provenance.json /tmp/ap.json
python3 -m wt run --as-of $D --now $N --no-fetch; cmp /tmp/a.json out/realms.json && cmp /tmp/ap.json out/realms.provenance.json && echo DETERMINISTIC
python3 -m unittest discover -s tests -p 'test_fixture.py' -v 2>&1 | tail -1
grep -c . out/history.csv
```
Expect: `DETERMINISTIC`, `OK`, history has header + one row per run so far.
(Two runs with the same `--now` share a run_id: the second overwrites
`runs/<run_id>/` byte-identically — allowed, history still gets its row.)

### Step 10 — manifest + commit per run
Do: `manifest.json` per schema.md §4 (sorted keys, 1-space indent); `run
--commit` commits everything with `run <run_id>: published|held — <first gate failure>`.
```bash
python3 -m wt run --as-of $(date -u +%F) --commit
jq -r '.raw[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum -c --quiet && echo ALL-RAW-OK
jq -e '.schema=="worldtree.manifest/1" and .method_version=="0.1.0" and .last_run.published==true and (.series|length)==20' manifest.json
jq -r '.out.realms.sha256' manifest.json | diff - <(sha256sum out/realms.json | cut -d' ' -f1) && echo OUT-HASH-OK
git log -1 --format=%s; git status --porcelain | wc -l
```
Expect: `ALL-RAW-OK`, `true`, `OUT-HASH-OK`, `run <id>: published`, `0`.
Message rule: published → `run <run_id>: published`; held →
`run <run_id>: held — <first failing run gate>`.

### Step 11 — green (the M2 finish line)
Do: `tests/m2_green.sh` = steps 1, 2, 3 (integrity only, no refetch), 5, 6
(PROV-OK script), 7, 8, 9, 10 verifies in order, `set -e`, last line `M2 GREEN`.
Then a fresh live run end to end:
```bash
python3 -m wt run --as-of $(date -u +%F) --commit && bash tests/m2_green.sh | tail -1
jq '{updated, window, weights}' out/realms.json
du -sh .git raw
```
Expect: `M2 GREEN`; the printed weights are the first honest numbers (put
them, the gate summary and `du` in the M2 report); repo well under the 1 GB budget.

---

## Report back (to the coordinator)
`out/realms.json` weights + window, the list of excluded indicators with
reasons, `du -sh`, `git log --oneline | head`, and anything that deviated
from these docs (a deviation that can move a number is a method bump —
record it in `method/CHANGELOG.md`, prediction.md is updated in the same
commit).

## Next (not M2)
M3: wire `pubmed`, `fedreg`, `noaa_gml`, `arxiv` (prediction.md §2 planned
rows → v0.2.0); daily systemd user timer 06:00 UTC (page STALE after 24 h);
cutover to `/var/www/veraldar/realms.json` with agent roots on, after the
user's go.
