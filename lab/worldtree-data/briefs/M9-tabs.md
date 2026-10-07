# M9 brief — the tree page becomes TABBED: OUTCOMES / AI EVOLUTION / SOURCES MAP

Worker for [LAB] worldtree-data. STRUCTURE CHANGE (user): the GitHub/AGI-evolution-speed data is NOT a worldtree branch — it is a separate story: THE EVOLUTION OF AI. Tabbed views over the same data spine. KISS: no framework, no router lib, same design tokens, provenance discipline identical on every tab.

## Current state (read first)
- veraldar-site HEAD (includes M6's local page edits + another session's menu-link commit — build ON all of it, revert nothing you don't replace deliberately).
- world-tree.html today: story/tree/HUD (OUTCOMES core), rings (10·trend), soil (11·geography, per-source regions), atlas (12·atlas, country choropleth), roots (09·provenance). M6 added github-trends.json lines as rings-overlay — MOVE that content into the new tab (the overlay in rings goes away; the rings chart itself stays clean 7-line).
- Data spine (all same-dir fetches, all live): realms.json, realms-history.json, countries.json, data/countries-paths.json, github-trends.json (+ provenance sidecars). All already published 200.

## Build
1. **Tab UI**: header gains 3 tabs — `OUTCOMES` / `AI EVOLUTION` / `SOURCES MAP` (same chip/button grammar the page already uses; INK colors only from existing tokens; keyboard focusable; aria-selected; hash routing #outcomes/#evolution/#sources so links are shareable; default = OUTCOMES; hash on load selects). Sections group under tabs: OUTCOMES = story/tree/HUD/rings/roots; AI EVOLUTION = new section; SOURCES MAP = soil + atlas. Non-active tabs hidden (display:none via the existing [hidden] pattern — no animation framework, at most the state-law opacity the page already uses).
2. **Tab 2 — AI EVOLUTION** (the M6 github-trends data, promoted): full-width chart section `AI EVOLUTION — the exponential`: releases/year by year (bar or line, 2015→now), commits/month (line, accumulating), stars snapshot (small table or dots per repo), compute-growth line if present in github-trends.json. Each chart: same SVG grammar as rings (gl/ln/cur classes), inline labels, and a provenance line per chart (github-trends.json sha256 → /data/ → api.github.com endpoints → licenses; the 60/hr + 10/min budget note). Exponential callout: the ×8.0 releases/yr 2019→2025 and ×10.4 decade-mean numbers, shown as text in-grammar. The realm-mapping note (releases → divergence+transcendence) stated plainly.
3. **Tab 3 — SOURCES MAP**: move soil + atlas sections under it unchanged (they already have their own provenance lines).
4. **Offline honesty**: tabs render from whatever fetched; failed fetches keep their sections hidden as today; the tab bar itself always renders.
5. **sw.js**: bump to v5. 
6. **Verify**: node syntax check of inline JS; deploy (scp world-tree.html + sw.js to veraldar:/var/www/veraldar/, chmod 644; backups exist pattern: .pre-m9.bak); `bash tests/m6_github.sh` must end GREEN (its line "live page fetches github-trends.json" now passes); m3+m5 stay green; playwright screenshots from ~/Work/bifrost/pwa → artifacts/worldtree-tab-{outcomes,evolution,sources}.png.

## Rules
Territory: veraldar-site/world-tree.html + sw.js (+ artifacts). Do NOT touch lab/worldtree-data or /data. Commit per step in veraldar-site (req-linked messages). Twice-failing step → BLOCKER-M9.md. The tree itself, its motion, tokens, copy law: FROZEN — tabs are chrome around it. End with: commit hash, deployed curls (tab markers in served HTML), three screenshot paths, m3/m5/m6 last lines.
