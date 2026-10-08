# Veraldar world-tree — open data

Everything behind the seven realm percentages on https://veraldar.org, refreshed
nightly (14:30 Europe/Berlin). This directory mirrors the pipeline repo layout
(`lab/worldtree-data`), so every command below runs unchanged on a download.

## What the percentages mean (and what they don't)
- **An evidence share, not a probability.** Each indicator is ranked against its
  own history (0.5 = moving as usual for itself); a realm's evidence is the
  weighted mean of its indicators' scores, shrunk toward 0.5 when few indicators
  feed it; the seven are then scaled to sum to 100. If every indicator moved as
  usual, every realm would read **14.3 %** (100/7). "terminus 17.2 %" says its
  indicators are moving its way faster than their own past, more than the other
  realms' are — not that terminus has a 17 % chance, and not that it is likely.
- **Unusual for itself, not good or bad.** A decades-long trend (poverty
  falling) is the baseline, not evidence; a rebound after a shock reads as a
  gain (B17).
- **Two kinds of indicator.** `catalog/series.csv` column `measures` says what
  each series measures: `ai` (it would not exist without machine intelligence —
  Epoch models, GitHub AI repos, arXiv cs.AI, AI rulemaking, AI attention, the
  ARI…) or `world` (the condition of the world AI lands in — war deaths,
  unemployment, CO₂, poverty, life expectancy, GDP, democracy, Lean repos);
  `norm` marks denominators. The headline `weights` use both. `modes.strict` in
  realms.json is the same method on the `ai` indicators only — the page's STRICT
  AI lens (method 0.6.0). On 2026-10-08 terminus led the headline on war deaths
  (UCDP, near a 30-year high); no AI-specific indicator fed it (AI x-risk
  attention is excluded, short history), so under STRICT AI it sits at neutral
  (bias B18).
- **The measurable world, not the world.** The indicator set is what can be
  counted free, keyless and openly licensed. Not measured at all: culture and
  meaning, the quality of institutions (World Bank WGI is not served by API v2),
  robotics, energy breakthroughs (solar/nuclear appear only per country), AI
  incidents and harms, AI's own effect on jobs (unemployment counts every job
  lost, whatever the cause), compute supply and chips, education outcomes.
  Absent dimensions pull nothing toward any realm; they are simply not in the
  picture.

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
| `out/github-trends.json` | AI-ecosystem evolution speed (schema `worldtree.github/1`): releases/year, commits/month, star snapshots, per-repo detail; since method 0.5.0 an additive `tools` block (new AI-tool repos per month by topic and per year, new Lean repos per month, mathlib4 commits per month, tool-layer stars, notes) |
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

| GitHub (api.github.com, keyless) | `github.releases_year` (divergence + transcendence), `github.commits_month` (divergence), `github.stars_snapshot` (not mapped); tools (0.5.0): `github.tool_repos_month` (divergence + transcendence), `github.lean_repos_month` (utopia), `github.mathlib_commits_month` + `github.tool_stars_snapshot` (not mapped); 0.6.0: `github.all_repos_month` (normaliser) | annual / monthly / nightly | GitHub ToS — counts are facts; metadata via public API |

**GitHub — how to read the × (method 0.6.0, M8 review).** Releases/year 2019 → 2025 is
×8.0 (45 → 362), but the repo set was picked in 2026 (B15): only 3 repos (tensorflow,
pytorch, transformers) released in both years, and they went 45 → 73 (×1.6); 289 of 2025's
362 releases come from repos with no 2019 release. 265 of 2025's releases (73 %) were cut
by automation — GitHub App bots (author type Bot: stainless-app[bot], github-actions[bot],
openai-sdks[bot]) and the stainless-bot machine account — counted, and disclosed per year
as `n_bot` / `bot_releases`. GitHub itself grew: every new public repo a month
(`github.all_repos_month`, forks excluded, `q=is:public+created:<month>`) went ×1.14 a year
2023→24, ×1.40 2024→25, ×2.25 2025-09→2026-09 (5.35 M → 12.03 M). Since 0.6.0 the tool and
Lean repo counts are scored as a share of it (`norm=github.all_repos_month`, per million
new repos), like the Wikipedia attention series are scored per million en.wiki views: the
AI-tool share grew ×5.9 in those 12 months (raw count ×13.4), scoring 0.75 instead of 0.97.

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
nightly fetch (one a night) spends ≤ 45 core + ≤ 150 search requests and ≤ 8 minutes
of search; anything left is fetched the next night, never left as a hole. Bias B15: the repo set is 2026's winners picked in 2026
(survivorship) and repos born after 2019 add to totals from their first release —
ecosystem growth includes repo births by design. Releases ≠ capability.

**GitHub — the tools are evolving too** (method 0.5.0). The model curves above measure
the AI stack; these measure the tool ecosystem co-evolving with it — the variable that
unlocks what a model can do. All keyless, inside the same nightly budget.
`tool_repos_month` = new public repositories (forks excluded) created each month carrying
an AI-tool topic, one search `total_count` per topic-month since 2019-01: `topic:llm`,
`topic:ai-agents`, `topic:mcp`, `topic:ai-tools`; value = the sum, extra columns
`topic_llm, topic_ai_agents, topic_mcp, topic_ai_tools`. Search has no OR across
topics, so a repo carrying two of them counts twice (probe 2025-06: 175 repos carry both
mcp and llm, against 1,082 mcp and 1,931 llm). `lean_repos_month` = new repositories
whose primary language is Lean (formal mathematics, the medium AI provers work in).
`mathlib_commits_month` = leanprover-community/mathlib4 commits per month (its 2023
peak is the mathlib3 → 4 port, so it is drawn as velocity, not mapped).
`tool_stars_snapshot` = nightly stars of 15 tool-layer repos (MCP servers, SDKs and
registry; LangGraph, LlamaIndex, CrewAI, AutoGen, OpenAI Agents SDK, smolagents,
browser-use; the tool-use benchmarks BFCL/gorilla, τ²-bench, SWE-bench; mathlib4) —
growth observed from 2026-10 on, not mapped. Mapping: tool repos → divergence (weight
2: anyone building, not the few) + transcendence (weight 1: the unlock); Lean repos →
utopia (weight 1: tools for attacking hard problems spreading); each is a 12-month log
growth ranked against its own last 60 months. Bias B16 (self-tagged topics): owners
add topics whenever they like — counts are what GitHub returns at retrieval; each month
is fetched once and the last complete month re-checked nightly, so older months have
had longer to be tagged (understates growth) and deleted repos vanish from every month;
`topic:mcp` repos created before 2024-11 (MCP's release) are older AI projects that
added MCP later (dify, open-webui, LibreChat… — 372 created 2021–2023). Dropped after probing, never fabricated: the official MCP registry
(registry.modelcontextprotocol.io) is keyless but has no count endpoint — sizing it
takes a full cursor crawl each time (10-08 probe: ≥ 23,000 servers over 230 pages of 100 in
23 min, then an HTTP 500 mid-crawl), so `topic:mcp` + the MCP
repos' stars carry the MCP ecosystem; mathlib3 (2017–2023, archived) is a different
repository — splicing it onto mathlib4 would draw the port as growth — so mathlib
velocity starts with mathlib4 (2021-05); tool-use benchmark release cadence (BFCL/gorilla
8 releases 2023–25, τ²-bench 5, SWE-bench 0) is too sparse to be a series — their stars
ride `tool_stars_snapshot`.

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

## Country layer (expansion 2026-10-04, method 0.4.0; corrected 0.6.0)
- `countries.json` (also at https://veraldar.org/countries.json): per-country realm levels 0-100 = weighted cross-sectional percentile (country vs all reporting countries; latest value within 7y; no lookahead; provisional where coverage < 0.5). World tree percentages in realms.json are computed separately. None of the country indicators measures AI: they are the conditions each future would land in, as levels, not directions. Recomputed every night since 0.6.0 (it was rebuilt only by gate runs before).
- 0.6.0 corrections: (1) the three stagnation rows (R&D % of GDP, researchers per million, resident patents) carried direction +1 while their rationales call them evidence *against* the stall — the atlas ranked South Korea, Sweden, Japan, Germany and the US as the most stagnant; now −1. (2) Absolute totals (patents, high-tech exports US$, solar and nuclear TWh, terrorism and natural-disaster deaths) are ranked per person (`percap=wb.SP_POP_TOTL`, World Bank population, same country and year, nearest year within 7 if missing) — before, transcendence (high-tech exports alone) ranked China, Germany, the US first by economy size. (3) +1 indicator: deaths in armed conflicts where they occurred (OWID/UCDP per country, per person) → terminus w2, so the war deaths driving the world tree's terminus are visible country by country. Still thin: transcendence rests on one indicator, drift on none (no country is scored for drift).
- New geo series (prefix `geo` column): `wb.*` (World Bank, country=all), `owid_geo.*` (OWID grapher country panels), `unsdg.*` (UN SDG API), `who.*` (WHO GHO OData). 26 indicators (0.6.0), ~190 countries; `wb.SP_POP_TOTL` is the per-capita denominator, not scored.
- Map outlines: `countries-paths.json` — Natural Earth 110m (public domain), simplified to 57KB.
- Honest limits: WB WGI (.EST) not served by API v2; SM.POP.REFG archived; SDG 2.1.2 code returns 0 rows; WHO MMR_4 404; small states with data but no 110m outline (HKG, LUX, PRI, CPV, …) are scored and listed, not drawn. Full ceiling: docs/worldtree/expansion-ceiling.md.

## Provenance standards mapping (PATH A, dual-path 2026-10-05)
- `datapackage.json` (frictionless spec): machine-readable descriptor of every file in /data/ — path, mediatype, sha256, package licenses+sources. Any frictionless/standard tooling can ingest this directory unmodified.
- W3C PROV mapping: entity = raw snapshot file (sha256 sidecar); activity = `wt fetch` / `wt run` / `wt history` (fetch-log.csv + runs/<id>/gates.json); agent = upstream source (attribution + license per sidecar). Our sha-chain IS the PROV subset that fits plain files; no graph store needed.
- OWID-style origins: each series carries upstream citation in its sidecar `attribution` (OWID metadata `citationShort`, WB source line, Epoch CC-BY line) — same idea as OWID grapher `origins`, stored per snapshot instead of per chart.
