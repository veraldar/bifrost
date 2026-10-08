# M8 honesty review: is the picture truthful?

2026-10-08 · method 0.5.0 → 0.6.0 · brief `lab/worldtree-data/briefs/M8-review.md` ·
referee `lab/worldtree-data/tests/m8_honesty.sh` (+ `tests/shot_honesty.cjs`, 16 checks on the rendered page).

The user asked for "a truthful and honest picture of data and trends". Before changing anything, I read
veraldar.org/world-tree.html the way a visitor does: a headless browser at the default lens, every tab. Then I
traced each figure on screen back through `realms.json`, the provenance and the series to the raw files. The
biggest problems were not in the arithmetic. They were in what the page said the arithmetic was. Two real
number defects were in the country atlas, and one was in how GitHub counts were scored.

## Verdict

Before the review, the page was misleading. It looked like a live instrument of AI's direction. In fact it:
- hid 89 % of its own indicators by default;
- described its numbers with leftover news-pipeline words ("headlines", "items", "the AI gate");
- said a switch changed the numbers when it didn't;
- never said what a percentage is;
- let war deaths stand as "the leash breaks badly" with nothing marking them as non-AI.

After the review every number on the page still traces to its source. The page now also says what each number
is, what it is not, and how much of the headline comes from measuring AI as opposed to measuring the world.

## Changed (ranked by how much a visitor was misled)

1. **The pertinence lens misdescribed itself.**
   - When the news pipeline was retired, `realms.json` stopped carrying `modes`. STRICT AI, BALANCED and
     EVERYTHING then showed identical numbers, but the hero still said "the switch at the top changes the
     numbers".
   - The page sorted feeds with regexes written for news-feed names. At the default lens they filed 25 of 28
     indicators (poverty, life expectancy, Epoch, GitHub…) as "collection: the general news plumbing" and hid
     them. The one excluded indicator was hidden too.
   - Readouts were called "headlines" ("its 2 loudest headlines name no AI"), and series were called "items".
   - The essay described a keyword gate over news that no longer exists.
   - *Fix (method 0.6.0, page):*
     - `catalog/series.csv` gains `measures`: `ai` means the quantity would not exist without machine
       intelligence; `world` is a condition of the world AI lands in; `norm` marks denominators.
     - `realms.json` gains `modes.strict`: the same method over the AI indicators only. `modes.wide` equals
       `weights`.
     - Feeds carry `tier`.
     - The page takes its tiers from the data and lists 28 of 28 indicators by default, the excluded one
       included. It says "series", and it tags each loudest signal "measures ai" or "measures the world".
     - The essay was re-read and rewritten for measured data. The news-era copy is kept only for a rollback to
       the old file.
   - The lens is no longer decoration. Today the headline gives terminus 17.6 and control 16.4. With the
     AI-specific indicators only, control gets 17.9 and terminus 14.1 (neutral).
2. **Terminus leads on war, and the page framed it as AI's leash breaking.**
   - Terminus's lift over neutral comes almost entirely from deaths in armed conflicts: UCDP, 2025 near a
     30-year high, score 0.97, contribution +0.156 of +0.142. The remaining lift comes from unemployment
     (+0.022), offset by CO₂ (−0.036).
   - None of these measures AI. The one AI indicator, x-risk attention, is excluded for short history.
   - The mapping rationale called war "the weapons arm of the leash breaking".
   - *Fix:*
     - The rationale now says the indicator measures war, not AI (bias **B18**).
     - The hero says: "On the indicators that measure AI itself (STRICT AI) control leads at 17.9% and
       terminus reads 14.1%: the rest of its lead comes from measures of the world AI lands in."
     - The STRICT dial lede names every left-out world indicator.
3. **What a percentage means was only in the docs.** `docs/worldtree/README.md` said "evidence share, not
   probabilities" and "the page's wording should be read that way". The page never said it. *Fix:*
   - The hero now says: "Each number is a share of the evidence, not a probability: 14.3% each would mean
     nothing unusual anywhere."
   - "Even 14.3" is drawn on the rings and named on the dials. The negotiation panel names the even split.
   - The essay explains "unusual for itself, not good or bad".
   - DATA.md gains "What the percentages mean (and what they don't)".
4. **Atlas: stagnation had its sign backwards (a numbers defect).** R&D % of GDP, researchers per million
   and resident patents had direction +1 on stagnation, yet their rationales call them evidence *against* the
   stall ("investment against the stall"). The atlas named South Korea (98.8), Sweden, Japan, Germany and the
   US the most stagnant countries, and Myanmar the least. *Fix:* direction −1. The gate now checks that the
   10 least stagnant countries average 3.76 % R&D and the 10 most stagnant average 0.12 %.
5. **Atlas: absolute totals ranked countries by size (a numbers defect).** Transcendence per country rested
   on high-tech exports in US$ and ranked China, Germany and the US first. Patents, solar and nuclear TWh,
   terrorism deaths and disaster deaths were also totals. *Fix:* the eight total rows are ranked per person
   (`percap=wb.SP_POP_TOTL`, World Bank population, CC BY 4.0, same country-year). Transcendence now leads with
   Ireland, Switzerland and the Netherlands.
6. **Atlas terminus had no war in it** while the world tree's terminus is mostly war. *Fix (indicator added):*
   OWID's UCDP deaths in armed conflicts, by the country where they occurred, per person, terminus w2. This is
   the same source and column as the world series. Ukraine reads 78.8, Sudan 78.9.
7. **GitHub repo counts scored GitHub's own growth (a numbers defect by the method's own rule).** The method
   scores Wikipedia attention per million en.wiki views (B1) because a count on a growing platform includes
   the platform's growth. The tool and Lean repo counts had no such correction. GitHub's growth in new public
   repos accelerated:

   | period | growth |
   |---|---|
   | 2023→24 | ×1.14 |
   | 2024→25 | ×1.40 |
   | 2025-09 → 2026-09 | ×2.25 (5.35 M → 12.03 M) |

   *Fix:* new series `github.all_repos_month` (keyless search total, 93 months backfilled), with
   `norm=github.all_repos_month` on the three rows. The AI-tool share grew ×5.9, where the raw count grew
   ×13.4, so the score goes 0.97 → 0.75. Lean stays 1.00. This is the only change that moves the world tree:

   | realm | utopia | divergence | drift | control | terminus | stagnation | transcendence |
   |---|---|---|---|---|---|---|---|
   | move | +0.2 | −0.8 | +0.3 | +0.4 | +0.4 | +0.2 | −0.7 |

   The 0.6.0 fixture with the norm params removed reproduces 0.5.0 exactly. The AI EVOLUTION tab now shows
   GitHub's own ×, the AI-tool share's ×, and says the tree scores the share.
8. **The ×8.0 releases story** (2019 → 2025, 45 → 362):
   - The repo set was picked in 2026 (B15). Only 3 repos released in both years, and they went 45 → 73
     (**×1.6**). 289 of 2025's 362 releases come from repos with no 2019 release.
   - 265 of the 362 (73 %) were cut by bots (SDK generators, CI).
   - The page's "per releasing repo … net of repo births" cell claimed something false: a per-repo mean still
     depends on which repos are in the set.
   - *Fix:*
     - That cell is replaced by the like-for-like ratio.
     - A bot-share cell is added, along with `bot_releases` per year in the data.
     - A sentence tells the reader how to read the ×.
     - The ×8.0 stays: it is a true count, now shown beside what it is made of.
9. **Rings drew the method's neutral default as data.**
   - In 2015–17, four realms had *no* indicator (coverage 0). Their flat ~14–15 % lines were the default, not
     a measurement. They were drawn dashed, the same as "thin".
   - The years 2015–17 fail the method's own run gates, which would hold that run, and nothing marked this.
   - Lines can be read as directions. But each year sums to 100, and indicators join over time (7 in 2015, 30
     now).
   - *Fix:* no line where coverage is 0, and the readout says "no data". Held years read "the method's own gates
     would not publish this year". The lede states the indicator count and the data vintage. The note says
     "one line rising can mean others falling".
10. **The offline and syncing snapshot was the retired news pipeline.** It held terminus 24.3 and "3563 items".
    A failed fetch would have shown those discredited numbers under this page's name. *Fix:* the embedded
    snapshot is today's measured `realms.json`.
11. **The atlas claimed "refreshed nightly" but wasn't.** The nightly never ran `wt countries`, so the live
    `countries.json` was 10-07 / 0.4.1. *Fix:* `scripts/nightly.sh` recomputes it before publishing.
12. **Small gaps made visible.**
    - The atlas small-state list was cut at 10 without saying so; it is now the full list with its count.
    - The caption says "hollow = no data", gives each realm's indicator count, and says "drift has no
      country-level indicator".
    - The caption says no country indicator measures AI and that scores are levels, not directions.
    - "world only" was relabelled "before agent votes": it is the pre-blend set, not world-condition
      indicators.

## Disclosed only

- **Life expectancy rebound (B17).** The utopia readout "Life expectancy: 73.17 years (2023) · score 0.93"
  ranks a +0.53-year gain as beyond trend. But 2023 is still catching up after the 2020–21 COVID fall (72.61 →
  70.87 → 73.17), below its pre-2020 trend line (≈ 73.6). Fixing it would mean changing the lag-1 rule for every
  annual delta (GDP, poverty, unemployment), which is a method redesign this review is not entitled to. The
  rebound is disclosed in the mapping rationale, in the provenance `bias[]` and in DATA.md.
- **Absent dimensions.** The tree covers what is free to count. Culture, institutional quality (WGI isn't
  served by API v2), robotics, energy breakthroughs, AI incidents and harms, AI's own effect on jobs
  (unemployment counts all causes), compute supply and education outcomes are not measured. This is said in
  DATA.md and in the essay's "What I can't see". It is disclosed rather than patched: an indicator added for
  coverage's sake would be a thumb on a realm.
- **Data vintage.** The rings use today's revisions (no publication-lag model). This is now said in the rings
  lede as well as in DATA.md.
- **Thin country realms.** Transcendence per country rests on one indicator and drift on none. The caption
  says so.
- **Versioning erratum.** 0.3.1 and 0.4.1 are labelled "Patch" but moved numbers, so by the method's own §6
  they were minor releases. The 0.6.0 CHANGELOG records the erratum; history is not rewritten.
- **Other composition-driven cells** on AI EVOLUTION ("×10.4 mean releases", median days between releases, the
  tools-vs-commits comparison of unlike units) stay. They sit next to the like-for-like and bot cells and the
  how-to-read sentence that explain them.

## Considered and rejected

- **Dropping or down-weighting conflict deaths in terminus.** The realms are futures of civilisation *with* AI.
  The design deliberately includes the world those futures land in, so re-weighting would put my taste in
  place of the method. Making the composition visible (STRICT AI, B18, the hero line) tells the truth without
  choosing for the reader.
- **Changing "Which one is winning?"** The brand is frozen. The sentence directly under it now says the
  numbers are evidence shares, not probabilities.
- **Curating a repo set as if chosen in 2019.** Keyless star history can't be reconstructed, and any set I
  picked would be a new selection bias. The like-for-like ratio answers the question honestly.
- **Removing bot-cut releases from the count.** They are real releases. Deleting them would be a judgment;
  counting and disclosing them is not.
- **Normalising arXiv and PubMed by their platform totals.** Steady platform growth cancels out in a rank
  against the series' own history. GitHub's growth *changed pace* (×1.14 → ×2.25), which is what made the raw
  count misleading. The criterion is written down in B16.
- **Adding an AI-specific terminus indicator now** (AI incidents). No keyless, openly licensed count endpoint
  was verified in this review. `wiki.ai_xrisk` passes its history floor in about 2 months (22 of 24 points)
  and will then feed terminus under both lenses on its own.
- **Per-year STRICT lines on the rings.** That would be a second chart grammar on a frozen design. The rings
  show the headline, and the gap to STRICT is on the hero and the dials.
- **`aitrend.html`** is linked from the page header but sits outside this review's territory. It was not
  reviewed and is flagged here.

## What a visitor reads now (live, `tests/shot_honesty.cjs`)

- **Hero:** "Right now the evidence leans toward terminus · 17.6%, with control · 16.4% close behind. Each
  number is a share of the evidence, not a probability: 14.3% each would mean nothing unusual anywhere."
- **Roots:** "Feeds · 28 of 28". The excluded AI x-risk attention reads "excluded: short_history (22/24)".
  Sources show "27 series used".
- **STRICT AI:** the dials move (terminus 17.6 → 14.1, control 16.4 → 17.9), and the lede names the eight
  world indicators left out.
- **Rings:** "even 14.3"; 2015 reads "no data" for four realms and "the method's own gates would not publish
  this year".
- **AI EVOLUTION:** "×1.6 the same repos, 2019 → 2025", "265 of 362 releases cut by bots, 2025", and "×1.7 ·
  ×5.9 GitHub itself, same 12 months · the AI-tool share of new repos".
- **SOURCES MAP:** "None of these country indicators measures AI … as levels, not directions … Totals are
  counted per person."
