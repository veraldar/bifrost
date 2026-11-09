# THEME-PORT — the 'dialects' retune on lab/sandbox (10-27)

**Verdict: landed and served.** `lab/sandbox` now wears main's 'dialects' palette, all eight worlds. drift-guard
`theme-dialects` reads OK on both lines. Fleet rule 10-27 law 1: a port, not a rewrite. No values were changed.

| | |
|---|---|
| sandbox commit | `be67d66` (lab/sandbox), 7 files |
| drift-guard commit | `63ec1a4` (rebuild/cohesive-opus) |
| served on :8090 → :8443 | build `3kP26ndtTMSfiHolMFd3o` (app `0.5.0-80-g9f43c8e`, contains `be67d66`), unit up since 13:44:25 CET |

## What was ported (main → sandbox)

| file | source on main | how |
|---|---|---|
| `pwa/styles/tokens.css` | `c303729` retune + `0b2710d`/`d7977f8` selector fixes | **byte-identical** to main (`cmp`) |
| `pwa/public/manifest.json` | `8114a44` (aether ground `#07080e`) | byte-identical |
| `pwa/e2e/theme.spec.ts` | `5b21b97` (BG map → dialect grounds) | byte-identical |
| `pwa/styles/brand.css` | `602a813`, world-finish hunk only | `divergence` dashed, `transcendence` double, `control` ticks |
| `pwa/styles/globals.css` | `602a813` | utopia joins drift as a light world (`color-scheme: light`) |
| `pwa/app/layout.tsx`, `pwa/app/settings/page.tsx` | `602a813` | themes list + WORLDS go from 3 to 8 |

The world wiring from `602a813` is included because the retune ships eight token blocks. Without the wiring, five
of those blocks would be dead CSS that no one could select.

**Left out on purpose.** Two hunks rode in on `602a813` but aren't theme values: the `.oz-badge` restyle, and the
inline-code chip (`#ececec`/`#111111 !important`). On the sandbox the badge is still a positioned counter on the
artifact bell (`page.tsx:484`), so main's restyle would change the layout. That is a separate drift for its own lane.

**"The underline color is missing."** My best reading: every hairline and underline (row rules, the band's top and
bottom edges) is drawn with `--oz-border`. Before the port, the sandbox drew them in neutral white
(`rgba(255,255,255,.14)`). The dialects version tints them per world: aether `rgba(196,204,255,.13)`, terminus warm
`rgba(239,200,170,.16)`, and so on. That tint now ships. If the user meant some other line, a phone screenshot will
settle it.

## Evidence

- **Served CSS, 8/8 grounds:** every `[data-theme]` block carries its dialect `--oz-bg`: aether `#07080e` ·
  terminus `#1c1013` · drift `#e6e0f6` · divergence `#071a33` · transcendence `#170c2a` · control `#1a1709` ·
  utopia `#e9efd8` · stagnation `#1d2126`. The old `#080810` is gone. `dashed`/`double` finishes and utopia's light
  scheme are present. The manifest serves `#07080e`. This is the same check `d7977f8` used, because lightningcss
  silently drops invalid selectors.
- **theme.spec 1/1** on :8090. The new BG map would fail on the pre-port build.
- **The 5 realm worlds, one-off check on :8090: 5/5.** Each button previews its own ground, a tap re-grounds the page,
  and utopia's computed `color-scheme` is `light`.
- **drift-guard:** `theme-dialects` is OK on bifrost and on bifrost-sandbox, exit 0. The probe is now a value
  (`oz-bg: #07080e`), not the retune's header comment. It matches 0 times on `be67d66^` and once on `be67d66`.

## General suite (default config, `PW_BASE_URL=http://127.0.0.1:8090`, build `3kP26…`, unit stable for the whole run)

**72 passed · 11 failed · 3 skipped. 0 of the failures come from this port.**

| failures | cause | proof |
|---|---|---|
| `hf-quick-tap:84` ×2, `voice-ui:17` | the specs expect idle copy and a glyph that the user's [MAIN] session removed today (`d02e965`/`4343a0f` the "tap it for hands-free" hint, `9f43c8e` the idle `○`) | assertion text: received `""` |
| `mainframe-c-*` ×6 | these specs run under the default config, but they need their own (`permissions: ['microphone']`, 412×915, text mode) | `-c playwright.mainframe-c.config.ts`: **22/22**, including shots in all three worlds |
| `base:74` | known shared-load flake | **passes alone** |
| `ux-batch-voicetest:24` | spec race: `.last()` "two plus two" matches an **old** bubble in the accumulated voice-test session, so the count is read before the new turn lands | fails under its own config too, in 5 s. The voice path works: mainframe-c-voice ran 3/3 real turns and voice-test went from 20 to 24 user turns |

## Build path and a collision

- My lane ran in the `agi-lane` cgroup with JIT available. I used the mission's jitless recipe anyway.
- **Both of my in-tree builds went red.** They raced the user's [MAIN] session (a brain-spawned bash under
  `lk-yggdrasil`), which was building the same `pwa/` (`/tmp/b7.log` 13:39, `/tmp/b8.log` 13:40). Two builds
  in one `.next` gave `ENOENT rename .next/export/500.html`, then a missing `.next/types/…/route.ts`.
- MAIN's `b8` came out green **from `9f43c8e`, which sits on top of `be67d66`**. MAIN restarted the unit at 13:44:25.
  That build is the one served now, and it carries the port. I did not start a fourth build or restart: the port was
  already served, and a rebuild would have raced MAIN again. I posted a claim line in the sandbox's `docs/claims.md`.
- At the time of writing, MAIN's `4028224` is committed but not built. One build and restart, by MAIN or the user,
  ships it.

## For other owners (not fixed here)

1. `playwright.config.ts` doesn't ignore `mainframe-c-*`, so the general suite runs them under the wrong config
   (6 false reds).
2. `hf-quick-tap` and `voice-ui` need their idle expectations brought in line with MAIN's 10-27 "nothing renders while
   idle" commits.
3. `ux-batch-voicetest` should poll the user-turn count, not the visibility of the last matching bubble.
4. `where.sh version` reports a false MISMATCH whenever a BUILD_ID contains `-`, because the served HTML comment has `_`
   in that spot. This lane saw `FGfkgKXZj3fe_Mis0ML6Q` served next to `FGfkgKXZj3fe-Mis0ML6Q` on disk, and live
   shows the same pattern.
5. Nothing locks `.next`: two sessions can build one tree at once. A `flock` in the build recipe would turn the race
   into a wait.
