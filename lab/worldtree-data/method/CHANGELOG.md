# Method changelog

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
