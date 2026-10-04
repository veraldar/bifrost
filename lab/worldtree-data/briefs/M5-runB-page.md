# RUN B brief — the tree page: trend lines + source-geography map + cadence line

Worker for [LAB] worldtree-data. You build the PAGE. The coordinator verifies with a screenshot.

## Prime directive
THE LOOK IS FROZEN (v0.6.0 cohesive design). You add three features to ~/Work/veraldar-site/world-tree.html in EXACTLY the existing visual language: same CSS custom properties, same typography, same section grammar (numbered kickers like `09 · provenance`), same line-art inline-SVG aesthetics, same motion discipline (no JS animation loops). The tree itself is untouched. Zero new dependencies, zero external network calls beyond the same-directory JSON the page already fetches. If a design decision isn't dictated by existing page style, don't invent — extend the pattern you find.

## Read first
- ~/Work/veraldar-site/world-tree.html — the WHOLE file: fetch/stale/offline logic (realms.json + embedded SNAP fallback), section structure, how roots/provenance render, badge states.
- Live data (curl them): https://veraldar.org/realms.json (note additive blocks: refresh, geography, history pointer), https://veraldar.org/realms-history.json (schema worldtree.history/1: years[] each {year, weights{7}, coverage{7}, provisional{7}, provenance sha}), https://veraldar.org/realms.provenance.json.

## Feature 1 — trend section (`10 · trend`)
- Fetch ./realms-history.json on load (same pattern as realms.json; graceful: fetch fail or missing → hide the section and say nothing — offline stays honest).
- One chart, 7 lines, 2015 → now: SVG polyline per realm using realms.json colors (exact hex from the colors block), years on x, % on y. Provisional years: dashed segment or reduced opacity + a one-line legend note ("dashed = provisional · thin data before ~2021 — honesty, not style").
- Pointer/hover/tap a year → readout of all 7 values for that year (existing page interaction style; keyboard focusable).
- Provenance per data point: one line under the chart — every year traces via realms.provenance.json + per-year history provenance (sha256-referenced), link to https://veraldar.org/data/ for the raw series. Include the refresh sentence (feature 3).
- Line ends should connect conceptually to NOW (the tree shows now; the lines show direction) — visually quiet, no markers unless the page already uses them.

## Feature 2 — geography section (`11 · geography`)
- KISS: inline SVG world of simplified region silhouettes — NA, LATAM, EUR, AF, MENA, ASIA, OC — drawn as line-art blobs in page style (no image files, no map library, no tiles, ~<3KB of path data, recognizable silhouettes, not cartographic truth).
- 8 source chips (from realms.json geography block: owid, worldbank, epoch, wikimedia, arxiv, pubmed, fedreg, noaa_gml) with their per-source colors or the page's existing chip grammar. Tap/focus a chip → its regions highlight (regions covered per the geography block; GLOBAL sources light all); the source's detail line + license render in a caption slot.
- Default state (no chip selected): all regions faint, caption reads "pick a source to see where its data comes from" — provenance made visual.
- Regions not covered by ANY source: none expected (fedreg is US-only — US = NA subset; show honestly, e.g. NA highlighted + caption "US federal only").

## Feature 3 — refresh cadence, stated publicly
- In the roots/provenance section and the badge title tooltip: "data refreshed nightly 12:30 UTC (14:30 Europe/Berlin) · worldtree-data method 0.3.0 · sources: 8 free/open" — read values from realms.json refresh block when present (don't hardcode what data can say), fall back to embedded snapshot values offline.
- Keep the existing stale/offline semantics untouched.

## Deploy + verify
1. Backup on host: `ssh veraldar 'cp /var/www/veraldar/world-tree.html /var/www/veraldar/world-tree.pre-m5.bak.html'` (rollback path).
2. Check sw.js: if it caches world-tree.html under a cache key/version, bump the version so the deploy goes live; if not, note it and move on.
3. Deploy: `scp ~/Work/veraldar-site/world-tree.html veraldar:/var/www/veraldar/world-tree.html` + chmod 644 (host has no rsync; user debian).
4. Verify live: `curl -s https://veraldar.org/world-tree.html | grep` your section ids + `curl -sI` 200.
5. SCREENSHOT RECEIPT (mandatory): from ~/Work/bifrost/pwa (playwright + chromium already installed): a tiny node/python playwright script → open https://veraldar.org/world-tree.html, wait for load, full-page screenshot to ~/Work/bifrost/artifacts/worldtree-page-m5.png (and one clipped to the trend section + one to the map). If a screenshot script misbehaves twice, write BLOCKER-RUNB.md and stop.

## Territory
~/Work/veraldar-site/world-tree.html (+ sw.js only if caching pins the page), host webroot world-tree.html + backup (+ sw.js), screenshot artifacts in ~/Work/bifrost/artifacts/. Touch NOTHING else — no data layer, no other pages, no index.html.

## Rules
One commit in ~/Work/veraldar-site (main) with a req-linked message: "feat(page): trend lines + source geography + refresh cadence — req 10-04 M5 run B". Twice-failing step → BLOCKER-RUNB.md. End your run with: the commit hash, the three screenshot paths, and the live curl checks.
