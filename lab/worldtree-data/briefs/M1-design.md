# M1 brief — worldtree-data design docs

You are the worker for the [LAB] worldtree-data mission. Coordinator: the opencode session that spawned you. Read this whole file before writing anything.

## Mission
Rework the data system behind veraldar.org's civilization-outcomes tree (the page at ~/Work/veraldar-site/world-tree.html). THREE axes:
1. COLLECTION — past+present world data, FREE/OPEN sources only (no API keys, no paid tiers). Candidates to judge (not a mandate): Our World in Data, World Bank open API, UN data, GDELT, V-Dem, Freedom House, arXiv API, Wikipedia pageviews, Stanford AI Index underlying data, Epoch AI open database, Hugging Face API.
2. STORAGE — open formats, git-friendly, queryable by ANY agent with a shell (CSV/JSON/MD primary; single-file engines like duckdb/sqlite allowed; vector DB only if justified in writing).
3. PREDICTION — the 7 outcome percentages computed honestly: documented method, provenance per number, staleness/coverage gates.

## Read first (evidence)
- ~/Work/bifrost/docs/lab-playbook.md (how this lab must run)
- ~/Work/veraldar-site/realms.json (THE page data contract, current)
- ~/Work/veraldar-site/world-tree.html — study ONLY the data contract: fields fetched (updated, window, colors, weights summing ~100, world_weights, dimensions, definitions, top, sources, feeds, agent_roots), the stale-hours rule, the embedded-snapshot offline fallback.
- ~/Work/veraldar-site/pipeline/*.py (what exists today: news/attention lexicon scorer — you are designing its structured-indicator successor; say what you keep vs replace and why)

## The 7 realms (fixed, from realms.json)
utopia / divergence / drift / control / terminus / stagnation / transcendence — definitions verbatim from realms.json. Percentages must sum to 100.

## Locked decisions (do not redesign)
- Page seam = realms.json, unchanged. The future pipeline emits a compatible realms.json + richer provenance files. The page itself never changes.
- Zero cost, forever. Every source: license + exact endpoint + no-key proof in the catalog.
- Storage lives in a git repo (lab/worldtree-data/), plain files, append-only raw snapshots, hashed; provenance sidecar per file (source URL, retrieval timestamp, sha256, license).
- Every published number traces: number → indicator series → raw snapshot → source URL. Method is versioned (semver) with a changelog.
- Territory: write ONLY under ~/Work/bifrost/docs/worldtree/ (new dir, docs only). No code in this milestone. Touch nothing else.

## Free territory (yours)
Which sources make the cut, which indicators, the indicator→realm mapping philosophy, the normalization approach, the honesty gates, how agent-queryability is shaped. Judge by one criterion: what best feeds HONEST outcome percentages for the 7 realms.

## Deliverables (this milestone)
- docs/worldtree/README.md — overview, principles, realm glossary, how the three axes connect.
- docs/worldtree/sources.md — source catalog: per source: what it measures, endpoint, license, update cadence, realms it feeds, cost=0 proof. Include at least 6 vetted sources with REAL endpoints (verify each URL is well-formed and plausibly live; note retrieval style: REST/CSV download/RSS).
- docs/worldtree/schema.md — directory layout of the data repo, file formats, manifest.json spec (exact fields), provenance sidecar spec, agent query contract with copy-paste example commands (grep/duckdb/pandas).
- docs/worldtree/prediction.md — the method: indicator→realm mapping table (realm ← indicators ← transform ← weight), normalization rule, sum-to-100 rule, per-number provenance format, honesty gates (coverage floor, staleness limit, known-bias register, version bump rules), and how the existing news/attention pipeline slots in (kept as one pulse channel vs structured indicators, or dropped — your call, argued).
- docs/worldtree/plan.md — the milestone cut for pipeline v0 (M2): ordered steps, each with a HARD verify command, ending green: ≥2 free sources fetched for real → data stored git-friendly → percentages computed with per-number provenance → realms.json emitted that satisfies the page contract.

## Quality bar
- A stranger agent must be able to implement M2 from your docs alone.
- Every endpoint you list must be one you checked exists (fetch it or its docs).
- No filler. Short, dense, complete.
- End your run with: ls -la ~/Work/bifrost/docs/worldtree/ and a one-line summary per file.
