# Method changelog

## 0.1.0 — 2026-10-03
- First method: 4 core sources (OWID, World Bank, Epoch AI, Wikimedia), 20
  series, 20 mapping rows (prediction.md §1–§2), transforms `rank_delta`,
  `rank_level`, `logistic_delta` (§3), mass-shrunk evidence share with
  largest-remainder rounding to 100.0 (§4), gates + per-number provenance (§5).
- Why: replaces the news/lexicon scorer (prediction.md §7.2) with
  reproducible, snapshot-traced structured indicators.
- Fixture weights: before — (none, first version); after — see
  `tests/fixtures/0.1.0/realms.json`.
