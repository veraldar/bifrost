# worldtree-data

Data pipeline behind veraldar.org's world-tree page: free open sources →
append-only raw snapshots with provenance sidecars → series → seven realm
percentages (`out/realms.json`) with per-number provenance.

Design docs (spec): `~/Work/bifrost/docs/worldtree/` (README, sources, schema,
prediction, plan). Code: `wt/` (Python ≥ 3.11, stdlib only), entry
`python3 -m wt <cmd>`. Method version: `method/VERSION`.
Green check: `bash tests/m2_green.sh`.
