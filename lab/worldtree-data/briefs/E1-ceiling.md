# E1 brief — the free-data ceiling: source list, country granularity, honest limits

Worker for [LAB] worldtree-data. User demand: 8 sources / 23 indicators is NOT enough — maximize free/open coverage so the world map shows REAL world data (countries visibly represented, not a sparse sample). You judge the ceiling and prove it with live probes. You WRITE ONE DOC; the builds (E2/E3/E4) come after coordinator review of it.

## Read first
- ~/Work/bifrost/docs/worldtree/sources.md + catalog/registry.json (current 8 sources; note the rejected list and WHY — no-key rule, licenses)
- ~/Work/bifrost/docs/worldtree/prediction.md (method 0.3.0: world-vs-own-history normalization; per-number provenance discipline)
- Constraints: ZERO money. Keyless endpoints preferred. Sources needing FREE registration get classified [account-required] and listed as limits — do NOT create accounts. Licenses must permit redistribution with attribution (that's what /data/ does).

## Probe LIVE from this host (curl; record HTTP code + a sample count in the doc)
Candidates to judge (AGI judgment — add your own if you find better):
- World Bank Indicators API v2 (already used for 2 indicators — judge the FULL usable set: how many indicators are realm-relevant and country-year shaped? e.g. WDI topics + Worldwide Governance Indicators + education (EdStats) + health (HNP) — all same API, keyless)
- OWID grapher (any chart slug → .csv + .metadata.json — how many relevant slugs exist? judge via https://ourworldindata.org/catalog or the grapher metadata endpoints; sample 10+ candidate slugs per realm and prove 200s)
- UN SDG Global Database API (unstats.un.org/sdgapi — keyless, country × series × year)
- WHO GHO OData (ghoapi.azureedge.net/api/INDICATORCODE — keyless, country × year)
- FAOSTAT bulk CSVs / API (bulks-faostat.fao.org — keyless?, country × year: emissions, food security, production)
- UNDP Human Development Reports API (api.open.undp.org — keyless? HDI/GDI per country)
- WIPO, ILO ILOSTAT (api.ilo.org keyless?), UNESCO UIS (apiuis.unesco.org keyless? — research/education)
- UCDP API (ucdp.uu.se — keyless? country-year conflict already via OWID — direct API could add granularity)
- ACLED (free tier = registered key → [account-required])
- V-Dem direct (dataset via web form/email → prefer OWID mirrors; classify)
- Natural Earth (public-domain country outlines for the map SVG — prove the 110m download, judge size after simplification, cite)
Also: re-examine the rejected list — Stanford AI Index (no stable endpoint?), Freedom House (license), any that flip under deeper inspection.

## Judge the ceiling — the doc answers
1. SOURCE LIST (final): per source — id, endpoint(s) proven live (HTTP 200 + sample), granularity (country×year?), depth (how far back), license + attribution line, realm coverage, retrieval method (bulk CSV vs REST), cost=0 proof, keyless or [account-required].
2. INDICATOR TARGETS per realm: a concrete numbered target list (utopia: N indicators, divergence: N, …) with names+endpoints — aim: total ≥100 realm-relevant indicators, ≥150 countries represented, per-country where the source allows. World-level pulse sources (arxiv/pubmed/fedreg/noaa/epoch/wiki) stay as-is.
3. COUNTRY SCORES: is per-country realm scoring (7 percentages per country) feasible+ Honest about the method change: cross-sectional percentile (country vs world that year) for country panels, vs own-history for world series — provenance discipline identical. Say what the map gains: choropleth per realm with per-country values + provenance.
4. HONEST LIMITS: which countries/regions/indicators CANNOT be covered free (data-gap regimes: PRK, TKM, ERT, SYR gaps; small states missing from series; account-required list: ACLED, GTD, Comtrade free tier…; sub-national impossible; recency lags).
5. MAP DATA: Natural Earth simplification budget (target ≤80KB inline SVG for ~180 countries at 110m simplified), license/attribution line, where the build stores it (data layer + provenance sha).
6. BUILD CUT for E2 (fetch layer v2) + E3 (method 0.4.0 country panel) + E4 (page map v2): ordered steps, each with a HARD verify command, keeping m3/m5_green green. Include size budget for /data/ (current 292K series + new: estimate; keep webroot payload ≤~15MB).

## Rules
- Read-only on the repo except the ONE deliverable: ~/Work/bifrost/docs/worldtree/expansion-ceiling.md.
- Every endpoint claim carries a live proof line (command + HTTP code) from today.
- Honest > optimistic: where a source disappoints (paging hell, licensing trap, thin coverage), say so and drop it.
- End your run with: wc -l of the doc + the final source count + total indicator target + country count target + the top-3 honest limits.
