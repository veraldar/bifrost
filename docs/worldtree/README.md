# worldtree — data system behind veraldar.org's world-tree

Design docs (M1). No code here. The pipeline built from these docs lives in
`~/Work/bifrost/lab/worldtree-data/` (git repo, plain files). The page
(`~/Work/veraldar-site/world-tree.html`) never changes: its only seam is
`realms.json`.

| file | what it settles |
|---|---|
| [sources.md](sources.md) | which free/open sources make the cut, exact endpoints, license, no-key proof |
| [schema.md](schema.md) | repo layout, file formats, `manifest.json`, provenance sidecars, agent query contract |
| [prediction.md](prediction.md) | method v0.1.0: indicator→realm table, transforms, sum-to-100, gates, bias register, the old news pipeline's fate |
| [plan.md](plan.md) | M2 cut (pipeline v0): ordered steps, each with a hard verify command, ending green |

## What the numbers are (and are not)
The seven percentages are an **evidence share**: of the measured movement in
the world right now, how much points toward each realm. They are not
probabilities that a realm "happens", and the page's wording should be read that
way. Every number decomposes, by file lookup, into: realm weight → indicator
scores → indicator series → raw snapshot (sha256) → source URL + license.

## Principles
1. **Zero cost, forever.** Only sources reachable with a plain HTTP GET, no key,
   no account, no paid tier. Proof per source in `sources.md`.
2. **Open license or out.** A source with no stated reuse license is not stored
   in the repo (it may be listed as *candidate*).
3. **Append-only raw.** What was fetched is kept byte-for-byte, hashed, with a
   sidecar. Derived files are regenerable from raw; raw is never edited.
4. **Deterministic.** Same raw snapshots + same method version ⇒ byte-identical
   `realms.json`. No path dependence (the old EMA-against-last-publish is gone).
5. **Missing data pulls toward "don't know", never toward a realm.** Coverage
   shrinks a realm's evidence to neutral; stale series are excluded, loudly.
6. **Method is versioned (semver) with a changelog**; any change that can move a
   number is at least a minor bump.
7. **Shell-queryable.** CSV/JSON/MD only; any agent with `jq`, `grep`,
   `sqlite3` or `duckdb` can answer "why is terminus 31%?" No vector DB — nothing
   here is a similarity-search problem (≈25 series, ≈10⁵ rows).

## Realm glossary (verbatim from realms.json)
| realm | definition | measured mainly by |
|---|---|---|
| utopia | AI broadly solves material problems — health, abundance, education | poverty, life expectancy, AI×biomed output, income |
| divergence | intelligence escapes the few — open weights, local models, many small actors | open-weights share and org/country diversity of notable models |
| drift | attention eats everything — virality, slop, synthetic media, no direction | gen-AI mass use, attention to deepfakes/synthetic media |
| control | humans keep the leash — regulation, audits, lawsuits, treaties | AI rulemaking volume, democratic-institution strength |
| terminus | the leash breaks badly — job losses, weapons, scams, existential risk | conflict deaths, unemployment, CO₂ growth, x-risk attention |
| stagnation | the revolution stalls — winters, plateaus, overpromising, disillusion | AI investment, corporate adoption, frontier compute, research volume (all inverted) |
| transcendence | the horizon dissolves — superintelligence, minds beyond minds | frontier benchmark (FrontierMath), frontier compute, AGI attention |

## How the three axes connect
```
COLLECTION                      STORAGE (lab/worldtree-data, git)            PREDICTION
sources.md catalog ──fetch──▶ raw/<src>/…  + .prov.json (url, ts, sha256, license)
                                   │ parse (deterministic)
                                   ▼
                              series/<indicator>.csv   (date,value + snapshot sha)
                                   │ method vX.Y.Z (prediction.md)
                                   ▼
                              runs/<run_id>/provenance.json ──▶ out/realms.json  (page contract)
                                                               out/realms.provenance.json
                                                               out/history.csv
```
- Collection decides *what is observable for free*; prediction only uses
  indicators registered in `catalog/indicators.csv`, each pointing at one source.
- Storage is the audit trail: the provenance file of every run lists, per realm,
  every indicator used, its score, and the sha256 of the raw file it came from.
- Gates (staleness, coverage, history length) live between series and realms;
  when they fail, the pipeline does **not** publish and the live page goes
  STALE on its own after 24 h — the honest outcome.

## Relation to the current pipeline
`veraldar-site/pipeline/` (news/attention lexicon scorer) is superseded as the
primary signal. Decision and reasoning: `prediction.md` §7. Short version: its
agent-votes channel and publish mechanics are kept; its lexicon/headline scoring
is demoted to an optional, capped, provenance-gated *pulse* channel (off in v0);
Yahoo/UK-grid/hand-threshold bonuses are dropped.

## Cutover
M2 writes `out/realms.json` inside the lab repo only. Replacing the live
`/var/www/veraldar/realms.json` is a separate step that needs the user's go.
