# M1-finish brief — complete the design docs

Worker for [LAB] worldtree-data. The M1 run was interrupted: 3 of 5 docs exist.

## Done already (do not rewrite — read for consistency)
- ~/Work/bifrost/docs/worldtree/README.md
- ~/Work/bifrost/docs/worldtree/sources.md
- ~/Work/bifrost/docs/worldtree/schema.md

## Still missing (write these two, matching the three above)
1. ~/Work/bifrost/docs/worldtree/prediction.md — the method per the original brief (read ~/Work/lab/worldtree-data/briefs/M1-design.md, sections "prediction" + "Locked decisions"): indicator→realm mapping table (realm ← indicators ← transform ← weight), normalization rule, sum-to-100 rule, per-number provenance format, honesty gates (coverage floor, staleness limit, known-bias register, version bump rules), and how the existing news/attention pipeline (~/Work/veraldar-site/pipeline/) slots in vs structured indicators — kept as one pulse channel or dropped, your call, argued.
2. ~/Work/bifrost/docs/worldtree/plan.md — M2 pipeline-v0 milestone cut: ordered steps, each with a HARD verify command, ending green: ≥2 free sources fetched for real → git-friendly storage per schema.md → percentages with per-number provenance → realms.json emitted satisfying the page contract (fields from realms.json; weights sum 100; updated ISO; feeds/sources/dimensions may be honest minimal values, never fabricated).

## Sources of truth
- realms.json contract: ~/Work/veraldar-site/realms.json (+ fetch/stale/fallback behavior in world-tree.html)
- original brief: ~/Work/lab/worldtree-data/briefs/M1-design.md
- sources you may use: whatever sources.md already vetted (stay consistent with it)

Quality bar: a stranger agent implements M2 from plan.md + the other docs alone. No filler. End with ls -la ~/Work/bifrost/docs/worldtree/ + one-line summary per new file.
