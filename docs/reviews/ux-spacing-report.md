# UX-SPACING — header and footer coherence (10-27)

**Verdict: fixed and served.** The bug the user felt was real, but narrower than the brief assumed. Idle ↔ working
never jumped on `4028224`: both states draw nothing inside the same 28 px box. The jump was **heard** and
**hands-free**. At 360 px (the S22) their words wrap to two lines, and the composer jumps **17.2 px** up. Besides
that, the footer was out of balance. It reserved a blank 28 px band under the composer, so idle showed **40 px** of
empty space under the keys, against the header's **12 px** above its key.

| | |
|---|---|
| commits (lab/sandbox) | `f90fe13` the audit spec (RED on `4028224`) · `b645f8b` the chrome scale |
| served on :8090 → :8443 | build `q86_FOt7lpPWB10I6fwez` (built from `f90fe13` + the fix = `b645f8b`), `where.sh`: served = built |
| measured on | the sim stack (:8096 → sim yggdrasil → mock LLM), S22 viewport 360×780 @3, touch; plus 412/430/1280 |
| evidence | `~/Work/bifrost/artifacts/ux-spacing-{before,after}-<page>-<state>.png` + `ux-spacing-{before,after}.jsonl` (every box) |
| at a glance | `/api/artifact/ux-spacing-footer-before-after.png` · `/api/artifact/ux-spacing-main-before-after.png` |

## Audit — every box in px (S22 360×780 unless noted; top + height)

| # | what | before (`4028224`) | after (`b645f8b`) | status |
|---|---|---|---|---|
| 1 | phase line height per state | idle 28 · working 28 · synthesizing 28 · speaking 28 · drop 28 · **heard 45.2 · hands-free 45.2** | **28 in all seven** | fixed |
| 2 | composer (dock) top per state | 687, but **669.8** in heard and hands-free (a 17.2 px jump) | **699 in all seven** | fixed |
| 3 | transcript bottom, idle → working → idle | 687 → 687 → 687 | 699 → 699 → 699 | was already still; still still |
| 4 | session footer total | 93 = rule 1 + gap 12 + key 40 + gap 12 + line 28 | **81** = rule 1 + gap 12 + key 40 + line 28 | fixed (balance) |
| 5 | blank under the keys while idle (vs the header's 12 above its key) | 40 | 28 | fixed (balance) |
| 6 | header height: home, session, MAIN, settings, artifacts, session settings; 360/412/430/1280 | 52 everywhere | 52 everywhere (now `gap·line·gap`) | was already one height |
| 7 | MAIN vs a session: header / dock / phase | identical (52 / 687+65 / 752+28) | identical (52 / 699+53 / 752+28) | same |
| 8 | onboarding MAIN (first-turn card) vs a done device | dock and phase identical; the card takes 208 px of transcript | same | content, not chrome |
| 9 | safe areas | `env()` on the roots, the home padding, the toast and the door; **none** on any header or the session footer | headers (top) + phase line (bottom) carry it too | fixed in code; inert today (see N1) |
| 10 | longest phase words vs the 336 px column | heard 340, hands-free 347 at 11 px (overflow → wrap) | 325 / 331 at 10.5 px | fixed (see N2) |
| 11 | home footer (roots) vs session footer | 84 vs 93 | 84 vs 81 | named (N3) |
| 12 | desktop 1280 | 448 column, 52 / 93 | 448 column, 52 / 81 | no regression |

The speaking deck and the synthesizing deck shrink the transcript by their own height (−104.6 / −129.2 px). They are
content between the transcript and the dock. The dock and the line under them don't move (#2).

## The decision — one chrome scale

`brand.css` `:root`: `--oz-gap: 12px`, `--oz-line: 28px`, `--oz-key: 40px`, `--oz-roots-h: 84px`.

- **header** = gap · line · gap = **52** on every page (+ the top safe area).
- **session footer** = rule · gap · key · line = **81** in every voice state (+ the bottom safe area). The line is a
  fixed row: words appear and disappear inside it, and it never grows (`height`, not `min-height`; `nowrap`; an
  ellipsis guards future copy). The dock's old bottom gap folded into the line, so the line *is* the bottom margin.
- The keys (`.oz-k`, `.oz-k.sm`), the textarea and the pill now read `--oz-key` / `--oz-line`, at the same values.
  The roots' 84 is one token, read by the home page's scroll padding (84 + 16) and the undo toast (84 + 8).
- The recent decisions stay as they were: idle draws nothing, and working draws no words. Only the box around them
  is fixed.

Diff: `pwa/styles/brand.css` (+24/−10), `pwa/app/page.tsx` (2 inline values → the token). No TSX logic or copy
changed.

## Proof

- **The spec** `pwa/e2e/chrome-spacing.spec.ts` (7 tests). It covers the header on six pages; the jump
  (idle → working → idle); seven voice states driven for real (a PTT hold on the sim's LiveKit, the delete slide,
  a hands-free tap, the deck through a stubbed `/api/tts/stream`); MAIN vs session vs onboarding; and widths
  412/430/1280. **Before: 6/7, RED on heard + hands-free** (dock 687 → 669.8, line 28 → 45.2). **After: 7/7.**
  `SPACING_TAG=<tag>` writes the shots and the jsonl.
- **Shots** (before → after, same names): `ux-spacing-<tag>-voice-{idle,synthesizing,speaking,heard,drop,hands-free}`,
  `-session-{idle,working,idle-after,done-device}`, `-main-{idle,done-device,onboarding}`, `-home-{idle,done-device}`,
  `-settings-idle`, `-artifacts-idle`, `-session-settings-idle`, `-{home,session}-w{412,430,1280}-idle` (.png).
- **General suite** on :8090 after the swap: 77 passed · 13 failed · 3 skipped. 0 of the failures come from the CSS
  (table below).

## Named, not changed

- **N1 — the safe areas are dormant.** The viewport has no `viewport-fit=cover`, so `env(safe-area-inset-*)` resolves
  to 0 on the S22 (and in every test). The chrome now handles it uniformly, so turning `cover` on is a single
  `layout.tsx` line. That changes what the phone draws under its system bars, so it needs a phone retest. It is not
  in this diff.
- **N2 — the phase line is 10.5 px, was 11.** That is the price of one line at 360: the hands-free words are 347 px
  at 11 px, and the column is 336. The brand already uses 10.5 px for sub-copy. Shorter copy would be the other
  way, but that is a copy decision, not a spacing one.
- **N3 — home footer 84, session footer 81.** The roots are the MAINFRAME-C drawing, with their own art and label
  row at 44. The session footer is built from the scale. Both are fixed and neither moves. Forcing 81 = 84 would be
  numerology.
- **N4 — what sits under each header differs.** The session has the 2 px rail (it carries the voice state). Home
  has the 90 px crown band. Settings and artifacts have nothing. These are three different objects, all by design.
- **N5 — scroll pages vs app pages.** Settings, artifacts and session settings scroll their 52 px header away with
  the page. The session keeps it (flex column). Same height either way. Their `pb-6` tail has no safe area (dormant,
  N1).
- **N6 — header type.** BIFROST is 14 px bold, a slug is 13 px regular. That is hierarchy, not height.
- **N7 — working shows nothing in the footer line.** `9f43c8e` only draws the glyph when there are words, and
  `4028224` gave working none. So the "dot" of working is the header's breathing ● and the transcript's
  "● working… Ns". If the intent was a ● in the footer line too, that is one TSX condition, and the line won't
  move either way now.
- **N8 — the composer grows while you type** (textarea autogrow up to 96 px). That is content the user types, not
  state.
- **For other owners:** `playwright.config.ts` sets a 360×780 viewport, but the project's `devices['Desktop Chrome']`
  overrides it. The general suite really runs at **1280×720** (`artifacts/e2e-home.png` is 1280×720). The chrome
  spec sets its own S22 viewport.

## Build path

This lane ran in the `agi-lane` cgroup, not `lk-yggdrasil`, so plain `npm run build` worked (JIT available). I built
in a scratch worktree (`/tmp/ux-spacing`, detached at `f90fe13`, `node_modules` symlinked) and served it on the sim
stack. The fix was committed there and fast-forwarded onto lab/sandbox (`b645f8b`). The swap: the served `.next`
was backed up to `/tmp/ux-spacing-prev-next` (build `3kP26…`), then `systemctl --user stop bifrost-sandbox` →
`rsync` the scratch `.next` (cache excluded) → `start`. No build ran in the tree, because the [MAIN] session builds
there too. The served app's version string reads `0.5.0-82-gf90fe13`, the base the scratch tree described.
**Rollback:** stop → `rsync -a --delete --exclude cache /tmp/ux-spacing-prev-next/ pwa/.next/` → start.

## General suite (default config, `PW_BASE_URL=http://127.0.0.1:8090`, build `q86_FOt7lpPWB10I6fwez`)

**77 passed · 13 failed · 3 skipped** (93 tests; the baseline was 72/11/3 on 86). **0 failures from the chrome
change.**

| failures | cause | proof |
|---|---|---|
| `chrome-spacing:146` (mine) | spec timing: on the real stack the hands-free exit tap landed inside the app's 400 ms ghost guard and was eaten. All the measurements before it had passed | wait 600 ms → **7/7 on :8090** |
| `mainframe-c-*` ×7 | the wrong config, as in the baseline. Under their own config: 21/22. The one red, `roots:196` (Tab must reach the roots in 40 presses), **was mine**: my first runs left 14 `e2e-spacing-*` sessions in the sandbox brain, and the longer list pushed the roots out of reach | deleted all 14 (HTTP 200 each); the spec now deletes every session it opens (`afterEach`) → `mainframe-c-roots` **8/8**, so 22/22 |
| `hf-quick-tap:84` ×2, `voice-ui:17` | the stale idle-copy / `○` expectations from MAIN's 10-27 commits (the same as the baseline) | received `""` on `<p class="oz-phase" data-s="idle">` |
| `queue:10` | a strict-mode locator: `'new session'` also matched three old rows titled "New session" in the list | passes on rerun (with the chrome spec, 9/9) |
| `ux-batch-voicetest:24` | the known `.last()` bubble race (the same as the baseline) | — |
