# Storage schema — `~/Work/bifrost/lab/worldtree-data/`

> Relocated 10-04 from `~/Work/lab/worldtree-data` into the bifrost repo
> (subtree merge, history preserved). Git tracks docs/design/code only;
> `raw/ series/ runs/ out/ manifest.json` are gitignored but live on disk
> inside the repo dir, so box backups cover them. Everything below otherwise
> unchanged.

Plain files in git. CSV (RFC 4180, UTF-8, `\n`, header row, `.` decimal, ISO
dates) and JSON (UTF-8, 1-space indent, sorted keys for files we generate).
Everything an agent needs is answerable with `jq`, `grep`, `sqlite3`, `duckdb`.

## 1. Layout
```
worldtree-data/
├── README.md                  # 10 lines: what this is, link to bifrost/docs/worldtree/
├── manifest.json              # index of every file below (§4); rewritten each run
├── catalog/
│   ├── sources.json           # machine form of sources.md (core + M3 rows)
│   ├── series.csv             # series registry (§3.1)
│   └── mapping.csv            # realm ← series ← transform ← weight (§3.2) = method input
├── method/
│   ├── VERSION                # "0.1.0"
│   └── CHANGELOG.md           # one entry per version (prediction.md §6)
├── raw/<source_id>/<slug>/    # APPEND-ONLY. never edited, never deleted
│   ├── <YYYYMMDDTHHMMSSZ>.<ext>             # bytes exactly as received
│   ├── <YYYYMMDDTHHMMSSZ>.<ext>.prov.json   # sidecar (§2)
│   └── fetch-log.csv          # every attempt, stored or not (§3.4)
├── series/<series_id>.csv     # DERIVED, regenerable from raw (§3.3)
├── runs/<run_id>/             # one dir per pipeline run (run_id = YYYYMMDDTHHMMSSZ)
│   ├── provenance.json        # full per-number trail (prediction.md §5)
│   ├── realms.json            # what would be / was published
│   └── gates.json             # every gate evaluated, pass/fail + reason
├── out/                       # last PUBLISHED run only (copied from runs/)
│   ├── realms.json            # page contract (prediction.md §4)
│   ├── realms.provenance.json # = runs/<run_id>/provenance.json
│   └── history.csv            # one row per run (§3.5)
├── wt/                        # pipeline code (M2), stdlib-only Python
└── tests/fixtures/            # frozen raw set + expected realms.json per method version
```
Rules
- `<slug>`: OWID slug, WB indicator code, Wikipedia article, `notable_ai_models`
  for Epoch. Lower-case except where the upstream id is case-sensitive.
- **Dedupe:** after fetching, if sha256 equals the newest stored file in that
  slug dir, do not store; append a fetch-log row with `stored=0`. Raw dirs grow
  only when upstream data changes.
- **Size cap:** no raw file > 25 MB is committed (none of the core sources come
  close; largest is OWID poverty ≈ 2.2 MB). Over-cap sources (e.g. `aiid`) store
  sidecar + derived counts only, `stored_bytes: false` in the sidecar.
- **Budget:** working tree ≤ 1 GB. Epoch (2.2 MB, changes most days) is
  fetched weekly → ≈ 115 MB/yr; git delta-packs the history. Revisit at 500 MB.
- Single writer: every run under `flock /tmp/worldtree-data.lock`.
- One git commit per run: `run <run_id>: published|held — <first gate failure>`.

## 2. Provenance sidecar — `<raw file>.prov.json`
Exact fields (all required; `null` allowed where marked):
```json
{
 "schema": "worldtree.prov/1",
 "path": "raw/owid/life-expectancy/20261003T120000Z.csv",
 "source_id": "owid",
 "slug": "life-expectancy",
 "url": "https://ourworldindata.org/grapher/life-expectancy.csv?v=1&csvType=full&useColumnShortNames=true",
 "final_url": "https://ourworldindata.org/grapher/life-expectancy.csv?v=1&csvType=full&useColumnShortNames=true",
 "request_headers": {"User-Agent": "worldtree-data/0.1 (+https://veraldar.org; dweeb.xyz@gmail.com)"},
 "retrieved_at": "2026-10-03T12:00:00Z",
 "http_status": 200,
 "content_type": "text/csv",
 "bytes": 605252,
 "stored_bytes": true,
 "sha256": "<64 hex of the file bytes>",
 "license": "CC BY 4.0",
 "license_url": "https://creativecommons.org/licenses/by/4.0/",
 "attribution": "UN WPP (2024); HMD (2025); Zijdeman et al. (2015) – with major processing by Our World in Data",
 "upstream_updated": "2025-07-15",
 "upstream_next_update": "2026-07-15",
 "fetcher": "wt.fetch 0.1.0"
}
```
- `attribution`: OWID → `citationShort` of the value column from the metadata
  file; others → fixed string from `catalog/sources.json`.
- `upstream_updated` / `upstream_next_update`: OWID metadata `lastUpdated` /
  `nextUpdate`; World Bank page-0 `lastupdated`; else `null`.
- OWID metadata JSON is fetched in the same run and stored as its own raw file
  (`<ts>.metadata.json` + sidecar) in the same slug dir.
- Invariant (checked every run): `sha256sum <path>` == sidecar `sha256`.

## 3. Tables

### 3.1 `catalog/series.csv`
| column | type | meaning |
|---|---|---|
| `series_id` | str | `<source_id>.<name>`, e.g. `owid.extreme_poverty` |
| `source_id` | str | key in `catalog/sources.json` |
| `slug` | str | raw dir name (§1) |
| `extract` | str | how to get (period,value) from raw: `owid:entity=World;col=<value col>`, `wb:WLD`, `wiki:monthly`, `epoch:<derivation>` (derivations defined in prediction.md §2) |
| `unit` | str | `%`, `years`, `count`, `FLOP`, `views`, `index 0-1`, `US$` |
| `cadence` | enum | `annual`, `monthly`, `daily` (granularity of `period`) |
| `max_age_days` | int | staleness limit: today − `date` of newest row (prediction.md §5.1) |
| `stage` | enum | `core`, `m3`, `candidate` |
| `label` | str | short human name, used in `top`/`feeds` |

### 3.2 `catalog/mapping.csv`  (method input — the table in prediction.md §2)
`realm,series_id,direction,weight,transform,params,dimension,rationale`
- `direction`: `+1` (higher/rising supports realm) or `-1`.
- `weight`: `1` attention/weak proxy · `2` strong proxy · `3` direct measure.
- `transform`: `rank_delta`, `rank_level`, `logistic_delta` (prediction.md §3).
- `params`: `k=v;k=v` (e.g. `h=12;agg=mean3;diff=log`).
- `dimension`: `tech|geopolitics|economy|environment|society` (feeds `realms.json.dimensions`).
- `rationale`: one sentence, quoted.
- A series may map to ≤ 2 realms (opposite directions allowed).

### 3.3 `series/<series_id>.csv`
`period,date,value,snapshot_sha256`
- `period`: `2025` | `2025-09` | `2025-09-30` (matches cadence).
- `date`: period end (`2025-12-31`, `2025-09-30`, `2025-09-30`) — used for staleness.
- `value`: float, upstream unit, no rescaling.
- `snapshot_sha256`: raw file the row was read from (latest stored snapshot).
- Sorted by `date` ascending; regenerated whole each run (deterministic).

### 3.4 `raw/<source_id>/<slug>/fetch-log.csv`
`attempted_at,url,http_status,bytes,sha256,stored,error`
(`stored` 1|0; `error` empty or short message). Append-only.

### 3.5 `out/history.csv`
`run_id,updated,method_version,published,utopia,divergence,drift,control,terminus,stagnation,transcendence,first_gate_failure`
`published` is `1|0`. All runs, published or held, appended.

## 4. `manifest.json` spec
Rewritten at the end of every run (generated, sorted keys). Exact fields:
```json
{
 "schema": "worldtree.manifest/1",
 "generated_at": "2026-10-03T12:00:41Z",
 "method_version": "0.1.0",
 "repo_commit": "<git HEAD before this run's commit, or null>",
 "last_run": {"run_id": "20261003T120000Z", "published": true, "first_gate_failure": null},
 "last_published": {"run_id": "20261003T120000Z", "updated": "2026-10-03T12:00:41Z"},
 "sources": {
  "owid": {"license": "CC BY 4.0", "snapshots": 18, "last_retrieved_at": "2026-10-03T12:00:03Z", "last_status": 200}
 },
 "raw": [
  {"path": "raw/owid/life-expectancy/20261003T120000Z.csv", "sha256": "…", "bytes": 605252,
   "source_id": "owid", "slug": "life-expectancy", "retrieved_at": "2026-10-03T12:00:03Z"}
 ],
 "series": [
  {"series_id": "owid.life_expectancy", "path": "series/owid.life_expectancy.csv", "sha256": "…",
   "rows": 74, "first_period": "1950", "last_period": "2023", "last_date": "2023-12-31",
   "snapshot_sha256": "…", "stale": false}
 ],
 "runs": [
  {"run_id": "20261003T120000Z", "path": "runs/20261003T120000Z/", "published": true, "first_gate_failure": null}
 ],
 "out": {
  "realms": {"path": "out/realms.json", "sha256": "…", "run_id": "20261003T120000Z"},
  "provenance": {"path": "out/realms.provenance.json", "sha256": "…"},
  "history": {"path": "out/history.csv", "rows": 1}
 }
}
```
`raw` lists every stored raw file ever (append-only mirror of the tree);
`runs` lists every run. Invariant: every `raw[].path` exists and hashes to `sha256`.

## 5. Agent query contract
Any agent, from the repo root, with only a shell (every command below was run against a mock tree on 2026-10-03). These commands are part of
the contract: M2 `plan.md` step 8 runs them; changing field names they rely on
is a **major** method/schema bump.

```bash
cd ~/Work/bifrost/lab/worldtree-data

# current numbers (what the page shows)
jq '.weights' out/realms.json

# why is terminus where it is — per-indicator trail
jq '.realms.terminus | {weight, evidence, coverage,
     used: [.indicators[] | {series_id, score, weight, direction, latest_period, source_url}],
     excluded}' out/realms.provenance.json

# which series feed a realm, with weights and rationale
grep -E '^terminus,' catalog/mapping.csv
column -s, -t < catalog/mapping.csv | less -S

# verify the raw trail of every published number (all lines must say OK)
jq -r '.realms[].indicators[].snapshot | "\(.sha256)  \(.path)"' out/realms.provenance.json \
  | sort -u | sha256sum -c

# verify every raw file in the repo against the manifest
jq -r '.raw[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum -c --quiet && echo ALL-RAW-OK

# what is stale / excluded right now
jq '[.series[] | select(.stale)] | map(.series_id)' manifest.json
jq '.realms | to_entries | map({realm: .key, excluded: .value.excluded})' out/realms.provenance.json

# a series' recent values
tail -n 5 series/wb.unemployment.csv

# sqlite3 (preinstalled)
sqlite3 :memory: -cmd '.mode csv' -cmd '.import series/owid.extreme_poverty.csv s' \
  'select period, value from s order by date desc limit 5;'

# duckdb, no install needed (uv fetches it)
uv run --quiet --with duckdb python -c "import duckdb; print(duckdb.sql(\"select realm, count(*) n, sum(weight) w from 'catalog/mapping.csv' group by realm order by realm\"))"

# duckdb across all series at once
uv run --quiet --with duckdb python -c "import duckdb; print(duckdb.sql(r\"select regexp_extract(filename, 'series/(.*)[.]csv', 1) id, max(date) last_date from read_csv('series/*.csv', filename=true, union_by_name=true) group by 1 order by 2\"))"

# pandas: history of the seven numbers
uv run --quiet --with pandas python -c "import pandas as pd; \
  print(pd.read_csv('out/history.csv').query('published==1').tail(10))"

# what changed between two runs
diff <(jq -S .weights runs/A/realms.json) <(jq -S .weights runs/B/realms.json)
```
