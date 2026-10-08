# Prediction method — v0.2.0

How `series/*.csv` become the seven numbers in `realms.json`. Deterministic:
same raw snapshots + same `--as-of` date + same method version ⇒ byte-identical
output. All numbers here are the v0.2.0 values of `catalog/mapping.csv` and
`catalog/series.csv`; changing any of them follows §6.

Facts quoted below (row counts, last periods, column names) were observed on
2026-10-03 against the live endpoints in `sources.md` (M3 sources: 2026-10-04).

## 0. What a number means
Each realm is a **departure from the historical trend** in one direction.
An indicator supports a realm when it moves in that realm's direction *faster
than its own history usually does* (or sits higher than its history, for level
indicators). A world moving exactly as usual scores 0.5 everywhere and prints
14.3 % per realm. The output is an **evidence share** (README), not a
probability.

Amended 0.6.0 (M8 honesty review, `honesty-review.md`): the page now says so
where the numbers are (hero: "a share of the evidence, not a probability: 14.3 %
each would mean nothing unusual anywhere"; rings and dials draw/label the even
line). Two kinds of indicator feed the realms, declared per series in
`catalog/series.csv` column `measures`: `ai` (the quantity would not exist
without machine intelligence) and `world` (a condition of the world AI lands in,
measured without reference to AI); `norm` marks denominators, never mapped.
`weights` use both. `modes.strict` = the same aggregation (§4) over the `ai`
indicators only, with W_map restricted to the `ai` rows — a realm with no `ai`
indicator rests at e = 0.5; `modes.wide` = `weights` (nothing measured is left
out of the headline). Never published as the headline; it is the page's STRICT AI
lens and the visible answer to "how much of this is about AI itself" (B18).

## 1. Series registry (`catalog/series.csv`, v0.2.0 core)
`series_id` prefix is a short alias (`owid`, `wb`, `epoch`, `wiki`); the
`source_id` column carries the catalog id (`owid`, `worldbank`, `epoch`,
`wikimedia`). This keeps `series/wb.unemployment.csv` (schema.md §5) valid.

| series_id | source_id | slug | extract | unit | cadence | max_age_days | label |
|---|---|---|---|---|---|---|---|
| owid.extreme_poverty | owid | share-of-population-in-extreme-poverty | `owid:entity=World;col=headcount_ratio__ppp_version_2021__poverty_line_300__welfare_type_income_or_consumption__table_income_or_consumption_consolidated__survey_comparability_no_spells` | % | annual | 1100 | Extreme poverty ($3/day) |
| owid.life_expectancy | owid | life-expectancy | `owid:entity=World;col=life_expectancy_0` | years | annual | 1100 | Life expectancy |
| wb.gdp_per_capita | worldbank | NY.GDP.PCAP.KD | `wb:WLD` | US$ | annual | 1100 | GDP per capita (const. 2015 $) |
| epoch.open_weights_share | epoch | notable_ai_models | `epoch:open_share` | % | monthly | 100 | Open-weights share of notable models (12 mo) |
| epoch.org_diversity | epoch | notable_ai_models | `epoch:org_diversity` | index 0-1 | monthly | 100 | Organisation diversity of notable models (12 mo) |
| epoch.country_diversity | epoch | notable_ai_models | `epoch:country_diversity` | index 0-1 | monthly | 100 | Country diversity of notable models (12 mo) |
| epoch.frontier_compute | epoch | notable_ai_models | `epoch:frontier_compute` | log10 FLOP | monthly | 100 | Largest training run (12 mo) |
| owid.genai_user_share | owid | estimated-share-people-generative-ai | `owid:entity=World;col=ai_user_share` | % | daily | 300 | Share of people using generative AI |
| wiki.deepfake | wikimedia | Deepfake | `wiki:monthly` | views | monthly | 100 | Attention: Deepfake |
| wiki.synthetic_media | wikimedia | Synthetic_media | `wiki:monthly` | views | monthly | 100 | Attention: Synthetic media |
| wiki.ai_regulation | wikimedia | Regulation_of_artificial_intelligence | `wiki:monthly` | views | monthly | 100 | Attention: AI regulation |
| wiki.ai_xrisk | wikimedia | Existential_risk_from_artificial_intelligence | `wiki:monthly` | views | monthly | 100 | Attention: AI existential risk |
| wiki.agi | wikimedia | Artificial_general_intelligence | `wiki:monthly` | views | monthly | 100 | Attention: AGI |
| wiki.en_total | wikimedia | _aggregate | `wiki:aggregate` | views | monthly | 100 | en.wikipedia total user views (normaliser, not mapped) |
| owid.electoral_democracy | owid | electoral-democracy-index | `owid:entity=World;col=electdem_vdem__estimate_best` | index 0-1 | annual | 1100 | Electoral democracy (V-Dem) |
| owid.conflict_deaths | owid | deaths-in-armed-conflicts-by-region | `owid:entity=World;col=number_deaths_ongoing_conflicts__conflict_type_all` | count | annual | 1100 | Deaths in armed conflicts (UCDP) |
| wb.unemployment | worldbank | SL.UEM.TOTL.ZS | `wb:WLD` | % | annual | 1100 | Unemployment (ILO modeled) |
| owid.ai_private_investment | owid | private-investment-in-artificial-intelligence | `owid:entity=World;col=private_investment` | US$ | annual | 1100 | Private AI investment |
| owid.ai_company_adoption | owid | share-companies-using-artificial-intelligence | `owid:entity=All geographies;col=pct_of_respondents` | % | annual | 1100 | Companies using AI |
| owid.frontiermath_best | owid | ai-frontiermath-over-time | `owid:runmax;col=mean_score` | % | monthly | 120 | FrontierMath best score to date |
| arxiv.cs_ai | arxiv | cs.AI | `arxiv:monthly` | count | monthly | 100 | arXiv cs.AI submissions |
| pubmed.ai_biomed | pubmed | ai_biomed | `pubmed:monthly` | count | monthly | 100 | PubMed AI×biomed papers |
| fedreg.ai_documents | fedreg | ai_documents | `fedreg:monthly` | count | monthly | 100 | US federal AI documents |
| noaa.co2 | noaa_gml | co2_mm_mlo | `noaa:monthly` | ppm | monthly | 100 | Mauna Loa CO₂ monthly mean |

All `stage=core`. Registered `stage=candidate`, unmapped:
`owid.large_scale_ai_systems` (`cumulative-number-of-large-scale-ai-systems-by-country`
— no `World` row, last updated 2025-03-12; superseded by `epoch.country_diversity`,
kept as a cross-check).

`wiki.en_total` uses
`https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/en.wikipedia/all-access/user/monthly/{YYYYMMDD00}/{YYYYMMDD00}`
(same API, license and UA rule as `sources.md` `wikimedia`; 200, 135 monthly
items 2015-07 → 2026-09 on 10-03). Its raw dir is `raw/wikimedia/_aggregate/`.

### 1.1 Extract rules (raw → `series/<id>.csv`)
Common: `period`/`date` per schema.md §3.3. **Drop every row whose `date` is
after the as-of date** (removes partial years/months and OWID projections
dated in the future, e.g. conflict deaths 2026 = 76 671 partial,
poverty 2026). Drop empty/non-numeric values. Rows sorted by `date`.

| extract | rule |
|---|---|
| `owid:entity=E;col=C` | rows with `entity == E`; `period` = `year` (annual) or `day` (daily); value = column `C` |
| `owid:runmax;col=C` | all entities; for each month end M from the first month with data to the month of the newest `day` (never extended past the data, so staleness still bites): value = max(`C`) over rows with `day ≤ M`; `period` = `YYYY-MM` |
| `wb:WLD` | page-1 array element `[1]`; rows with `value != null`; `period` = `date` (year) |
| `wiki:monthly` / `wiki:aggregate` | `items[]`: `period` = `timestamp[0:4]-timestamp[4:6]`, value = `views` |
| `epoch:*` | see below; window for month end M = models with `Publication date` in (M − 12 months, M]; months from 2015-01 to the month of the newest `Publication date` |
| `arxiv:monthly` / `pubmed:monthly` / `fedreg:monthly` | one raw file per (slug, month) — the month is parsed from the sidecar `url`, never the filename; all snapshots with `retrieved_at ≤ as_of` are read and the **newest parseable snapshot per month wins**; count = arxiv `<opensearch:totalResults>` (ns `http://a9.com/-/spec/opensearch/1.1/`; requests use `https`, `max_results=1` — `max_results=0` returns HTTP 500 since 10-04), pubmed `esearchresult.count`, fedreg top-level `count`; unparseable/empty dropped; `period` = `YYYY-MM`, `date` = month end |
| `noaa:monthly` | newest single snapshot; `#` comment lines skipped; columns `year,month,decimal date,average,…`; value = `average`; rows with value < 0 (−99.99 missing sentinel) or non-numeric dropped; `period` = `YYYY-MM`, `date` = month end |

Epoch derivations (CSV columns observed on 10-03: `Publication date`,
`Organization`, `Country (of organization)`, `Training compute (FLOP)`,
`Model accessibility`; 1 078 rows):
- `open_share`: among window models with non-empty `Model accessibility`,
  100 × count(value starts with `Open weights`) / count. Emit only if count ≥ 20.
  (Observed values: `Open weights (unrestricted|non-commercial|restricted use)`,
  `API access`, `Unreleased`, `Hosted access (no API)`, `Limited access`, empty ×251.)
- `org_diversity` / `country_diversity`: split the field on `,`, strip; a model
  with k entries gives 1/k to each; value = 1 − Σ share² (1 − HHI) over window.
  Emit only if window has ≥ 20 models.
- `frontier_compute`: max log10(`Training compute (FLOP)`) over window models
  with a value. Emit only if ≥ 5 such models.

## 2. Mapping table (`catalog/mapping.csv` v0.2.0)
(Epoch/OWID derivations referenced by schema.md §3.1 `extract` are in §1.1.)
realm ← indicator ← transform ← weight. `w`: 1 weak/attention proxy · 2 strong
proxy · 3 direct measure. Rows using `logistic_delta` are capped at `w=1`
(prior-based, §3.3).

| realm | series_id | dir | w | transform | params | dimension | rationale |
|---|---|---|---|---|---|---|---|
| utopia | owid.extreme_poverty | -1 | 3 | rank_delta | `lag=1;diff=abs;h=30` | economy | poverty falling faster than its trend is the most direct sign of material problems being solved |
| utopia | owid.life_expectancy | +1 | 2 | rank_delta | `lag=1;diff=abs;h=30` | society | health gains beyond trend |
| utopia | wb.gdp_per_capita | +1 | 2 | rank_delta | `lag=1;diff=log;h=30` | economy | abundance: real per-capita output growth beyond trend |
| utopia | pubmed.ai_biomed | +1 | 2 | rank_delta | `lag=12;diff=log;h=60` | society | AI×biomed research volume rising faster than its own trend = tools attacking disease and scarcity |
| divergence | epoch.open_weights_share | +1 | 3 | rank_delta | `lag=12;diff=abs;h=60` | tech | more notable models shipped with open weights = intelligence escaping the few |
| divergence | epoch.org_diversity | +1 | 2 | rank_delta | `lag=12;diff=abs;h=60` | tech | notable models spread over more organisations |
| divergence | epoch.country_diversity | +1 | 2 | rank_delta | `lag=12;diff=abs;h=60` | geopolitics | notable models spread over more countries |
| drift | owid.genai_user_share | +1 | 1 | logistic_delta | `span_days=270;diff=abs;d0=0;k=5` | society | mass generative-AI use is the substrate of synthetic-media drift |
| drift | wiki.deepfake | +1 | 1 | rank_delta | `norm=total;agg=mean3;lag=12;diff=log;h=60` | society | public attention to deepfakes |
| drift | wiki.synthetic_media | +1 | 1 | rank_delta | `norm=total;agg=mean3;lag=12;diff=log;h=60` | society | public attention to synthetic media |
| control | wiki.ai_regulation | +1 | 1 | rank_delta | `norm=total;agg=mean3;lag=12;diff=log;h=60` | geopolitics | attention to AI regulation tracks rulemaking pressure |
| control | owid.electoral_democracy | +1 | 1 | rank_delta | `lag=1;diff=abs;h=30` | geopolitics | accountable institutions are the precondition for keeping the leash |
| control | fedreg.ai_documents | +1 | 2 | rank_delta | `lag=12;diff=log;h=60` | geopolitics | US rulemaking mentioning AI above its own trend = institutional leash tightening |
| terminus | owid.conflict_deaths | +1 | 2 | rank_level | `diff=log;h=30` | geopolitics | organised violence at a historic high is the weapons arm of the leash breaking |
| terminus | wb.unemployment | +1 | 2 | rank_delta | `lag=1;diff=abs;h=30` | economy | job losses beyond trend |
| terminus | wiki.ai_xrisk | +1 | 1 | rank_level | `norm=total;agg=mean3;h=60` | tech | attention to existential AI risk |
| terminus | noaa.co2 | +1 | 1 | rank_delta | `lag=12;diff=abs;h=60` | environment | CO₂ year-over-year growth above its own trend = the planetary boundary still receding |
| stagnation | owid.ai_private_investment | -1 | 2 | rank_delta | `lag=1;diff=log;h=30` | economy | investment growing slower than usual = money losing faith |
| stagnation | owid.ai_company_adoption | -1 | 1 | logistic_delta | `span_days=365;diff=abs;d0=0;k=5` | economy | companies not adopting = the revolution not landing |
| stagnation | epoch.frontier_compute | -1 | 2 | rank_delta | `lag=12;diff=abs;h=60` | tech | frontier compute growing slower than its own trend = plateau |
| stagnation | arxiv.cs_ai | -1 | 2 | rank_delta | `lag=12;diff=log;h=60` | tech | cs.AI submission volume shrinking against its own trend = the research engine stalling |
| transcendence | owid.frontiermath_best | +1 | 1 | logistic_delta | `span_days=270;diff=logit;d0=0;k=1` | tech | frontier research-maths ability rising = horizon dissolving |
| transcendence | epoch.frontier_compute | +1 | 2 | rank_delta | `lag=12;diff=abs;h=60` | tech | frontier compute accelerating beyond trend |
| transcendence | wiki.agi | +1 | 1 | rank_delta | `norm=total;agg=mean3;lag=12;diff=log;h=60` | tech | attention to AGI |

Mapped weight per realm (`W_map`, v0.2.0): utopia 9 · divergence 7 · drift 3 ·
control 4 · terminus 6 · stagnation 7 · transcendence 4 (v0.1.0: 7 · 7 · 3 ·
2 · 5 · 5 · 4).
`epoch.frontier_compute` is the only series on two realms (opposite directions,
allowed by schema.md §3.2) — slow compute growth is stagnation evidence, fast
is transcendence evidence; never both at once.

v0.2.0 added the four M3 rows above (`pubmed` → utopia, `fedreg` → control,
`noaa_gml` → terminus (environment), `arxiv` → stagnation).

## 3. Normalization: series → score `s ∈ [0,1]`
Params (from `mapping.csv` `params`, `k=v;…`), applied in this order:
1. `norm=total` — divide by `wiki.en_total` for the same period, × 10⁶
   (views per million en.wiki views). Period missing in total ⇒ row dropped.
2. `agg=mean3` — x′ₜ = mean(xₜ, xₜ₋₁, xₜ₋₂); defined only if all three
   consecutive periods exist.
3. `diff` — scale for changes/levels: `abs` (as is), `log` (natural log;
   value ≤ 0 ⇒ row dropped), `logit` (ln(p/(100−p)) for a %; p clamped to
   [0.5, 99.5]).

Period arithmetic: `t − lag` is the row whose `period` is exactly `lag`
periods earlier (years for annual, months for monthly). Missing ⇒ yₜ undefined
(no interpolation, ever).

### 3.1 `rank_delta` (`lag`, `diff`, `h`)
yₜ = f(xₜ) − f(xₜ₋lag), f = the `diff` scale. y* = y at the newest period.
### 3.2 `rank_level` (`diff`, `h`)
yₜ = f(xₜ).

For both: reference set R = the up-to-`h` most recent defined y values
**strictly before** y*. History floor: |R| ≥ 8 (annual) / 24 (monthly), else the
indicator is excluded with reason `short_history`.
```
pct = ( #{r ∈ R : r < y*} + 0.5 · #{r ∈ R : r = y*} ) / |R|
s   = pct            if dir = +1
s   = 1 − pct        if dir = −1
```
### 3.3 `logistic_delta` (`span_days`, `diff`, `d0`, `k`) — short series only
For series too young for ranks (gen-AI share: 3 World points; company
adoption: 5; FrontierMath: since 2024). x_ref = newest row with
`date ≤ latest_date − span_days` (none ⇒ excluded `short_history`).
```
d     = ( f(x_latest) − f(x_ref) ) · 365.25 / (latest_date − ref_date in days)   # per year
s_raw = 1 / (1 + exp(−(d − d0) / k))
s     = s_raw if dir = +1 else 1 − s_raw
```
`d0`, `k` are declared priors (bias register B7). A `logistic_delta` row is
switched to `rank_delta` (minor bump) once the series clears the history floor.

Every score is rounded to 4 decimals before aggregation (determinism across
float implementations).

## 4. Aggregation and the sum-to-100 rule
For realm r, U = used indicators (passed all §5 indicator gates):
```
W_used = Σ_{i∈U} w_i
m_r    = Σ w_i s_i / W_used                 (0.5 if U empty)
cov_r  = W_used / W_map(r)                  (coverage, gated in §5)
mass_r = min(1, W_used / 6)                 (evidence mass)
e_r    = 0.5 + mass_r · (m_r − 0.5)         (evidence, ∈ [0,1])
p_r    = 100 · e_r / Σ_k e_k
```
- **Mass shrink** (W_FULL = 6 = two direct measures): a realm resting only on
  weak proxies cannot swing far from neutral. In v0.1.0 drift (max mass 0.5)
  and control (0.33) are structurally muted. That is the honest statement
  "we measure these badly"; the fix is sources (M3), not a larger weight.
- Missing indicators lower W_used ⇒ pull the realm toward 0.5, never toward
  a direction (README principle 5).
- No sharpening exponent/softmax: a knob nobody can justify is a place to hide
  a thumb. Consequence: numbers stay close to 14.3 unless evidence agrees.
- **Rounding to exactly 100.0** (largest remainder at 0.1): uₖ = 1000·eₖ/Σe;
  take ⌊uₖ⌋; give the remaining 1000 − Σ⌊uₖ⌋ tenths one each to the largest
  fractional parts, ties broken by realm order
  `utopia, divergence, drift, control, terminus, stagnation, transcendence`;
  weight = units/10. Integer arithmetic ⇒ Σ weights == 100.0 exactly.
- `world_weights` = these weights. If an agent-votes file is configured
  (§7.2), `weights` = blend, `world_weights` = pre-blend, both summing to 100
  by the same rounding.

### 4.1 Other `realms.json` fields (page contract, `veraldar-site/realms.json` + `world-tree.html`)
| field | value |
|---|---|
| `updated` | run time, `YYYY-MM-DDTHH:MM:SSZ` (the page flags STALE after 24 h ⇒ runs must be daily) |
| `window` | `structured indicators · method 0.1.0 · <n_used> series · data <oldest latest_date> → <newest latest_date>` (must not contain the word "items"; the page's `items()` regex would misread it) |
| `colors`, `definitions` | verbatim from current `veraldar-site/realms.json` (copied into `catalog/realms.static.json`) |
| `weights`, `world_weights` | §4 |
| `dimensions` | for each dimension with ≥1 used indicator: Σ w_i·\|s_i − 0.5\| of its indicators, normalised to 100, 1 decimal ("where the movement comes from"); `{}` if all scores are exactly 0.5 |
| `top` | per realm, up to 2 strings for the used indicators with largest w_i·\|s_i − 0.5\| pointing the realm's way (s_i > 0.5): `"<label>: <latest value + unit> (<latest_period>) · score <s>"` |
| `sources` | `{<source title>: <number of series used>}` e.g. `{"Our World in Data": 9, "Epoch AI": 4, "Wikimedia": 4, "World Bank": 2}` — real counts; the page labelled them "items" until 0.6.0, now "series" |
| `feeds` | one `{name: label, state, tier}` per mapped series: used → `"<latest_period> · score 0.71"`; excluded → `"excluded: stale (2023-12-31)"` / `"excluded: short_history (11/24)"` — exclusions are shown on the page, not hidden; `tier` (0.6.0) = the series' `measures` (`ai` / `world`), the page's lens tiers (before 0.6.0 the page guessed tiers from feed names with news-era regexes and hid 25 of 28 indicators at its default lens) |
| `modes` | 0.6.0: `{strict: <weights over measures=ai indicators>, wide: <= weights>, strict_top: <top over measures=ai>}` (§0 amendment); provenance `realms.<r>.strict` carries weight, evidence, coverage, mass, w_used, w_map and the series used |
| `agent_roots` | only when §7.2 is configured; same shape as today |
| `method_version`, `provenance` | extra keys (`"0.1.0"`, `"realms.provenance.json"`); the page ignores unknown keys |

## 5. Gates and per-number provenance

### 5.1 Gates (written to `runs/<id>/gates.json` as `[{gate, scope, pass, reason}]`)
Indicator gates (fail ⇒ indicator excluded, recorded in `excluded`, run continues):
| gate | rule |
|---|---|
| `stale` | as_of − last `date` > `max_age_days` (series.csv). Annual 1100 d ≈ the 2-year publication lag of world aggregates (life expectancy's latest World row is 2023) |
| `snapshot_age` | newest raw snapshot of the series retrieved > 30 days before as_of (we stopped being able to fetch it) |
| `short_history` | §3 history floor not met |
| `no_value` | latest y undefined (lag row missing, `norm` period missing) |

Run gates (fail ⇒ run **held**: `runs/<id>/` written, `out/` untouched, history row `published=0`):
| gate | rule |
|---|---|
| `integrity` | every snapshot used: `sha256(file) == sidecar.sha256` |
| `realm_coverage` | every realm: `cov_r ≥ 0.5` |
| `global_coverage` | ≥ 12 indicators used, from ≥ 2 distinct sources |
| `contract` | output passes `tests/check_contract.py` (7 finite weights, Σ = 100.0, `updated` parses, required keys) |
| `catalog` | mapping.csv valid: realms ∈ the 7, series exist, w ∈ {1,2,3}, `logistic_delta ⇒ w = 1`, ≤ 2 realms per series |

Warning (recorded, never blocks): `jump` — any realm moved > 10 points vs last
published run. A held run leaves the live page to go STALE by itself — the
honest failure mode; never re-emit old numbers with a fresh `updated`.

### 5.2 Per-number provenance (`runs/<id>/provenance.json` = `out/realms.provenance.json`)
```json
{
 "schema": "worldtree.provenance/1",
 "run_id": "20261003T060000Z",
 "as_of": "2026-10-03",
 "updated": "2026-10-03T06:00:41Z",
 "method_version": "0.1.0",
 "mapping_sha256": "<sha256 of catalog/mapping.csv>",
 "series_registry_sha256": "<sha256 of catalog/series.csv>",
 "published": true,
 "sum_e": 3.4812,
 "realms": {
  "terminus": {
   "weight": 15.9, "world_weight": 15.9,
   "evidence": 0.5531, "mean_score": 0.5797, "coverage": 0.8, "mass": 0.6667,
   "w_used": 4, "w_map": 5,
   "indicators": [
    {"series_id": "owid.conflict_deaths", "source_id": "owid", "label": "Deaths in armed conflicts (UCDP)",
     "direction": 1, "weight": 2, "transform": "rank_level", "params": "diff=log;h=30",
     "score": 0.9655, "pct": 0.9655, "y_latest": 12.4072, "ref_n": 29,
     "latest_period": "2025", "latest_date": "2025-12-31", "latest_value": 244579, "unit": "count",
     "contribution": 0.0920,
     "series_path": "series/owid.conflict_deaths.csv", "series_sha256": "…",
     "snapshot": {"path": "raw/owid/deaths-in-armed-conflicts-by-region/20261003T060002Z.csv",
                  "sha256": "…", "retrieved_at": "2026-10-03T06:00:02Z"},
     "norm_snapshot": null,
     "source_url": "https://ourworldindata.org/grapher/deaths-in-armed-conflicts-by-region.csv?v=1&csvType=full&useColumnShortNames=true",
     "license": "CC BY 4.0", "attribution": "UCDP (2025) – processed by Our World in Data",
     "bias": ["B5"]}
   ],
   "excluded": [{"series_id": "wiki.ai_xrisk", "reason": "short_history", "detail": "ref_n 22 < 24"}]
  }
 }
}
```
(Values illustrative of shape only.) Field rules: `norm_snapshot` = the
`wiki.en_total` raw file (same `{path, sha256, retrieved_at}` shape) for
`norm=total` rows, else `null`. `contribution` =
w_i·(s_i − 0.5)·mass_r / W_used (the indicator's share of e_r − 0.5; Σ over
a realm = e_r − 0.5). `realms.<r>.weight` is the published %, indicator
`weight` is the mapping weight. Every published number therefore resolves:
`weights.terminus` → `realms.terminus.indicators[]` → `series_path` →
`snapshot.path` (sha256-checked) → `source_url` + `license`. Field names used
by schema.md §5 queries are frozen (§6 major).

## 6. Versioning (`method/VERSION`, `method/CHANGELOG.md`)
| bump | when |
|---|---|
| major | realm set or `realms.json`/provenance/manifest field names change; schema.md §5 query contract breaks |
| minor | anything that can move a number: mapping row added/removed, weight, direction, transform, params, gate threshold, W_FULL, extract rule, new source, `logistic_delta → rank_delta` switch, a bug fix that changes output |
| patch | provably no number moves: docs, logging, refactor — proof = fixture output byte-identical |

Each version has `tests/fixtures/<version>/` (frozen raw set + `as_of` +
expected `realms.json`/`provenance.json`); CI rule: current code on the
current fixture must be byte-identical. CHANGELOG entry: version, date,
what changed, why, and the fixture weights before → after.

## 7. Known-bias register and the old news pipeline

### 7.1 Bias register (ids referenced from provenance `bias[]`)
| id | bias | affects | mitigation in v0.2.0 |
|---|---|---|---|
| B1 | English Wikipedia only; Anglophone attention | wiki.* | `norm=total` removes en.wiki's own decline (−18 % user views 2015-07 → 2026-09: 7.67 B → 6.27 B/mo); all wiki rows w=1 |
| B2 | Attention ≠ realisation (a deepfake scandal spikes views without more deepfakes) | wiki.* | w=1 cap; mean3 smoothing; never the sole indicator of a realm (coverage gate) |
| B3 | Epoch "notable" selection skews to US/UK labs and English papers; 251 rows with empty accessibility | epoch.* | ratios within a 12-month window, ≥ 20-model floor; empty accessibility excluded from the share's denominator |
| B4 | OWID poverty rows for recent years are nowcasts, not surveys | owid.extreme_poverty | rows dated after as_of dropped; nowcast years accepted (declared) |
| B5 | UCDP counts lag ~1 year and are revised; current year partial | owid.conflict_deaths | partial year dropped by the as_of rule; not AI-specific → w=2 |
| B6 | World aggregates lag 1–2 years | annual series | `max_age_days` 1100, stated per series; staleness excludes, never extrapolates |
| B7 | `logistic_delta` priors (`d0`, `k`) are judgement, not history | genai_user_share, ai_company_adoption, frontiermath_best | w=1 cap; replaced by ranks when history allows |
| B8 | FrontierMath is near its ceiling (93.7 % best on 2026-09-03) and funded by one lab | owid.frontiermath_best | `diff=logit` so gains near 100 still register; w=1 |
| B9 | Private-investment and company-adoption figures come from commercial surveys (Quid/McKinsey via AI Index), US-heavy | owid.ai_* | w ≤ 2; stagnation also fed by Epoch compute |
| B10 | Structural muting: realms with only weak proxies (drift, control) cannot lead | all | disclosed (§4); M3 sources raise their mass |
| B11 | Rank-vs-own-history calls a series' *usual* behaviour neutral — a decades-long trend (e.g. falling poverty) is not itself evidence | rank_* | by design (§0); stated on README |
| B12 | Query-shaped counts: the query string defines the series (AI×biomed, "artificial intelligence", cs.AI); counts are facts, selection is judgement | arxiv.*, pubmed.*, fedreg.* | w=2 cap; `rank_delta` vs own history only |
| B13 | Mauna Loa is one station, a global-mean proxy | noaa.co2 | w=1; growth rate vs own trend (`diff=abs`, lag 12), never the level |
| B14 | ARI is event-sourced from news headlines: attention bias, keyword classification, judgment-call component weights, one curator (0.3.1) | ari.index | w=2; ranked as a level vs its own weekly history; methodology cited per sidecar |
| B15 | Survivorship: the GitHub repo set is 2026's winners picked in 2026; repos born after 2019 add to the totals from their first release (0.4.1) | github.releases_year, commits_month, stars_snapshot | w=1 each; 0.6.0: the page shows the like-for-like ratio (repos releasing in both years: 2019 → 2025 ×1.6, not ×8.0) and the bot-cut share beside the raw × |
| B16 | Self-tagged topics: owners add topics any time; counts are as retrieved; deleted repos vanish; topic:mcp before 2024-11 is retro-tagging (0.5.0) | github.tool_repos_month, lean_repos_month | 0.6.0: scored per million new GitHub repos (`norm=github.all_repos_month`) — GitHub's own growth went ×2.25 in the 12 months to 2026-09 |
| B17 | A lag-1 rebound after a shock reads as a beyond-trend gain: world life expectancy 2022–23 is mostly recovery from the 2020–21 COVID fall (0.6.0) | owid.life_expectancy | disclosed in the mapping rationale and provenance `bias[]`; level shown beside the score |
| B18 | World-condition indicators in AI realms: war deaths, unemployment, CO₂, poverty, life expectancy, GDP, democracy, Lean repos describe the world AI lands in; they show nothing about AI causing it (0.6.0) | every `measures=world` series | `measures` column; `modes.strict` (the AI-only set) published beside the headline and drawn by the page's STRICT AI lens; the conflict-deaths rationale no longer calls war "the weapons arm of the leash breaking" |

### 7.2 The existing news/attention pipeline (`veraldar-site/pipeline/`) — decision
**Dropped from the percentages in v0. A `pulse` channel is specified but off.
Agent votes kept as a disclosed, capped overlay. Publish mechanics kept.**

Why the lexicon scorer (`score.py:score`, `collect.py`, `lexicons.py`) cannot feed an honest number:
- **Not reproducible.** Inputs are live headline lists (HN, Reddit, Google
  News, GDELT) re-fetched each run; the item set is never stored, so no number
  traces to a snapshot. Violates the locked decision "every number traces to a
  raw snapshot".
- **Path-dependent.** `EMA_NEW = 0.35` against the *last published* file:
  today's number depends on every past run's news. Same inputs ⇒ different
  outputs. Violates README principle 4.
- **Hand-tuned constants with no evidence:** term points in `lexicons.py`,
  outlet tier/lean tables, `NEGATIVITY_DISCOUNT = 0.8`, corroboration factors
  0.55/0.8/1.0, hand-threshold bonuses (markets, El Niño, war volume). Each is
  a thumb on a realm.
- **Measures news, not the world.** News is negativity- and novelty-selected;
  the old output (terminus 31.5, stagnation 0.5 on 10-02) reflects that.
- **Sources fail the catalog:** Yahoo Finance (terms forbid redistribution),
  UK carbon intensity (not world), GDELT (429 from this host), headline text
  (copyrighted, cannot be stored in a public repo).

Kept:
- **Agent roots** (`score.py:agent_roots`, `agents_api.py`): opinions, not
  evidence, but disclosed on the page with their own `world_weights` beside
  the blend. Rule unchanged: each agent's latest vote in 7 d, tier weights
  0.8/0.55, α = min(0.15, n/500). Enabled only by `WT_AGENT_VOTES=<path to
  agent_votes.jsonl>`; provenance records α, vote count, and the sha256 of the
  votes file. Off in M2 (lab has no votes file); on at cutover.
- **Publish mechanics:** atomic tmp+rename, chmod 644, `history.json` merge
  and `feed.xml` RSS (`score.py:publish/merge_history/emit_rss`) — reused at
  cutover against `out/history.csv`, not in M2.
- **The structured probes** the old pipeline already had (arXiv momentum,
  PubMed, Mauna Loa CO₂) — rebuilt as M3 sources with stored snapshots.

Re-entry criteria for a `pulse` channel (each is a minor bump): (1) inputs
stored as counts per day per query with sidecars (no headline text); (2) a
source with an open license and a working keyless endpoint from this host
(GDELT timelinevol once it stops returning 429); (3) mapping rows `w=1`,
`rank_delta` on counts — no lexicon points; (4) capped at ≤ 10 % of every
realm's W_used; (5) one month of shadow runs in `runs/` showing the jump gate
is not tripped by it alone.
