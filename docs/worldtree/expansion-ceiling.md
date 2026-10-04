# Expansion ceiling — max free/open coverage for the worldtree (E1)

Probed live 2026-10-04 from this host (UA `worldtree-data/0.1`, all HTTP codes from real fetches).
Verdict up front: **~90-100 realm-relevant indicators across 9 global sources, ~190 countries
with ≥3 indicators each** is feasible keyless TODAY. The map becomes a country choropleth
(per-country realm scores), not a 7-region sketch. What cannot be covered free is listed and
is small: data-gap regimes, 5 account-gated sources, sub-national granularity.

## 1. Source list (final)

| id | source | proof (10-04) | granularity | depth | license | realms |
|---|---|---|---|---|---|---|
| `owid` | OWID grapher (kept, expand 8→~25 slugs) | 200 (in prod) | country×year | decades–centuries | CC BY 4.0 | all |
| `worldbank` | WB API v2 (kept, expand 2→~40 indicators: WDI + WGI + HNP + EdStats + ICT) | 200 (in prod) | economy×year (217) | 1960+ | CC BY 4.0 | all |
| `un_sdg` | UN SDG Global Database API | 200 (11.6KB sample; GeoArea list 27.5KB ≈250 areas) | country×series×year | ~2000+ (series-dep.) | UN terms, attribution | utopia, terminus |
| `who_gho` | WHO GHO OData (`ghoapi.azureedge.net/api/<CODE>`) | 200 (WHS4_100, 1.7KB @ $top=3) | country×year | 1980s+ | public domain (WHO) | utopia, terminus |
| `fao` | FAOSTAT bulk CSV zips (`bulks-faostat.fao.org`) | 200 (33.9MB normalized zip) | country×year | 1961+ | CC BY 4.0 | utopia, terminus |
| `ilo` | ILOSTAT rplumber (`rplumber.ilo.org/data/indicator/?id=…&ref_area=…`) | 200 (700KB JSON, needs filters) | country×year | 1990s+ | ILO open terms | stagnation, terminus, utopia |
| `ari` | Agent Restriction Index (user's Mac Studio, tailnet) | 200 (in prod, method 0.3.1) | weekly global | 26wk+ | pipeline capture | control |
| `epoch` / `wikimedia` / `arxiv` / `pubmed` / `fedreg` / `noaa_gml` | kept as-is | 200 (in prod) | global / org-HQ country | varies | as cataloged | divergence, drift, stagnation, transcendence, control |
| `ne` | Natural Earth 110m GeoJSON (map outlines only, not an indicator) | 200 (838KB → simplify ≤80KB) | country polygons | static | public domain | — (map layer) |

Dropped / probe-failed: UNESCO UIS (unreachable from this host, `000`), UCDP direct API
(401 — gated; OWID's UCDP mirror already in), UNDP HDR API (404 — re-probe alternate path
in E2; low value, HDI mirrored by WB/OWID series), FAOSTAT API endpoints (401 — bulk zips
work instead), Eurostat/OECD (regional scope, SDMX weight).

**Account-required — honest limits (no key, no registration per no-key rule):**
ACLED (conflict events), GTD, EM-DAT (disasters), WIPO API (patents — WB `IP.PAT.RESD`
mirrors counts), UN Comtrade free tier (trade flows). V-Dem direct (web form) → use OWID
mirrors (`electoral-democracy-index` already in; can add `press-freedom-index`? — OWID
hosts RSF press freedom? verify slug in E2; if absent, WB WGI Voice&Accountability covers
the dimension).

## 2. Indicator targets per realm (country-panel unless marked global)

- **utopia (~28)**: WB: SH.DYN.LE00, SH.XPD.CHEX.GD.ZS, SE.XPD.TOTX.GD.ZS, EG.ELC.ACCS.ZS, SH.H2O.BASW.ZS, SH.STA.BASS.ZS, IT.NET.USER.ZS, IT.CEL.SETS.P2, NY.GDP.PCAP.KD, SI.POV.DDAY · OWID: energy-per-capita, electricity-access, clean-cooking, vaccine-coverage, food-supply, cheap-green-energy · WHO: UHC_SERVICE_INDEX, WHOSIS_000003 (maternal mortality), medical doctors density · UN SDG: 1.1.1 poverty, 2.1.1 undernourishment, 2.1.2 food insecurity, 3.8.1 UHC · FAO: prevalence-of-undernourishment, food-supply-adequacy · ILO: working-poverty-rate.
- **divergence (~12)**: WB: IT.NET.USER.ZS (shared), IP.PAT.RESD patents-resident, fixed-broadband · Epoch: notable-models-by-org-country, open-weights-by-country · OWID: smartphone-affordability, internet-users · UNESCO-mirror series via UIS-in-OWID (researchers per million, R&D %GDP) · plus org-diversity/country-diversity (kept).
- **drift (~7)**: kept wikimedia attention series (global) · OWID genai-user-share (country where published) · OWID social-media-share · WB? none — drift stays the thinnest country realm; disclosed.
- **control (~11)**: ARI (kept, weekly) · fedreg (kept, US) · OWID: electoral-democracy-index (country-year), press-freedom if mirrored · WB WGI: VA.EST (voice/accountability), RL.EST (rule of law), RQ.EST (regulatory quality), GE.EST, CC.EST, PV.EST · OECD.AI policy count (probe in E2; else UNESCO AI-policy via SDG metadata).
- **terminus (~14)**: OWID: conflict-deaths (country-year, kept), disaster-deaths, terrorism? (OWID mirrors GTD pre-gate years) · WB: SM.POP.REFG refugees, VC.IHR.PSRC.P5 homicides, SL.UEM.TOTL.ZS · WHO: suicide-rate (MH_12), road-injury deaths · FAO: food-variation, undernourishment (shared) · noaa CO₂ (kept global) · ILO: informal-employment, fatal-occupational-injuries.
- **stagnation (~9)**: Epoch: frontier-compute 12-mo growth by org country (kept, split by country) · WB: GB.XPD.RSDV.GD.ZS R&D, IP.PAT.RESD (shared), NY.GDP.PCAP.KD.ZG growth · ILO: productivity-per-worker · OWID: chip-price-index (global), TFP proxy (global) · arXiv cs.AI momentum (kept).
- **transcendence (~8)**: Epoch: frontiermath, notable-models, training-compute by country (kept/split) · OWID: AI-benchmark bests (global) · wikimedia AGI attention (kept) · WB: high-tech-exports TX.VAL.TECH.CD · arXiv momentum (shared).

**Totals: ~89 indicators (≈70 country-panel), 9 global sources + 6 kept, ≥190 countries
with ≥3 indicators (WB 217 economies, UN SDG ~250 areas, WHO 194, FAO ~200, deduped).**

## 3. Country scores (method 0.4.0)
Per-country realm score = cross-sectional percentile (country vs all reporting countries,
per indicator, per as-of year — no lookahead, same as world method), weighted by the same
mapping table (country rows carry `geo` scope). World tree percentages stay computed by the
existing world method (0.3.1 semantics unchanged). Provenance identical: per country ×
indicator × year → series_sha256 → raw → source URL. Provisional flag per country × realm
when coverage <0.5.

## 4. Honest limits (what free cannot cover)
- **Data-gap regimes**: PRK, TKM, ERY, SYR, SOM (partial), VEN (patchy) — few or no WB/WHO/SDG rows; map shows them as no-data, never interpolated.
- **Account-gated (listed, not used)**: ACLED, GTD, EM-DAT, WIPO API, Comtrade — event/trade granularity stays out unless the user registers; today's mirrors (OWID conflict/terrorism series) cover the aggregate.
- **Sub-national**: impossible free at scale (city-level AI-economy data is commercial).
- **Recency lags**: SDG 2-3y, FAO ~1-2y, WB ~1y — method's as-of gates already disclose series dates.
- **drift** country-panel stays thin (attention data is platform-proprietary): 7 indicators, mostly global.
- **AI-specific country data** = org-HQ attribution (Epoch) → concentrated US/CN/UK/EU; disclosed on the map caption.

## 5. Map data
Natural Earth 110m admin-0 (public domain) 838KB GeoJSON → simplify (quantile decimation,
project once to the page's equirectangular frame) → `countries-paths.json` ≤80KB in /data/ +
fetched by the page for the choropleth. Provenance: NE download URL + sha256 in manifest;
page caption credits Natural Earth.

## 6. Build cut (E2/E3/E4) — each step's hard verify
- **E2a** fetchers: `un_sdg`, `who_gho`, `fao`, `ilo` + WB/OWID catalog expansion → raw + sidecars; verify: `wt fetch` → new raws with 200 sidecars, `wt check integrity`.
- **E2b** extractors + catalog: series files (long-format country CSVs: `series/wb.SH.DYN.LE00.csv` = country,year,value) + registry/mapping rows (~89); verify: `wt check catalog` new counts, row counts per series ≥50 countries.
- **E2c** map asset: `wt mapdata` → countries-paths.json (≤80KB, 177 shapes) + manifest sha; verify: size + shape count + /data/ 200.
- **E3** method 0.4.0: cross-sectional scoring + `wt countries --as-of D` → `out/countries.json` (worldtree.countries/1: {country:{iso, name, realms:{7 scores}, coverage, provisional, provenance_sha}}) + tests: no-lookahead, determinism, sum-normalization where world aggregate, per-country provenance sha; verify: `bash tests/m6_green.sh` (m3+m5+m6).
- **E4** page: map section v2 (choropleth per realm + toggle, realm colors, provisional hatching, country focus → values + provenance sha), Natural Earth credit; deploy + live screenshot verify.

**/data/ size budget**: current 292KB series → +~8-12MB (WB/OWID/SDG long CSVs) + 80KB paths →
well under the 15MB cap. Webroot page stays <200KB.
