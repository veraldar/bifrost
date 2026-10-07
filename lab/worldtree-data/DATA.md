# Veraldar world-tree — open data

Everything behind the seven realm percentages on https://veraldar.org, refreshed
nightly (14:30 Europe/Berlin). This directory mirrors the pipeline repo layout
(`lab/worldtree-data`), so every command below runs unchanged on a download.

## What is here
| path | what |
|---|---|
| `series/<series_id>.csv` | every input series: `period,date,value,snapshot_sha256` (sha256 of the raw source file the row came from) |
| `catalog/series.csv` | series registry: source, unit, cadence, staleness limit, label |
| `catalog/mapping.csv` | which series feeds which realm, direction, weight, transform, rationale |
| `catalog/sources.json`, `catalog/realms.static.json` | source licenses/URLs; realm colours + definitions |
| `method/` | `VERSION`, `CHANGELOG.md`, `refresh.json` (refresh cadence), `geography.json` (who each source covers) |
| `manifest.json` | index of every raw snapshot (sha256, bytes, retrieved_at), series, run |
| `out/realms.provenance.json` | per-number trail of today's weights: every indicator's score, contribution, series + raw sha256, source URL, license |
| `out/realms-history.json` | per-year weights 2015 → now (schema `worldtree.history/1`): coverage, `provisional` flags, gates |
| `out/realms-history.provenance.json` | the per-year indicator trail; each year's blob sha256 is in `realms-history.json` |
| `out/github-trends.json` | AI-ecosystem evolution speed (schema `worldtree.github/1`): releases/year, commits/month, star snapshots, per-repo detail |
| `out/github-trends.provenance.json` | every GitHub raw file those numbers read (path, sha256, url, retrieved_at) |

Today's weights themselves: https://veraldar.org/realms.json (page contract; carries
`refresh`, `geography` and a `history` {file, sha256} pointer).

## Sources
| source | series | cadence | license |
|---|---|---|---|
| Our World in Data | `owid.*` (8) | annual / monthly / daily | CC BY 4.0 |
| World Bank | `wb.*` (2) | annual | CC BY 4.0 |
| Epoch AI | `epoch.*` (4) | monthly | CC BY 4.0 |
| Wikimedia pageviews | `wiki.*` (6) | monthly | CC0 1.0 |
| arXiv · PubMed · Federal Register · NOAA GML | `arxiv.cs_ai`, `pubmed.ai_biomed`, `fedreg.ai_documents`, `noaa.co2` | monthly | CC0 1.0 (metadata) / public domain |
| Mac Studio ARI pipeline | `ari.index` — Agent Restriction Index, weekly 0-100 (control realm) | weekly | dweeb.xyz Agent Restriction Index — verbatim capture, © pipeline output, methodology at report §method |

| GitHub (api.github.com, keyless) | `github.releases_year` (divergence + transcendence), `github.commits_month` (divergence), `github.stars_snapshot` (not mapped) | annual / monthly / nightly | GitHub ToS — counts are facts; metadata via public API |

**GitHub — AI evolution speed** (method 0.4.1). Twelve repos, one reason each (`wt/github.py` `REPOS`):
tensorflow, pytorch, jax, transformers, vllm, ollama, llama.cpp, openai-python,
anthropic-sdk-python, llama-models, Qwen3, langchain. `releases_year` = published releases
per calendar year summed over the repos whose full release history is stored (llama.cpp:
one release per CI build, langchain: one per package version — excluded from releases,
kept for commits + stars); extra columns `n_repos`, `n_prerelease`, `median_gap_days`.
`commits_month` = default-branch commits by committer date via the keyless search API
(`total_count`, cross-checked equal to the commits-list Link-header count: vllm 2025-01 =
413 both); a month appears only once all 12 repos have a count. `stars_snapshot` =
Σ stargazers each night + one column per repo — growth is observed from 2026-10 on;
star history before that is not reconstructed, so stars are not world-mapped.
Keyless limits (no token, by design): 60 core req/h + 10 search req/min per IP — the
nightly fetch spends ≤ 45 core + ≤ 150 search requests; anything left is fetched the next
night, never left as a hole. Bias B15: the repo set is 2026's winners picked in 2026
(survivorship) and repos born after 2019 add to totals from their first release —
ecosystem growth includes repo births by design. Releases ≠ capability.

`series/ari.index.csv` carries extra columns after the standard four: `s` (weighted
event points of the week), `n` (events), `p` (partial-week flag), `pts_<component>`
and `n_<component>` for os_restriction ×3, platform_ban ×3, datacenter_backlash ×2,
safety_exit ×2, legal_wall ×1. One row per week, `date` = week end (Sunday).
Attribution: *Agent Restriction Index (ARI), dweeb.xyz — weekly index of restriction
pressure on AI agents; methodology (component weights, K calibration, Mann-Kendall
trend) at the report's §method section, cited in every raw sidecar
(`methodology_url`).*

## Why
The tree is a claim about where the world is heading. A claim from open data
should ship its data: anyone can recompute, audit, or disagree with a number.

## Licenses
Derived files inherit their source's license — see `catalog/sources.json` and
the `license` field on every indicator in the provenance files: Our World in
Data CC BY 4.0, World Bank CC BY 4.0, Epoch AI CC BY 4.0, Wikimedia CC0 1.0,
arXiv metadata CC0 1.0, PubMed / Federal Register / NOAA GML public domain (US
gov), Agent Restriction Index © dweeb.xyz pipeline output (attribution above),
GitHub counts = facts via the public API (GitHub ToS). Attribute the upstream source when you reuse a series. Raw source files
are not mirrored here (size); `manifest.json` lists them with sha256 and URL.

## History honesty
Each history year is the same method run with observations dated on/before
that year's Dec-31 — no lookahead in observation dates. Values are today's
vintage (later revisions included). Early years are thin on AI-specific
series (arXiv/PubMed/Federal Register start 2019-01, Wikimedia 2015-07, Epoch
2015-01); a realm with < 50 % mapped-weight coverage that year is
`provisional: true`. A year's series as the method saw it =
`awk -F, 'NR==1 || $2 <= "<YYYY>-12-31"' series/<id>.csv`.

## How to query
```bash
# current numbers (what the page shows)
curl -s https://veraldar.org/realms.json | jq '.weights'

# why is terminus where it is — per-indicator trail
jq '.realms.terminus | {weight, evidence, coverage,
     used: [.indicators[] | {series_id, score, weight, direction, latest_period, source_url}],
     excluded}' out/realms.provenance.json

# the trend: one line per year, provisional realms marked
jq -r '.years[] | "\(.year) \(.weights | to_entries | map("\(.key) \(.value)") | join(" ")) provisional: \(.provisional | to_entries | map(select(.value).key) | join(","))"' out/realms-history.json

# which series feed a realm, with weights and rationale
grep -E '^terminus,' catalog/mapping.csv

# verify the series files against the manifest
jq -r '.series[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum -c --quiet && echo SERIES-OK

# verify the history provenance file
jq -r '.provenance.sha256' out/realms-history.json; sha256sum out/realms-history.provenance.json

# a series' recent values
tail -n 5 series/wb.unemployment.csv

# sqlite3
sqlite3 :memory: -cmd '.mode csv' -cmd '.import series/owid.extreme_poverty.csv s' \
  'select period, value from s order by date desc limit 5;'

# duckdb
uv run --quiet --with duckdb python -c "import duckdb; print(duckdb.sql(\"select realm, count(*) n, sum(weight) w from 'catalog/mapping.csv' group by realm order by realm\"))"
```

## Country layer (expansion 2026-10-04, method 0.4.0)
- `countries.json` (also at https://veraldar.org/countries.json): per-country realm levels 0-100 = weighted cross-sectional percentile (country vs all reporting countries; latest value within 7y; no lookahead; provisional where coverage < 0.5). World tree percentages in realms.json are computed separately.
- New geo series (prefix `geo` column): `wb.*` (World Bank, country=all), `owid_geo.*` (OWID grapher country panels), `unsdg.*` (UN SDG API), `who.*` (WHO GHO OData). 25 indicators, ~190 countries.
- Map outlines: `countries-paths.json` — Natural Earth 110m (public domain), simplified to 57KB.
- Honest limits: WB WGI (.EST) not served by API v2; SM.POP.REFG archived; SDG 2.1.2 code returns 0 rows; WHO MMR_4 404; small states with data but no 110m outline (HKG, LUX, PRI, CPV, …) are scored and listed, not drawn. Full ceiling: docs/worldtree/expansion-ceiling.md.

## Provenance standards mapping (PATH A, dual-path 2026-10-05)
- `datapackage.json` (frictionless spec): machine-readable descriptor of every file in /data/ — path, mediatype, sha256, package licenses+sources. Any frictionless/standard tooling can ingest this directory unmodified.
- W3C PROV mapping: entity = raw snapshot file (sha256 sidecar); activity = `wt fetch` / `wt run` / `wt history` (fetch-log.csv + runs/<id>/gates.json); agent = upstream source (attribution + license per sidecar). Our sha-chain IS the PROV subset that fits plain files; no graph store needed.
- OWID-style origins: each series carries upstream citation in its sidecar `attribution` (OWID metadata `citationShort`, WB source line, Epoch CC-BY line) — same idea as OWID grapher `origins`, stored per snapshot instead of per chart.
