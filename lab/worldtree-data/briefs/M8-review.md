# M8 brief — independent system review (referee pass before the window closes)

Worker for [LAB] worldtree-data. You are a FRESH-EYES referee, not the author. The worldtree data system grew fast today (M0→M6 in one day). Review ALL of it for correctness, honesty, and fragility. Fix genuine BLOCKERS; report everything else.

## Scope (review order)
1. **Method honesty** (docs/worldtree/prediction.md + wt/method.py, wt/history.py, wt/countries.py): percentile semantics vs what the docs claim; window/staleness handling; ties; direction conventions per realm (esp. terminus +1 fix, drift 0 coverage); no-lookahead proofs actually proving it; provisional thresholds; the 0.3.1→0.4.1 bump trail in method/CHANGELOG.md.
2. **Provenance chain end-to-end**: pick 3 random numbers (one world weight, one ring year, one country score) and trace number → series row → snapshot sha256 → raw file → source URL/license. Any broken link = blocker.
3. **Sources**: endpoints/UA/rate-limits vs what fetch actually does; the GitHub 60/hr + 10/min search budgets (does the nightly timer respect them? what happens on 403/429?); silent-empty responses (128B stubs) — does integrity/gates catch them?
4. **Page contract** (veraldar-site/world-tree.html): sw.js cache versioning vs deploys; offline snapshot staleness; the atlas (my code — review hard: CTY/ATC rename completeness, XSS via esc() on all injected strings, CSS-vs-inline-style precedence); rings/soil/atlas fetch failures → graceful hides.
5. **Tests**: what m3/m5/m6 do NOT cover; fixture hygiene (0.1.0→0.4.1); the weakened ARI test (0.3.1 without github rows — acceptable or regression?).
6. **Ops**: worldtree-fetch.timer (14:30 local) — lock contention with manual runs; publish.sh atomicity (data.new swap); /data/ licenses/attribution completeness vs what's published.
7. **M6 spot-audit** (it landed today): briefs/M6-github.md vs what was built; the claim "live atlas was broken (CTY not defined)" — verify against git history whether that was real and whether the fix is correct.

## Rules
- BLOCKERS (wrong number published, provenance broken, gate bypass, data loss, security) → fix immediately + commit (pathspec: lab/worldtree-data, veraldar-site/world-tree.html/sw.js, docs/worldtree/). Everything else → report.
- Write findings to docs/worldtree/review-0.4.md: verdict per scope item (OK / ISSUE n), findings ranked blocker/major/minor/note, each with file:line evidence and (for majors) a one-line fix proposal. No filler.
- Re-run m3/m5/m6(+m6_countries) after any fix; all must end green.
- End with: the findings table (ranked), fixes committed (hashes), all greens' last lines, and your overall verdict in one sentence.
