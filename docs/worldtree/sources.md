# Source catalog

Verified 2026-10-03 from this box with plain `curl` (no key, no cookie, no
account). "Proof" = the exact command and the observed result. Re-run any proof
line to re-verify; `plan.md` step 1 does this for the M2 sources.

Common rules for every fetcher:
- Send `User-Agent: worldtree-data/0.1 (+https://veraldar.org; dweeb.xyz@gmail.com)`.
  OWID returns **403 to Python's default urllib UA** (observed); Wikimedia
  policy requires a descriptive UA.
- Timeout 30 s, 3 tries, backoff 5/15/45 s. Respect per-source rate limits below.
- Status levels: **core** (used by M2), **M3** (registered, wired next),
  **candidate** (passes cost, open questions), **rejected**.

## Summary
| id | source | status | retrieval | license | realms fed |
|---|---|---|---|---|---|
| `owid` | Our World in Data grapher | core | CSV download + JSON metadata | CC BY 4.0 | all 7 |
| `worldbank` | World Bank Indicators API v2 | core | REST JSON | CC BY 4.0 | utopia, terminus |
| `epoch` | Epoch AI — Notable AI Models | core | CSV download | CC BY 4.0 | divergence, stagnation, transcendence |
| `wikimedia` | Wikimedia Pageviews REST | core | REST JSON | CC0 1.0 | drift, control, terminus, transcendence |
| `arxiv` | arXiv API | M3 | REST (Atom XML) | metadata CC0 1.0 | stagnation |
| `pubmed` | NCBI E-utilities (PubMed) | M3 | REST JSON | public domain (NLM; US gov) | utopia |
| `fedreg` | Federal Register API v1 | M3 | REST JSON | public domain (US gov work) | control |
| `noaa_gml` | NOAA GML Mauna Loa CO₂ | M3 | CSV download | public domain (US gov) | terminus |
| `unsdg` | UN SDG Global Database API | candidate | REST JSON | UN terms (free reuse w/ attribution) | utopia (cross-check) |
| `aiid` | AI Incident Database snapshots | candidate | weekly tar.bz2 | to confirm | terminus |
| `github` | GitHub search API | candidate | REST JSON | ToS (counts = facts) | divergence |
| `hf` | Hugging Face Hub API | candidate | REST JSON | ToS (no stated data license) | divergence |
| `manifold` | Manifold Markets API | candidate | REST JSON | none stated | transcendence |
| `gdelt` | GDELT DOC 2.0 API | candidate (pulse) | REST JSON/CSV | free, attribution | pulse only |
| — | Metaculus, Freedom House direct, V-Dem direct, Stanford AI Index files, Yahoo Finance, UK carbon intensity | rejected | — | — | see bottom |

---

## core

### `owid` — Our World in Data grapher
- **Measures:** curated long-run world series; also the stable public mirror of
  V-Dem, UCDP conflict data, Stanford AI Index (Quid/McKinsey) and Epoch
  benchmark series that otherwise have no stable endpoint.
- **Endpoint:** `https://ourworldindata.org/grapher/{slug}.csv?v=1&csvType=full&useColumnShortNames=true`
  Metadata (per-column source, `lastUpdated`, `nextUpdate`, unit):
  `https://ourworldindata.org/grapher/{slug}.metadata.json?v=1&csvType=full&useColumnShortNames=true`
- **Shape:** `entity,code,year|day,<value_col>[,…]`. World row: `entity=="World"`
  (code `OWID_WRL`) unless the indicator table says otherwise.
- **Slugs used** (all returned 200 text/csv on 10-03):
  `share-of-population-in-extreme-poverty`, `life-expectancy`,
  `electoral-democracy-index`, `deaths-in-armed-conflicts-by-region`,
  `estimated-share-people-generative-ai`, `cumulative-number-of-large-scale-ai-systems-by-country`,
  `private-investment-in-artificial-intelligence`, `share-companies-using-artificial-intelligence`,
  `ai-frontiermath-over-time`.
- **License:** CC BY 4.0 for OWID-processed data; each column's `citationShort`
  in the metadata names the upstream (must be copied into the sidecar).
  Non-redistributable charts refuse CSV with **403** and a message (observed:
  `test-scores-ai-capabilities-relative-human-performance`) — such slugs are
  banned from the registry.
- **Cadence:** per column, `nextUpdate` in metadata (e.g. poverty: lastUpdated
  2026-09-22, nextUpdate 2027-03-21; gen-AI share: 2026-06-12 → 2026-11-03).
  Fetch weekly; dedupe by sha256.
- **Proof:** `curl -sSL -A worldtree-data/0.1 -o /dev/null -w '%{http_code}\n' 'https://ourworldindata.org/grapher/life-expectancy.csv?v=1&csvType=full&useColumnShortNames=true'` → `200` (605 kB).

### `worldbank` — World Bank Indicators API v2
- **Measures:** WDI series for the World aggregate (`WLD`).
- **Endpoint:** `https://api.worldbank.org/v2/country/WLD/indicator/{code}?format=json&per_page=100`
  Codes used: `NY.GDP.PCAP.KD` (GDP per capita, constant 2015 US$),
  `SL.UEM.TOTL.ZS` (unemployment, % labour force, modeled ILO).
- **Shape:** `[ {page,pages,total,lastupdated}, [ {date:"2025", value: 12130.66, …}, … ] ]`.
  `total` was 66 → one page at `per_page=100`.
- **License:** CC BY 4.0 (World Bank open data terms).
- **Cadence:** WDI refresh ~quarterly (`lastupdated: 2026-07-13` observed). Fetch weekly.
- **Proof:** `curl -s 'https://api.worldbank.org/v2/country/WLD/indicator/NY.GDP.PCAP.KD?format=json&per_page=5' | head -c 120` → `[{"page":1,"pages":14,…,"lastupdated":"2026-07-13"}`.

### `epoch` — Epoch AI, Notable AI Models
- **Measures:** every notable AI model with org, country, publication date,
  training compute (FLOP), `Model accessibility`
  (`Open weights (unrestricted)`, `API access`, `Unreleased`, …), `Frontier model`.
- **Endpoint:** `https://epoch.ai/data/notable_ai_models.csv` (2.2 MB, 1 078 rows,
  latest publication date 2026-09-30 on 10-03). Larger superset (6.8 MB):
  `https://epoch.ai/data/all_ai_models.csv` — not needed in v0.
- **License:** CC BY 4.0 ("Creative Commons Attribution license", stated on
  `https://epoch.ai/data/notable-ai-models`).
- **Cadence:** updated continuously (days). Fetch daily; dedupe by sha256.
- **Proof:** `curl -sSL -o /dev/null -w '%{http_code} %{size_download}\n' https://epoch.ai/data/notable_ai_models.csv` → `200 2261902`.

### `wikimedia` — Wikimedia Pageviews REST API
- **Measures:** human attention to a topic (agent=`user` excludes self-identified bots).
- **Endpoint:** `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{Article}/monthly/{YYYYMMDD}/{YYYYMMDD}`
  Articles used (history start observed): `Deepfake` (2018-02),
  `Synthetic_media` (2020-01), `Regulation_of_artificial_intelligence` (2020-03),
  `Existential_risk_from_artificial_intelligence` (2024-09, renamed article — short),
  `Artificial_general_intelligence` (2015-07).
- **Shape:** `{items:[{timestamp:"2025010100", views:113795}, …]}`.
- **License:** CC0 1.0 (Wikimedia analytics data).
- **Cadence:** monthly buckets complete on the 1st; fetch on/after day 2.
  Rate limit: ≤100 req/s, UA required.
- **Proof:** `curl -s -A worldtree-data/0.1 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Deepfake/monthly/20150701/20260930' | jq '.items|length'` → `104`.

## M3 (registered now, wired after M2)

### `arxiv` — arXiv API
- **Measures:** monthly submission counts per category (research volume).
- **Endpoint:** `http://export.arxiv.org/api/query?search_query=cat:cs.AI+AND+submittedDate:[202509010000+TO+202509302359]&max_results=0`
  → read `<opensearch:totalResults>` (Atom XML).
- **License:** metadata CC0 1.0. **Rate:** 1 request / 3 s (arXiv API terms).
- **Cadence:** daily; use complete months only.
- **Proof:** `curl -s 'http://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=1' -o /dev/null -w '%{http_code}\n'` → `200` (application/atom+xml). Already used by `veraldar-site/pipeline/score.py:research_pulse`.

### `pubmed` — NCBI E-utilities
- **Measures:** monthly count of AI × (drug discovery | protein | molecular) papers.
- **Endpoint:** `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&rettype=count&retmode=json&term={urlencoded query AND ("2025/09/01"[PDAT]:"2025/09/30"[PDAT])}`
  Query body = the one in `score.py:pubmed_signal` minus `"last 30 days"`.
- **License:** PubMed/NLM data freely reusable; counts are facts; NLM is a US gov body.
  **Rate:** 3 req/s without key.
- **Proof:** `curl -s 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=artificial+intelligence&retmode=json&rettype=count'` → `{"esearchresult":{"count":"413127"}}`.

### `fedreg` — Federal Register API v1
- **Measures:** monthly count of US federal documents (rules, proposed rules,
  notices) mentioning "artificial intelligence" — rulemaking pressure.
- **Endpoint:** `https://www.federalregister.gov/api/v1/documents.json?conditions[term]=%22artificial+intelligence%22&conditions[publication_date][gte]=2025-09-01&conditions[publication_date][lte]=2025-09-30&per_page=1&fields[]=publication_date`
  → read `count`.
- **License:** US government work, public domain. No key.
- **Proof:** same URL without dates → `200`, `"count":1316`.

### `noaa_gml` — NOAA GML Mauna Loa monthly CO₂
- **Endpoint:** `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv`
  (comment lines start `#`; columns year,month,decimal date,average,…).
- **License:** public domain; file header: "freely available to the public".
- **Cadence:** monthly (~5th). **Proof:** `curl -s -o /dev/null -w '%{http_code}\n' https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv` → `200` (38 kB).

### Observed proofs — wired 10-04 (status `core`, method 0.2.0)
- `arxiv`: `https://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=1` → `200`.
  Note: `max_results=0` now returns an HTTP 500 error feed and `http://` 301-redirects;
  the fetcher uses `https` + `max_results=1`, ≥ 6 s apart. Backfill 2019-01 → 2026-09:
  93/93 months stored; cs.AI 2026-08 = 5 104, 2026-09 = 5 923.
- `pubmed`: proof URL above → `200`; 93 months stored; AI×biomed 2026-08 = 536, 2026-09 = 583.
- `fedreg`: proof URL above → `200`; 93 months stored; 2026-08 = 33, 2026-09 = 29.
- `noaa_gml`: proof URL above → `200` (38 732 B); last month with a value 2026-08 = 427.55 ppm.

## candidate

| id | proof (10-03) | why not core yet |
|---|---|---|
| `unsdg` | `https://unstats.un.org/sdgapi/v1/sdg/Series/Data?seriesCode=SI_POV_DAY1&areaCode=1&pageSize=2` → 200 JSON | redundant with OWID/World Bank poverty; useful as a disagreement cross-check |
| `aiid` | `https://incidentdatabase.ai/research/snapshots/` lists weekly `https://pub-72b2b2fc36ec423189843747af98f80e.r2.dev/backup-YYYYMMDDhhmmss.tar.bz2` (latest 2026-09-28, 108 MB, 200) | best *direct* terminus evidence (reported AI harms), but 108 MB > repo cap → store sha256 + derived monthly counts only; license wording to confirm before storing derived data |
| `github` | `https://api.github.com/search/repositories?q=topic:llm+created:2026-08-01..2026-08-31&per_page=1` → `total_count: 15050` | keyless but 10 search req/min; ToS not an open data license (counts are facts); topic tagging is noisy |
| `hf` | `https://huggingface.co/api/models?sort=downloads&direction=-1&limit=2` → 200 | no total-count endpoint; counting requires paging 10⁶ models |
| `manifold` | `https://api.manifold.markets/v0/slug/will-we-get-agi-before-2030` → p=0.534, 342 bettors | play money, no stated data license; only usable as a probation channel with a ≥100-bettor floor |
| `gdelt` | `https://api.gdeltproject.org/api/v2/doc/doc?query=%22artificial%20intelligence%22&mode=timelinevol&timespan=7d&format=json` → **429** on 4 tries ≥5 s apart (this host's IP is also used by the old pipeline) | endpoint live but rate-limited here; news-volume = pulse channel only (prediction.md §7) |

## rejected
| source | reason (evidence) |
|---|---|
| Metaculus API | `https://www.metaculus.com/api/posts/?limit=1` → 403 "only available to authenticated users … API token" — fails no-key rule |
| Freedom House (direct) | xlsx from freedomhouse.org; open reuse license not established; democracy dimension already covered by V-Dem via OWID (CC BY) |
| V-Dem (direct) | multi-hundred-MB zip behind a download page; the needed index is mirrored by OWID (`electoral-democracy-index`) |
| Stanford AI Index raw files | distributed via shared Drive folders, no stable endpoint; key series (private investment, corporate adoption) mirrored by OWID |
| Yahoo Finance (`query1.finance.yahoo.com`) | unofficial endpoint, terms forbid redistribution; used by old pipeline — dropped |
| UK carbon intensity | UK-only grid signal, not a world indicator; used by old pipeline — dropped |
