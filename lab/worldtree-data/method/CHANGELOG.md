# Method changelog

## 0.3.0 — 2026-10-04
- Minor (additive; no weight changes): new output `realms-history.json`
  (schema `worldtree.history/1`) + `realms-history.provenance.json` — the
  unchanged 0.2.0 method recomputed per year 2015 … as-of year, cut at Dec-31
  (the as-of date for the current year). `compute(cut=…)` drops every
  observation dated after the cut before any transform (no lookahead);
  staleness is judged at the cut, snapshot choice/age at the as-of. Per year:
  weights (Σ 100.0, largest remainder), coverage, `provisional` (coverage
  < 0.5), `ref_n_min` (rank transforms), run gates, provenance key + sha256.
  New cmd `python3 -m wt history --as-of D [--now ISO] [--out PATH]`; `run`
  emits it every night. Exclusion reason `no_data` (no observation on/before
  the cut; never hit at today's as-of).
- realms.json gains additive blocks `refresh` (method/refresh.json: nightly
  14:30 Europe/Berlin via worldtree-fetch.timer, what each source fetch pulls),
  `geography` (method/geography.json: curated per-source region coverage,
  cited) and `history` ({file, sha256} of realms-history.json).
- Why: M5 — the page needs the trend (per-year percentages) and the reader
  needs to know when numbers refresh and which parts of the world they see.
- Honesty: raw files are today's vintage (revisions included, publication lag
  not modelled); pre-2018 years are thin on AI series (arXiv/PubMed/FedReg
  from 2019-01, Wikimedia 2015-07, Epoch 2015-01; 12-month deltas need ≥ 24
  reference points) → those realms are flagged provisional.
- Fixture weights: before (`tests/fixtures/0.2.0`) — 14.7 · 10.9 · 16.7 ·
  13.5 · 18.7 · 10.7 · 14.8; after (`tests/fixtures/0.3.0`, as-of 2026-10-04)
  — identical (additive release); history 2015 → 2026 in
  `tests/fixtures/0.3.0/realms-history.json`.

## 0.2.0 — 2026-10-04
- Minor: +4 core sources (arXiv, PubMed, Federal Register, NOAA GML), +4
  series (`arxiv.cs_ai`, `pubmed.ai_biomed`, `fedreg.ai_documents`,
  `noaa.co2`), +4 mapping rows (pubmed → utopia w2, fedreg → control w2,
  noaa.co2 → terminus w1, arxiv → stagnation w2; W_map 7·7·3·2·5·5·4 →
  9·7·3·4·6·7·4), new extract kinds `arxiv|pubmed|fedreg:monthly` (one raw
  file per month, month from sidecar url, newest snapshot per month wins) and
  `noaa:monthly` (−99.99 sentinel dropped), bias ids B12 (query-shaped counts)
  and B13 (single-station CO₂) (prediction.md §1, §1.1, §2, §7.1).
- arXiv requests use `https` + `max_results=1` (`max_results=0` returns HTTP
  500 since 10-04; count = `opensearch:totalResults`, unchanged), ≥ 6 s apart.
- Why: M3 — raise the evidence mass of the weakly-proxied realms (control,
  terminus) with structured counts instead of attention alone (B10).
- Fixture weights: before (`tests/fixtures/0.1.0`, as-of 2026-10-03) — utopia
  13.7 · divergence 11.1 · drift 16.9 · control 12.9 · terminus 20.0 ·
  stagnation 10.4 · transcendence 15.0; after (`tests/fixtures/0.2.0`, as-of
  2026-10-04) — 14.7 · 10.9 · 16.7 · 13.5 · 18.7 · 10.7 · 14.8.

## 0.1.0 — 2026-10-03
- First method: 4 core sources (OWID, World Bank, Epoch AI, Wikimedia), 20
  series, 20 mapping rows (prediction.md §1–§2), transforms `rank_delta`,
  `rank_level`, `logistic_delta` (§3), mass-shrunk evidence share with
  largest-remainder rounding to 100.0 (§4), gates + per-number provenance (§5).
- Why: replaces the news/lexicon scorer (prediction.md §7.2) with
  reproducible, snapshot-traced structured indicators.
- Fixture weights: before — (none, first version); after — see
  `tests/fixtures/0.1.0/realms.json`.
