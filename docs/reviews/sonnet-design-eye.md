# Design-eye review: Veraldar / Bifrost (visual + tone)

## A. Token cohesion (site `tokens.css` vs PWA `tokens.css`)
The site `tokens.css` and `theme.json` are the **old v1 aether**. The PWA ships the v2 "dialects" canon. The ten role names match. Values and finishes do not.

Aether, every role differs:

| role | site | PWA |
|---|---|---|
| bg | #080810 | #07080e |
| surface | #000000 | #0d0f18 |
| surface-hover | #111111 | #161a26 |
| border | rgba(255,255,255,.14) | rgba(196,204,255,.13) |
| text | #ffffff | #e9ebf5 |
| dim | #888888 | #8b90a8 |
| success | #4ade80 | #72d19a |
| active | #fbbf24 | #e6b35a |
| danger | #f87171 | #ec7c7c |
| info | #38bdf8 | #7ab4e6 |

- **Other themes.** `index.html` carries inline terminus and drift blocks labelled "exact copies of bifrost tokens.css". They are copies of the pre-v2 values, not the current ones.
  - terminus bg #100c14 vs #1c1013; text #cfc8bd vs #efdccb.
  - drift bg #ece8f8 vs #e6e0f6; surface #fff vs #f4f1fc.
  - Every role differs in both themes.
- **`theme-color` and `BG` map.** They use #080810, #100c14 and #ece8f8, so the browser chrome mismatches the PWA.
- **Finishes.**
  - The site has `--rule` and `--tick` with no `oz-` prefix. The PWA uses `--oz-rule` and `--oz-tick`.
  - The site only defines terminus tick=1 and drift dotted. It has no dashed (divergence), double (transcendence) or control tick.
  - `realms.md` says control `--oz-tick: 2`. The PWA ships 1 and the site world-tree ships 1. Canon, PWA and site disagree.
- **`world-tree.html`.**
  - It has a third naming scheme: `--bg`, `--ok`, `--act` and `--hover`, aliased to the role names at ~line 62.
  - Its eight palettes **match the PWA values exactly**. It is the only site asset on v2.
  - Its `--rl` / `--tick` are not `--oz-*`.
- **`theme.json`.** It is the v1 aether source. It has no other themes, so the pipeline cannot regenerate canon.
- **Font.** Commit Mono with a ui-monospace fallback everywhere. Aligned.

## B. Theme canon (site `index.html`)
- **Theme switcher.** It still lists aether, terminus and drift. The site needs:
  1. Replace `tokens.css` with the PWA's generated file. Delete the inline terminus/drift blocks in `index.html`. Fix `theme.json` upstream first.
  2. Add the 5 realm blocks. Divergence goes first, then transcendence, control, utopia, stagnation.
  3. Switcher: add divergence first, with `dashed` for `--rule`. Whitelist all 8 in the pre-paint script (`t==='terminus'||…`) and in the `BG` map for theme-color.
  4. Rename `--rule`/`--tick` to `--oz-rule`/`--oz-tick`. Add `double` and control tick (settle the 1 vs 2 conflict).
  5. Add `color-scheme` per world: light for drift and utopia, dark for the rest.
  6. Eight buttons will not fit the header `.themes` strip on a phone. It needs a different control, such as a menu or the swatch row from `world-tree`.
- **Hardcoded hexes in `world-tree`.** `realms.json` realm colours (#4ade80, #38bdf8 and the rest) are the 400-series from v1. They are correct as realm hues, as `realms.md` says. They are not role colours.
- **`realms.json`.** The site copy is an old "seed v1", seven realms. The page's snapshot is newer. Keep only one source.

## C. Voice cohesion (violations)
- **Stale version string.** `index.html`: `v0.5.0 enthusiast`. The book's own example is v0.4.0 enthusiast. Reconcile it with the real version.
- **Competitor slogan.** `They sell you the model. / Bifrost gives you the remote.` It is a slogan aimed at labs. The brief says it is internal-only. Remove it.
- **Yggdrasil in user-facing text.**
  - The "three names" list.
  - The `tree veraldar` ASCII diagram.
  - `yggdrasil-bifrost` clone URL.
  - Repo slugs in links are acceptable until the rename, but the diagram and list are not.
  - The tree's `aria-label` ("Yggdrasil drawn as circuit traces").
  - Colophon: "the real yggdrasil circuit".
  - The Midgard/Asgard line ("Midgard to Asgard in the myth") is lore-only. Brand law allows lore on lore pages only.
- **Marketing and soft copy.**
  - `The old names. The new code.` is slogan cadence.
  - `Source on the table.` is rhetorical.
  - `a self-hosted, voice-first remote` stacks two descriptors. Rule: at most one.
  - `SUPPORT VERALDAR` and "stays free" is a donation pitch that implies a service promise. Pending funding links are not a T+0 stub item.
  - `Your hardware, your words.` is fine.
- **"We".** No literal "we" found on index or world-tree. "Our" appears in prose only inside definition strings. Re-check the colophon and narration.
- **Emoji and exclamation marks.** None found in `index.html` or the visible strings. Unicode glyphs (○ ◉ ▸ ●) are UI state icons, which is acceptable.
- **`world-tree.html`.**
  - Title and h1 "Seven futures. One tree. Which one is winning?" is a campaign headline, not terminal voice.
  - "Seven futures" and "eight themes" give two counts.
  - The theme panel copy ("the warm CRT") and film references (Terminator 2, WALL·E, Her, Interstellar). These pull in other brands' IP and look off-brand.
  - Realm text "the world's current direction, worn honestly." is poetic.
  - "UTC" and LIVE/STALE badges are good, terminal-native.
- **Plan conflict.** Plan says veraldar.org = stub. `index.html` is a full product page with a mic demo, a donation section and a phone miniature.

## D. World-tree mockups
- **p8, p9, p10: violate.** Titled "Yggdrasil". Background #02030A is off-token. p10 adds a sans-serif face and a rhetorical h1 ("Every future is growing from the same tree."). None define the 8 themes. These are pre-brand explorations.
- **p11: partial.** "Seven futures…" h1 and Commit Mono, role tokens, tick/rule finishes present. Only 4 data-theme/skin references, not the full 8 realm themes.
- **p12: violate.** "Which way is civilization growing with AI?" is a marketing-style question. Hand-picked bg #080810 is v1.
- **p13: partial.** On-tone, mono, one-tree concept. Uses v1 aether and no theme set, so it lags canon.
- **final-outcomes: best match.** Commit Mono, the eight canon palettes (20 data-theme hits), same bg values as the PWA. It is what `world-tree.html` is built from. Still carries the campaign h1 and film references.

## E. Verdict
No, it is not one system today. `world-tree.html` and the PWA are one system: identical eight palettes, same Commit Mono. `index.html` is a different system. It runs the old v1 aether (pure #000 surface, #fff text, 400-series accents) with outdated copies of terminus and drift. Its finish variables use another naming scheme, and the world-tree page uses a third. On the same domain a visitor sees a hard black aether on the landing page and the soft v2 aether one click away.

Top three fixes:
1. **Regenerate the site tokens from the PWA.** Replace `tokens.css` and `theme.json`. Delete the inline terminus/drift blocks. Rename to `--oz-*` everywhere, and update `theme-color` and the `BG` map.
2. **Ship divergence first, then the other four.** Fix the control tick value in one place. Change the switcher so eight worlds fit on a phone.
3. **Strip the copy to the stub.** Remove Yggdrasil, Midgard/Asgard, the competitor quote and the stale version line. Drop the support block until the accounts exist. Then take the film references and the "Seven futures" h1 out of the world-tree header.
