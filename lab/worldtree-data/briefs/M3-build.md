# M3 — wire the remaining free sources + percentages with provenance

Work order. Repo `R=~/Work/bifrost/lab/worldtree-data` (inside the bifrost git;
raw/series/runs/out/manifest.json are gitignored but on disk — backups cover
them; `run --commit` already uses --allow-empty). All commands run from `$R`.
Design docs: `~/Work/bifrost/docs/worldtree/` (README, sources, schema,
prediction, plan — plan.md "Next" section is this mission). Read prediction.md
§1–§7 and sources.md §M3 first.

Goal, one line: **arxiv + pubmed + fedreg + noaa_gml fetched for real → 4 new
series → 4 new mapping rows → method 0.2.0 → the seven percentages recomputed
with per-number provenance → `tests/m3_green.sh` exits 0 and `tests/report.sh`
prints the numbers.**

Rules: Python ≥ 3.11 stdlib only. Commit per step that changes tracked files
(`M3 step N: …`). Never edit `raw/` by hand. A step failing twice → write
`BLOCKER-M3.md` (exact error + what you need) and STOP. Deviation that can
move a number = minor bump → `method/CHANGELOG.md` + prediction.md updated in
the same commit.

Territory: `R/**`, `~/Work/bifrost/docs/worldtree/prediction.md`,
`~/Work/bifrost/docs/worldtree/sources.md` (append observed proofs only). Do
NOT touch: pwa/, agent/, docs/claims.md, schema.md, plan.md, README.md.

## Locked decisions (do not re-litigate; implement)

1. **Series** (`catalog/series.csv`, stage `core`):
   - `arxiv.cs_ai | arxiv | cs.AI | arxiv:monthly | count | monthly | 100 | arXiv cs.AI submissions`
   - `pubmed.ai_biomed | pubmed | ai_biomed | pubmed:monthly | count | monthly | 100 | PubMed AI×biomed papers`
   - `fedreg.ai_documents | fedreg | ai_documents | fedreg:monthly | count | monthly | 100 | US federal AI documents`
   - `noaa.co2 | noaa_gml | co2_mm_mlo | noaa:monthly | ppm | monthly | 100 | Mauna Loa CO₂ monthly mean`
2. **Mapping** (`catalog/mapping.csv`, exact rows; `"` quoting per current style):
   - `utopia,pubmed.ai_biomed,+1,2,rank_delta,lag=12;diff=log;h=60,society,"AI×biomed research volume rising faster than its own trend = tools attacking disease and scarcity"`
   - `control,fedreg.ai_documents,+1,2,rank_delta,lag=12;diff=log;h=60,geopolitics,"US rulemaking mentioning AI above its own trend = institutional leash tightening"`
   - `terminus,noaa.co2,+1,1,rank_delta,lag=12;diff=abs;h=60,environment,"CO₂ year-over-year growth above its own trend = the planetary boundary still receding"`
   - `stagnation,arxiv.cs_ai,-1,2,rank_delta,lag=12;diff=log;h=60,tech,"cs.AI submission volume shrinking against its own trend = the research engine stalling"`
   - W_map becomes: utopia 9 · divergence 7 · drift 3 · control 4 · terminus 6 · stagnation 7 · transcendence 4.
3. **Fetch (count sources)** — one raw file per (source, slug, month), bytes
   exactly as received, dedupe + sidecars + fetch-log unchanged:
   - arxiv: `http://export.arxiv.org/api/query?search_query=cat:cs.AI+AND+submittedDate:[YYYYMM010000+TO+YYYYMM{lastday}2359]&max_results=0`
     ext `.xml`; **sleep ≥ 3.1 s between requests** (arXiv terms).
   - pubmed: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&rettype=count&term={quote(QUERY)}`,
     QUERY = `(artificial intelligence[Title/Abstract]) AND (drug discovery[Title/Abstract] OR protein[Title/Abstract] OR molecular[Title/Abstract] OR battery[Title/Abstract] OR catalyst[Title/Abstract]) AND ("YYYY/MM/01"[PDAT]:"YYYY/MM/{lastday}"[PDAT])`
     (query body from veraldar-site `score.py:pubmed_signal`, "last 30 days"
     replaced by the month range). ext `.json`; sleep ≥ 0.4 s.
   - fedreg: `https://www.federalregister.gov/api/v1/documents.json?conditions[term]=%22artificial+intelligence%22&conditions[publication_date][gte]=YYYY-MM-01&conditions[publication_date][lte]=YYYY-MM-{lastday}&per_page=1&fields[]=publication_date`
     ext `.json`; sleep ≥ 0.5 s.
   - Month window per slug: from (newest stored month − 1) through the last
     COMPLETE month before today (reuse the `wiki_end` rule); no stored months
     → backfill from **2019-01**. Months parsed from the sidecar `url` field,
     NOT from filenames. First backfill ≈ 93 months → arxiv ≈ 5 min: expected,
     let it run.
   - noaa_gml: single whole-file fetch like the others:
     `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv`, ext `.csv`,
     one fetch unit (no month windowing).
4. **Extract** (new kinds in `wt/extract.py`; `ext_of` gains
   arxiv→xml, pubmed→json, fedreg→json, noaa_gml→csv):
   - `arxiv:monthly` / `pubmed:monthly` / `fedreg:monthly`: read **all**
     stored snapshots of the slug with `retrieved_at ≤ as_of`; per month parse
     the count (arxiv: `<opensearch:totalResults>` (namespace
     `http://a9.com/-/spec/opensearch/1.1/`); pubmed: `esearchresult.count`;
     fedreg: top-level `count`); **newest retrieved_at wins per month**; drop
     unparseable/empty; `period=YYYY-MM`, `date=month_end`.
   - `noaa:monthly`: newest single snapshot (like owid); skip `#` comments;
     columns `year,month,decimal date,average,…`; value = `average`;
     **drop rows with value < 0** (−99.99 missing sentinel) or non-numeric;
     `period=YYYY-MM`, `date=month_end`.
5. **Bias register** (prediction.md §7.1 + `wt/run.py:bias_ids`):
   - `arxiv.`/`pubmed.`/`fedreg.` series → `["B12"]`;
     `noaa.` → `["B13"]`.
   - B12 | Query-shaped counts: the query string defines the series (AI×biomed,
     "artificial intelligence", cs.AI); counts are facts, selection is
     judgement | arxiv/pubmed/fedreg | w=2 cap; rank_delta vs own history only.
   - B13 | Mauna Loa is one station, a global-mean proxy | noaa.co2 | w=1;
     growth rate vs own trend, never the level.
6. **sources.json**: flip `arxiv`, `fedreg`, `pubmed`, `noaa_gml` status
   `m3` → `core`. Nothing else.
7. **Version**: `method/VERSION` → `0.2.0`; CHANGELOG entry (minor: +4
   sources/series/mapping rows, new extract kinds, B12/B13, fixture weights
   before → after). `python3 tests/make_fixture.py <as_of> <now>` after the
   bump → `tests/fixtures/0.2.0/` (0.1.0 fixture stays untouched, historical).
8. **prediction.md** updated in the same commits: §1 series rows, §1.1 extract
   rules, §2 mapping rows + W_map line, §7.1 B12/B13. sources.md: add the four
   observed proof lines under M3 (status note "wired 10-04").
9. **tests**: new `tests/test_extract.py` (NO network): hand-built bytes for
   arxiv XML / pubmed JSON / fedreg JSON parses, noaa sentinel drop, the
   newest-snapshot-wins month merge, as-of drop. New `tests/m3_green.sh`
   (copy m2_green.sh, update): proofs = proofs.sh (27) + `tests/proofs_m3.sh`
   (4 new lines, one curl per source, same output shape) = 31 lines;
   `catalog OK 25 series 24 rows`; W_map assert per (2); feeds 23; manifest
   `method_version=="0.2.0"` + `.series|length==25`; the 4 new series files
   each ≥ 72 rows; last line `M3 GREEN`. Add one comment line atop
   m2_green.sh: `# M2-era gate (method 0.1.0); superseded by m3_green.sh`.
10. **README.md** of R: green check line → `bash tests/m3_green.sh`.

## Steps

0. Read the docs listed above. Print a 5-line plan. No code yet.
1. `tests/proofs_m3.sh` — the 4 proof curls (sources.md §M3 URLs), expect
   `200` × 4. Commit if tracked files changed (it will — new file).
2. Catalog: series.csv +4, mapping.csv +4, sources.json flips. Verify:
   `python3 -m wt check catalog` → `catalog OK 25 series 24 rows`; the
   negative check from m2_green step 2 still exits 1. Commit.
3. Fetchers (locked (3)): `wt/fetch.py` units() branches + sleeps + month
   window. Then `python3 -m wt fetch --source arxiv,pubmed,fedreg,noaa_gml`
   (backfill, arxiv slow). Verify: `python3 -m wt check integrity` → OK;
   count raw files per new source (`find raw/arxiv raw/pubmed raw/fedreg
   raw/noaa_gml -name '*.prov.json' | wc -l` per dir); spot-check one arxiv
   sidecar's url+sha256. No commit needed unless code changed (it did).
   Report: months fetched per source, counts for 2026-08/09.
4. Extract (locked (4)) + `ext_of` + `tests/test_extract.py`.
   `python3 -m wt series --as-of $(date -u +%F)` → `series OK 24 files`;
   `wc -l series/{arxiv.cs_ai,pubmed.ai_biomed,fedreg.ai_documents,noaa.co2}.csv`
   (≥ 73 rows each = header + ≥ 72 months); `python3 -m unittest discover
   -s tests -p 'test_extract.py'` OK. Commit.
5. Bias register + `bias_ids` + prediction.md §7.1. Commit.
6. Full recompute: `python3 -m wt run --as-of $(date -u +%F) --no-fetch`.
   Verify: run published; `gates.json` all run-gates pass; PROV-OK script
   (m2_green step 6) still passes and `srcs` now has 8 entries; contract OK;
   feeds 23. Commit (catalog/docs changed → tracked commit).
7. Version 0.2.0 + CHANGELOG + fixture + prediction.md §1/§1.1/§2 sync.
   `python3 tests/make_fixture.py $(date -u +%F) $(date -u +%FT06:00:00Z)`;
   `python3 -m unittest discover -s tests -p 'test_fixture.py'` OK. Commit.
8. `tests/m3_green.sh` → `M3 GREEN`; one final live run with fetch:
   `python3 -m wt run --as-of $(date -u +%F) --commit`; `bash tests/report.sh`
   output captured. Commit any tracked stragglers. Worktree must be clean
   (`git status --porcelain | wc -l` = 0).
9. Report back (stdout, end of run): the seven weights, gate summary, raw
   counts per source, series row counts, `du -sh raw`, `git log --oneline -12`.

## Referee
`bash tests/m3_green.sh` exit 0 + `bash tests/report.sh` printing 7
percentages, each with sources + licenses. That is the finish line.
