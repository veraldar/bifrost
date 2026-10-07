# Dual-path compare — internal inference vs external state-of-the-art (Rule 10-06 pilot)

Date: 2026-10-05/06 · Scope: the worldtree-data pipeline (collection → storage → prediction) as built M0→M6.
PATH A = research the online state-of-the-art first, then build. PATH B = extend from current sources/schema by inference only. Both ran; this doc compares and records the merge.

## What each path produced

### PATH B — internal inference (shipped first: E1→E3, M4→M6)
- Collection: 9 sources (OWID grapher CSVs, World Bank API v2, Epoch AI, Wikimedia pageviews, arXiv/PubMed/Federal Register per-month counts, NOAA GML, user's ARI), 25 country-panel indicators + 20 world series, ~190 countries.
- Storage: plain files, append-only raw snapshots + sha256 sidecars (url, http_status, license, attribution, retrieved_at), series CSVs with snapshot_sha256 per row, manifest.json indexing everything, /data/ mirror of series+catalog+method+out.
- Prediction: world = percentile-vs-own-history with diff transforms, sum-100 largest-remainder; countries = cross-sectional percentile (rank_geo); per-year history with no-lookahead; gates (staleness, coverage, contract) + per-number provenance chains; method semver + CHANGELOG + frozen fixtures.
- Honesty mechanics: provisional flags (coverage < 0.5), excluded-indicator reporting with reasons, published bias register (B1-B13), determinism fixtures byte-identical across method bumps.

### PATH A — external research (this pass: OWID ETL docs, Frictionless Data Package spec, W3C PROV/DCAT, WB API docs)
Findings, each judged against PATH B's design:
1. **OWID ETL**: DAG of URI-addressable steps; every indicator carries `origins` (citation chain per column); name-harmonization as a first-class step; auto-update choreography. → We already have origins-equivalent per snapshot (`attribution` + license in every sidecar) but NOT as a per-indicator first-class field, and our DAG is implicit in code.
2. **Frictionless Data Package**: single `datapackage.json` descriptor (name/title/licenses/sources/resources[path,mediatype,sha256]) makes a directory ingestible by standard tooling. → We had index.txt + DATA.md (human) and manifest.json (our own schema) — no standard descriptor.
3. **W3C PROV / DCAT**: entity/activity/agent triple; DCAT dataset metadata (publisher, license, modified). → Our sha-chain is the entity layer; activity exists as fetch-logs + run gates but unmapped; DCAT fields scattered.
4. **World Bank API v2 docs**: pagination via page/pages (we use per_page=25000 single-shot — correct for our indicator sizes), `source` parameter selects non-WDI databases (the WGI 401/empty mystery explained: .EST codes live in source=3 and return empty via plain queries — our honest drop was right), archived indicators 404 cleanly.
5. **Data Commons**: statistical-variable ontology (stable variable IDs with unit/dimensions). → Our series_id + unit + dimension columns are the same idea, smaller.

## Differences that mattered
| dimension | PATH B (inference) | PATH A (research) | verdict |
|---|---|---|---|
| package descriptor | manifest.json (own schema) + index.txt | frictionless datapackage.json | **A wins** — standard tooling ingests /data/ with zero code |
| provenance | sha-chain + sidecars (stronger than most published pipelines) | PROV/DCAT mapping | **B wins on substance; A wins on vocabulary** — document the mapping, keep the chain |
| per-indicator origins | per-snapshot attribution (finer-grained, actually) | OWID per-column origins | **tie** — B's per-snapshot is strictly more precise; A's naming adopted in DATA.md |
| source quirks | hit WGI/REFG/SDG-code 404s empirically and dropped with evidence | WB docs confirm the drops were structural, not mistakes | **A confirms B** — documented in expansion-ceiling.md §4 |
| DAG/lineage | implicit (script order) | OWID explicit computational graph | **A wins long-term** — noted as M-next, not built now (pipeline is linear and small; a DAG layer is weight without lift today) |

## Merged result (shipped)
1. `/data/datapackage.json` — frictionless descriptor generated at publish from manifest+catalog: 71 resources (path, mediatype, sha256), 15 licenses, package sources = all 13 source titles+homepages, method version, created stamp. Any standard tool can now ingest /data/ unmodified.
2. `DATA.md` — provenance-standards mapping section (frictionless, PROV entity/activity/agent, OWID origins naming).
3. No changes to scoring, gates, or the sha-chain — PATH B's substance survived review; PATH A added the interoperability layer it lacked.
4. Deferred (recorded, not built): OWID-style explicit DAG ( revisit if the pipeline grows beyond linear nightly), DCAT-JSON-LD endpoint (datapackage.json covers the same consumers).

## Cost
PATH A: ~25 min research + ~40 lines of generator code + doc sections. PATH B: the pre-existing build. Merged delta: publish.sh +12 lines of python, DATA.md +9 lines, this doc.
