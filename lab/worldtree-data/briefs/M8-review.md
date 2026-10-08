# M8 brief — AGI reflects: is the picture truthful? (referee + mandate)

Worker for [LAB] worldtree-data. The USER'S DIRECTIVE, verbatim: "AGI should let AGI reflect and judge on what to do to show a **truthful and honest** picture of data and trends." You are AGI reflecting on your own system. This is NOT a checklist audit — the checklist below is fuel, the judgment is yours. You may change the system where your reflection demands it.

## The system you are judging
- veraldar.org world-tree.html: tabbed OUTCOMES / AI EVOLUTION / SOURCES MAP. Tree with 7 realm percentages; rings (per-year 2015→now); atlas (per-country scores); soil (source geography); roots (provenance); AI EVOLUTION (github exponential).
- Data: ~/Work/bifrost/lab/worldtree-data — 14 sources, world + country panels, method 0.4.x, gates, sha-provenance, fixtures. Design docs: docs/worldtree/*.md.

## Reflect on (your judgment, not limited to)
1. **What do the percentages MEAN?** Realm weights are percentile-derived evidence scores summing to 100 — a visitor may read them as probabilities of the future. Is the page honest about what a "20.0%" terminus is and is not? Judge whether the framing/labels/notes tell the truth, and fix the words (page copy in existing grammar, DATA.md, prediction.md) — numbers only if you find a real defect.
2. **Selection bias**: the indicator set is what we COULD measure free. Where does the map/tree overclaim ("the world" vs "the measurable world")? Where do absent dimensions (culture, institutions quality, energy breakthroughs, bio, robotics...) distort the picture? Judge: disclose better, or add a missing measurable indicator, or both.
3. **Trend honesty**: rings start 2015 with provisional years; percentile-vs-own-history means "unusual for itself", not "good/bad absolutely". Are the trend lines readable as directions when coverage shifts across years? Judge whether presentation misleads and fix presentation/labels.
4. **The github exponential**: release/star counts from a chosen repo set — survivorship and selection bias (we picked famous repos). Is the ×8.0 story honest as presented? Judge disclosure vs curation.
5. **Staleness & gaps**: excluded indicators, data-lag years, small states, no-data regimes — is every gap VISIBLE to a visitor (not just in docs)?
6. **Anything else your reflection surfaces** — you have full read access; follow the smell.

## Rails (hard)
- Brand/design frozen: fix TRUTH (copy, labels, notes, gates, numbers if defective) — never restyle.
- Never fabricate: every number stays traceable; new disclosures come from real data.
- All gates must end green (m3, m5, m6_github, m6_countries); method bumps semver + CHANGELOG + fixture refreeze.
- Territory: lab/worldtree-data + veraldar-site/world-tree.html/sw.js + docs/worldtree/ + DATA.md. M10 may still be running on the same files — WAIT for it (poll `pgrep -f "claude -p"` until idle, then `git -C ~/Work/bifrost pull` is unnecessary: same tree; just `git -C ~/Work/bifrost log --oneline -3` to see what landed and build on it).

## Deliverables
1. docs/worldtree/honesty-review.md — your reflection: what you judged misleading or at-risk, what you changed and why, what you deliberately left alone and why. Ranked: changed / disclosed-only / considered-rejected. No filler.
2. The fixes themselves, committed (pathspec-scoped), all gates green, published live.
3. End with: the changed/disclosed/rejected summary, all greens' last lines, `git log -5` (both repos), and your one-sentence verdict on whether the picture is now truthful.
