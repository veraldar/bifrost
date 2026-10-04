# RUN A brief — data layer: nightly timer + method 0.3.0 (history, refresh, geography, public data)

Worker for [LAB] worldtree-data. You EXECUTE. Coordinator verifies. Read docs/worldtree/{prediction,schema,sources}.md + catalog/* first.

## Context (receipts already proven — do not redo)
- Feasibility probe of stored series: owid.life_expectancy 1770+, owid.electoral_democracy 1789+, wb.gdp 1960+, owid.conflict 1989+, owid.poverty 1990+, noaa.co2 1958-03, epoch.* 2015-01 (open_weights 2016-09), arxiv/pubmed/fedreg backfilled to 2019-01 (93 monthly snapshots each), wiki.* floored 2015-07 (API limit). OWID/WB/NOAA/epoch raw files carry FULL history in one file. So per-year percentages to 2015 are feasible NOW; pre-2018 years are thin on AI-specific series → must be honest about coverage.
- M3 repo: ~/Work/bifrost/lab/worldtree-data (in bifrost; run --commit pathspec-scoped — proven safe). Live site: https://veraldar.org serves out/realms.json + realms.provenance.json + feed.xml (method 0.2.0, run 20261004T115730Z). Old news pipeline on host `veraldar` is DISABLED (veraldar-pipeline.timer). Host webroot /var/www/veraldar, ssh alias `veraldar`, user debian, sudo ok, NO rsync (use scp).

## Deliverable 1 — M4c nightly timer (do first, small)
- Write ~/.config/systemd/user/worldtree-fetch.service (oneshot, WorkingDirectory=%h/Work/bifrost/lab/worldtree-data, ExecStart=scripts/nightly.sh, TimeoutStartSec=1800) + worldtree-fetch.timer (OnCalendar=*-*-* 14:30:00 local, Persistent=true, WantedBy=timers.target). scripts/nightly.sh already exists (flock + fetch + run --commit + publish).
- `systemctl --user daemon-reload && systemctl --user enable worldtree-fetch.timer`, verify enabled + next elapse via list-timers.
- Supervised receipt: run `bash scripts/nightly.sh` once; tail nightly.log; confirm a fresh published run + live site updated.
- systemd %-escape: no % literals needed in these units.

## Deliverable 2 — method 0.3.0: per-year percentages (the trend data)
- New cmd `python3 -m wt history --as-of D [--now ISO]`: for each year Y in 2015..(as-of year), as-of = Dec-31 of Y, recompute the EXISTING method with data ≤ as-of ONLY (no lookahead, ever), same transforms/normalization; per-year gates; output `out/realms-history.json`.
- Schema (additive to the page, new file so page contract untouched): worldtree.history/1 — {schema, method_version, as_of, years:[{year, weights{7 sum≈100}, coverage{7}, provisional{7} (true where realm coverage <0.5), ref_n_min, provenance} ], refresh{…}, geography{…}}. Per-year provenance: same indicator-level fields as realms.provenance.json (series_id, series_sha256 as of that as-of, source_url, license, score, contribution) — one provenance blob per year (runs/<run_id>/history.provenance.json), referenced by sha256 in the main file.
- Early-year honesty: use each series' full stored depth; a realm with <50% mapped-weight coverage at year Y gets provisional=true and its weights still sum-normalized (round to 100 with largest-remainder, same as now).
- Unit tests: no-lookahead (a year's score unchanged when future data is added to raw), determinism (pinned --now byte-identical), sum-to-100, provisional flags.
- CHANGELOG: method 0.3.0 entry (what changed, why, date). m3_green.sh must stay green.

## Deliverable 3 — refresh cadence + geography IN the data (user item 1 + 2, data half)
- realms.json (and realms-history.json) gain additive block `refresh`: {cadence:"nightly", local_time:"14:30 Europe/Berlin", utc_time:"12:30 UTC", timer:"worldtree-fetch.timer", pipeline:"worldtree-data method 0.3.0", sources:[{id, updated_from:"<what fetch pulls>"}, …]}. Method emits it (constants in method/VERSION dir); NOT post-hoc edits (hashes must match).
- Additive block `geography`: per source id → {regions:[NA, LATAM, EUR, AF, MENA, ASIA, OC or GLOBAL], detail (one line: what's covered and why), license}. Use documented coverage: owid GLOBAL aggregates; worldbank 217 economies GLOBAL; epoch org HQs (US/CN/UK/EU/CA/KR/JP…, GLOBAL industry); wikimedia GLOBAL en-wiki readers (EN skew disclosed); arxiv GLOBAL submissions (US/CN/EU top); pubmed GLOBAL biomed; fedreg US-federal only; noaa_gml single global-reference station (US-HI). Keep it a curated, cited table (source docs) — no scraping.
- Additive `history` pointer in realms.json: {file:"realms-history.json", sha256}.

## Deliverable 4 — publish + public data (requirements gap: "data isn't public")
- Extend scripts/publish.sh: also scp out/realms-history.json; create webroot /data/ = {series/*.csv, catalog/*, manifest.json, method/*, out/realms.provenance.json, out/realms-history.json, DATA.md (what/why/licenses/how-to-query, copy from schema.md query contract)}; scp -r; append one line to host llms.txt: "Open data: https://veraldar.org/data/ (series CSVs + catalog + per-number provenance)". Verify with curl.
- Keep publish idempotent + <1MB data payload (raw/ stays local).

## Deliverable 5 — tests/m5_green.sh
Ends printing M5 GREEN: m3 still green; history determinism; no-lookahead check; schema checks (refresh/geography/history blocks + per-year sums + provisional logic); /data/ live check (curl 200 on 3 files); live realms.json has refresh block; run it and leave it green.

## Rules
Commit per step (pathspec-scoped). A step failing twice → BLOCKER-RUNA.md. Territory: lab/worldtree-data/*, ~/.config/systemd/user/worldtree-fetch.*, host /var/www/veraldar/{realms.json,realms.provenance.json,feed.xml,realms-history.json,/data/*,llms.txt} — NOTHING ELSE. Do NOT touch world-tree.html or any *.html (RUN B owns the page).

## End your run with
git log --oneline -6; last 5 lines of tests/m5_green.sh; `curl -s https://veraldar.org/realms.json | jq -c '.refresh,.geography.owid'`; one line per year 2015/2018/2021/2026 of the 7 weights.
