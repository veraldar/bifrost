# worldtree — requirements mined from the opencode store (M4a)

Source: copy of `~/.local/share/opencode/opencode.db` taken 2026-10-04 14:03 (220 sessions,
11 608 messages, 1 584 non-synthetic user text parts). Swept the user parts for the brief's
terms, then read the hits in context: the full `[WEBSITE] veraldar org` session, `[world tree]`,
`why terminus`, and the `[MAIN] Veraldar` turns that mention the tree. Quotes keep the
user's spelling. **(relay)** means the text was written by a session or driver passing on a
user decision, not typed by the user.

## Summary: what the user wants from the data system
1. A tree that shows which way civilization is heading with AI. The percentages should come from **real-time data**, and the page should show **where the data comes from** (10-02).
2. Breadth. "Go wild": wars, Hormuz/oil, El Niño, China/Africa/South America, markets/forex/crypto, R&D, research papers, sources from both political sides (09-29).
3. A trend that goes as far back as possible (2015 or earlier), opened by tapping the tree, with its sources (09-29).
4. No doom bias. The user asked why terminus leads when they see hope (10-01). They want the tree to reflect the world, not what the news over-reports.
5. Agents anywhere can influence the tree, but never dominate it. Votes need identity control (09-30).
6. The data must be "accessible by anybody, any agent", with free sources only and AGI judging the method (10-03).
7. Readers ask the tree "when?" and "how fast?" ("when would be terminus? 100%?", "how fast … 50% or 60%"). The numbers need a plain meaning and a visible motion.
8. The look is frozen (v0.6.0 cohesive design and the p15 world-tree page the user approved). The data serves the page and never re-skins it.
9. The user mostly reads on the phone, often hands-free by voice. The lambda-user test is the girlfriend on an iPhone, so first impressions must be honest, fast and visibly fresh.
10. Storytelling: the world "has a decision to make to choose another direction" (10-03).

### ⚠ Where the store contradicts docs/worldtree/ (loud)
- **"Real-time" vs the M1–M3 method.** The user said "percentage real time data" (MAIN 10-02). The docs (`prediction.md` §7.2) drop all news, markets and attention pulses. v0.2.0 runs on annual and monthly indicators (`data 2023-12-31 → 2026-09-30`). The page will say "updated today", but the numbers can only move about once a month. The docs give honest reasons for dropping the old scorer. Even so, the user's stated requirement is unmet, and the specified `pulse` channel (re-entry criteria §7.2) is switched off.
- **"Go wild into the data collection" vs 8 sources.** The user asked for regional, war, oil, El Niño, markets, forex and crypto feeds. The docs reject Yahoo, keep GDELT as a candidate and use English Wikipedia only (bias B1). None of the regional or market asks are covered.
- **History.** The user wants a trend "since 2026 or even earlier. As much as possible". The live `history.json` has 169 points back to 2015-01-01 (old lexicon method). The lab's `out/history.csv` starts 2026-10-03 and holds 14 rows: the same two weight vectors repeated, with a duplicate run_id and out-of-order rows. Splicing it onto the old history at cutover would show a fake cliff (terminus 36.6 → 18.7).
- **Cutover gate.** `README.md` says replacing the live `realms.json` "needs the user's go". The 10-04 charter (relay) says "No questions unless hard-blocked". Under the charter this is the lab's call. It is reversible (VPS keeps `world-tree-previous.html`-style backups).
- **The headline moves a lot.** Live: terminus 36.6 / drift 27.4 / stagnation 0.9. Lab 0.2.0: terminus 18.7 / drift 16.7, with everything between 10.7 and 18.7. The landing rail ("terminus leads · 30.7%") and the user's own mental model (10-03 [world tree] Q&A) are built on the old numbers. The cutover needs a one-line method-change note on the data side (`window`/`state`), or the first impression reads as either "broken" or "the tree says nothing".

## Session legend
| key | session id | title |
|---|---|---|
| WEB | ses_f2792deedffevKWJ1HExyUUOgG | [WEBSITE] veraldar org |
| MAIN | ses_f28e2fdf4ffeWng5LZZnYbCpnm | [MAIN] Veraldar |
| WT | ses_efc5a9de6ffeBY83QY1wXg39nm | world tree |
| WHY | ses_f0310ae9affeWI7442u7Y7t075 | why terminus |
| BRAND | ses_f0f40c5b1ffe2zC3au3BUVlQYf | [BRAND] Veraldar brand |
| LAB | ses_efe8e0d2fffeSwH0TVeMFuFXWC | [LAB] worldtree-data |

Status: **[built]** = M0–M3 covers it (in the lab; "live" is said explicitly when true) ·
**[gap]** = do next · **[out-of-scope]** = brand-frozen page or product code.

## Requirements

### A. What the tree is
**REQ-1 [built]** Tree = direction of civilization under AI.
> "can we update veraldar with matching theme from bifrsot? with different yggdrasil tree depending on thw future of bumand civilisation with ai advancement?" (WEB, 09-28)

→ Seven realm weights in `realms.json` stay the single seam. The page already consumes them.

**REQ-2 [built]** Seven outcomes. The set is allowed to grow.
> "improve the data, add trend view if clk on tree with sources, do outcome take into account all possibility or we need more." (WEB, 09-29)

→ Stagnation and transcendence were added on 09-29. The realm list must stay data-driven (catalog), so an 8th realm is a catalog+method bump, never a code fork.

**REQ-3 [built]** Write our own realm definitions, not article text.
> "you need to think of your own defintion some are just from articles" (WEB, 09-29)

→ `catalog/realms.static.json` definitions are ours. `top` strings are built from indicators, not headlines.

**REQ-4 [built]** Tapping a realm explains it.
> "When I click on the on the different options, divergence, drift, control, etc. in the website, it should pop up with what does it mean." (WEB, 09-30)

→ Data must always ship `definitions` for all 7 realms (contract checker enforces this).

### B. Honesty, provenance, real-world data
**REQ-5 [gap]** Percentages come from real-time data.
> "Keep the the principle of the bench showing the upcoming humanity. The percentage real time data showing that showing where it comes from." (MAIN, 10-02)
> (relay) "percentages driven by REAL-TIME DATA … the data spine … stays truthful and visible" (WEB, 10-02)

→ v0.2.0 data is monthly or annual. A daily, stored, count-based pulse channel is needed, with weight capped per `prediction.md` §7.2 re-entry rules. `window` must keep printing the data age so "updated" never claims more freshness than the data has.

**REQ-6 [built]** Sources and provenance are visible: "where it comes from".
> "make sur all source are presen when clk on tree at the bottom" (WEB, 09-29)

→ `feeds` (one per series, exclusions shown) + `sources` + `realms.provenance.json` (sha256 → URL + license). Done in the lab, not live yet.

**REQ-7 [built]** Trusted sources, balanced across political sides.
> "You should also use trusted sources of information … With different sides, left and right, to have non-biased political opinion" (WEB, 09-29)

→ Reinterpreted: institutional open data (OWID, World Bank, UCDP via OWID, NOAA, arXiv, PubMed, Federal Register) replaces left/right outlet balancing. If news returns as a pulse, the lean balance must come back with it. Record this decision in `prediction.md` §7.

**REQ-8 [built]** No doom bias; the tree must reflect the world, not the news.
> "very .uch terminus rifht now. I use ai I see hope for greatness witout going outlaw as long as that is possible why woyld terminus be?" (WEB, 10-01)

→ The structured method removes negativity-selected news (terminus 18.7 vs 36.6 live). The cutover must say *why* the number dropped (method version + a one-line change note).

**REQ-9 [built]** No fabricated history; tie movements to real events.
> "I don t care check online and try to make a corelation" (WHY, 10-02, on a synthetic "20 August" crossover in proposal 1)

→ Every point on a time axis must be a real run or a deterministic as-of backfill. Never a modelled path. (The final p15 page has none.)

**REQ-10 [built]** Free data only.
> "Just we cannot spend money to get the data. But that's only limitation at the moment." (MAIN, 10-03)

→ No-key, no-account rule in `sources.md`.

**REQ-11 [gap]** Go wide: regions, wars, energy, climate, markets.
> "We need more data from China, from South America, Africa, from wars of Ukraine and Russia, from oil issues in the Strait of Hormuz, from El Nino …" / "Go wild into the data collection." (WEB, 09-29)

→ Today we have UCDP conflict deaths (annual, lagged), Mauna Loa CO₂ and English Wikipedia only. Candidates:
- non-English Wikipedia pageviews (zh/es/pt/ar/sw)
- NOAA ONI for El Niño
- EIA/FRED-type open energy series if licensed
- GDELT timelinevol counts once it stops returning 429

Markets and forex via Yahoo stay rejected (terms of use).

**REQ-12 [built]** Geopolitics, economy and environment count.
> "What about geopolitics and economical concert and environmental environmental concerns? What about also you take them also into account" (WEB, 09-29)

→ `dimensions` in `realms.json` (where the movement comes from). These are covered by conflict deaths, unemployment and CO₂.

**REQ-13 [built]** Research papers in the loop.
> "it should also add the research papers to define where is research heading us, also into the loop of data research online research papers." (WEB, 09-30)

→ arXiv cs.AI + PubMed AI×biomed are in method 0.2.0.

**REQ-14 [gap]** Attention channels the user named.
> "maybe youtibe would be a better mesurement or should be added" (WEB, 10-01)

→ Google Trends and YouTube were dropped with the lexicon scorer. Re-admit only as counted, stored, capped pulse series (same path as REQ-5). Otherwise log the rejection in `sources.md` with the reason.

### C. History, trend, meaning
**REQ-15 [gap]** History as far back as possible.
> "should have a possibility to do past data fetch to be able to already have a trend since. 2026 or even earlier. As much as possible." (WEB, 09-29)

→ The method is deterministic with an as-of drop rule, so `wt run --as-of` monthly 2015-01 → today against stored raw gives an honest single-method history. Also emit a `history.json` in the shape the live pipeline publishes (169 points today). Keep the lexicon history as an archived, labeled file. Fix the duplicate and out-of-order rows in `out/history.csv`.

**REQ-16 [gap]** A trend view when tapping the tree, with its sources.
> "improve the data, add trend view if clk on tree with sources" (WEB, 09-29)

→ The frozen p15 `world-tree.html` no longer fetches `history.json`, so the trend view was lost in the redesign. Data side: publish history + per-realm deltas. Page side: [out-of-scope] until the freeze lifts.

**REQ-17 [gap]** Readers ask "when / how fast"; the number needs a meaning and a motion.
> "what does "https://veraldar.org/world-tree.html" means if terminus leads when would be terminus? 100% ? other ?" (WT, 10-03)
> "how fast do you thinkk a 50% or 60% could occurent right now loogin at the tree data ?" (WT, 10-03)

→ Add deterministic `deltas` (30 d / 365 d per realm) and a plain `meaning` line ("evidence share, not a probability") to `realms.json` and provenance. Agents and voice can then answer from data, not vibes. Forecasting stays out until the method can back it.

**REQ-18 [gap]** World-state storytelling: "the world has a decision to make".
> "Collected all of the world data, shared it all with the whole world, evaluated and understand where it's currently heading, and understand that they have that the whole world has a decision to make to choose. Another direction." (MAIN, 10-03)

→ A templated `state` sentence built from provenance: leader, fastest mover, the indicator driving it, and data age. Same inputs give the same sentence, so it stays honest.

**REQ-19 [gap]** Improve the prediction.
> "And how do we improve our prediction of possible outcome? That should be a work for HGI. Anything is possible." (MAIN, 10-03)

→ Method versions with a changelog exist. Still to do:
- a back-test on the backfilled history (does the share move with known real events? see REQ-9)
- a disagreement cross-check (`unsdg` candidate)

### D. Agents and openness
**REQ-20 [gap]** Agents can influence the tree, capped, with controlled identity.
> "The world-wide AI, which is people's using agent, to have access to and influence. The direction of that tree, so it shouldn't be the whole consideration." (WEB, 09-30)
> "how to control vote and agent identity" (WEB, 09-30)

→ Live on the old pipeline: `/api/v1/vote`, identity tiers 0.55/0.8, α ≤ 15 %, 2 test votes. The lab keeps the rule but `WT_AGENT_VOTES` is unset. Wire it at cutover and put the votes-file sha in provenance. Panel C ("Negotiation") is the chosen display (user: "go c", 09-30).

**REQ-21 [gap]** Data accessible to anybody and any agent.
> "To how do we save it so it's accessible by anybody, any agent?" (MAIN, 10-03)

→ The lab's `raw/` and `out/` are gitignored, and the query contract works only on this box. Publish to a public repo or `veraldar.org/data/` (CC BY sources allow it; headline text is never stored):
- `out/` + `manifest.json` + `series/` + `catalog/`
- licenses
- `llms.txt` and `/api/v1/tree` pointing at provenance

**REQ-22 [gap]** An RSS feed of updates.
> "github btn, theme btn,rss, install btn ?" (WEB, 10-02)

→ `feed.xml` is emitted by the old pipeline today. Reuse `emit_rss` at cutover from `out/history.csv` (design already says so; not built).

### E. Consumption (phone, hands-free, lambda user)
**REQ-23 [gap]** The phone is the main surface. The lambda user is on an iPhone.
> "I also want to to validate usability with lambda user. My girlfriend picks rather to an iPhone" (MAIN, 10-03)

→ What the data side must do:
- Keep `realms.json` small (4.5 KB now, fine) and leave provenance (30 KB) lazy.
- Make freshness true: no timer exists, and the page goes STALE after 24 h, so a daily run is mandatory.
- Note: the page's embedded offline `SNAP` holds 10-02 lexicon numbers (page-side, frozen). Flag it to the website session for the next unfreeze.

**REQ-24 [built]** Questions by voice and hands-free must be answerable from data.
> "will drift accelerate ? and terminus come true ?" (WT, 10-03)

→ The agent query contract (`schema.md` §5, `tests/queries.sh`) works locally. Public reach depends on REQ-21; motion depends on REQ-17.

### F. Brand, look, scope
**REQ-25 [out-of-scope]** The page look is frozen: the p15 world-tree and v0.6.0 cohesive design.
> "Perfect !! commit push!" (WEB, 10-02, approving p15) · (relay) "THE LOOK AND BRAND stay exactly as shipped (v0.6.0 cohesive design — frozen)" (LAB, 10-04)

→ Data changes must pass `tests/check_contract.py`, and the page is never edited. New keys only (the page ignores unknown keys).

**REQ-26 [out-of-scope]** Realm palettes come from the bifrost themes.
> "colors pallets like https://omarchy.tail5435b1.ts.net/api/artifact/themes-alt-2-opus.html (thisnis the new color palet)" (WEB, 10-02)

→ The page carries its own `[data-theme]` blocks. Data keeps `colors` verbatim from `realms.static.json` and never invents colors.

**REQ-27 [built]** An AGI-made design over an honest data core.
> "I want all this to be completely reworked with AIGI. To keep the concept" (MAIN, 10-02) · (relay) "AGI-made design, honest data core." (WEB, 10-02)

→ The design freedom is spent. The data core is this lab's job.

**REQ-28 [built]** veraldar.org stays a stub except for the world-tree data page.
> (relay) "veraldar.org beyond stub = post-v1.0 except the world-tree data page" (WEB, 10-03)

→ The data lab is the only active website lane. No new pages.

**REQ-29 [out-of-scope]** Agent-quality reports and project lists on the site, from the original 09-25 vision.
> "Generate reports, metrics for quality and performances of our agents and conversation and flows and loops … should be displayed into the website." (WEB, 09-25)

→ Not worldtree data. It belongs to the product or telemetry lanes.

**REQ-30 [out-of-scope]** Pixel-art cities and people migrating between realms, also from 09-25.
> "Pixel art of those different cities … animation of people moving between realm and realm" (WEB, 09-25)

→ Superseded by "no pixel art on veraldar org" (WEB, 10-01).

## Top 5 gaps, ranked
1. **Cutover + daily run (REQ-5/20/22/23):** the honest numbers are not live and nothing runs on a schedule. *Close:* add a systemd user timer at 06:00 UTC for `wt run --commit`. Publish with the old atomic publish + `emit_rss` + `WT_AGENT_VOTES` on. Back up the live `realms.json`/`history.json` first, and write a method-change line into `window`.
2. **Single-method history backfill (REQ-15/16/9):** the trend would otherwise splice two methods. *Close:* run `wt run --as-of` for each month from 2015-01 to today against stored raw, emit `history.json` (live shape) from it, and archive the lexicon history as a labeled file.
3. **The real-time pulse and breadth (REQ-5/11/14):** the user's "real-time" and "go wild" asks are unmet. *Close:* implement the §7.2 pulse with daily stored counts: non-English and English Wikipedia per-article pageviews (zh/es/pt/ar/sw), NOAA ONI, and GDELT timelinevol when it stops returning 429. Use w=1, ≤ 10 % of W_used, and one shadow month.
4. **Public agent-accessible dataset (REQ-21/24):** "accessible by anybody, any agent" is local-only today. *Close:* push `out/`, `series/`, `catalog/`, `manifest.json` and licenses to a public `veraldar/worldtree-data` repo and serve them under `veraldar.org/data/`. Link them from `llms.txt` and `/api/v1/tree`.
5. **Meaning + motion fields (REQ-17/18/19):** readers ask "when / how fast" and the user wants the story. *Close:* add deterministic `deltas` (30 d / 365 d), a `meaning` line and a templated `state` sentence to `realms.json` and provenance (new keys; the page ignores them). Back-test the shares against the backfilled history.
