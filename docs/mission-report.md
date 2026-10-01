# Mission report — cohesive-2 rebuild (bifrost PWA + veraldar.org)

Worker: REBUILD-COHESIVE · 2026-10-01 · req 10-01 cohesive rebuild
Source of truth: `artifacts/cohesive-2-opus.html` ("signal path").
Branches (not pushed, main untouched):

- bifrost `rebuild/cohesive-opus` (worktree `~/Work/bifrost-rebuild`)
- veraldar-site `rebuild/cohesive-opus` (worktree `~/Work/veraldar-site-rebuild`)

Live box untouched: no edits/builds in `~/Work/bifrost` or `~/Work/veraldar-site`,
no restarts of `lk-pwa` / `lk-agent` / `opencode-serve`. My own production
build ran on `127.0.0.1:3311` (PWA) and `127.0.0.1:3312` (site).

## What changed

### bifrost PWA — every screen wears the brand, logic untouched

- **Design system** `pwa/styles/brand.css` (one `@layer components` block, so
  Tailwind utilities still override): square hairlines, one key control
  (`.oz-k` + `ok/red/on/heard/drop` tints), lowercase `## ` heads (decorative,
  kept out of accessible names), motion slowed to breathing, reduced-motion
  holds still and draws the tree's traces whole.
- **Signal rail + exact-words line** on the session screen: one derived tone
  (`idle / heard / working / speaking / drop`) from `holding`, `pttCancelArm`,
  `voiceState`, `speech.phase`, `mode`, `freeCycle`, `busy` drives the 1px rail,
  the glyph (○ ◉ ● ▸ ×) and the sentence. Color is never alone.
- **State law reclaimed**: amber = heard only (PTT pill + hands-free bars go
  amber, held mic glows + rings); working/busy dots → green breathing;
  unread → weight + a text-colored dot; open question ○ stays; search hits →
  sky; artifact badge → text.
- **The tree** `components/ygg.tsx`: one drawing (13 traces + 7 signals,
  inline, ~2.7 kB), CSS-governed: home has the quiet band that walks one
  thought at a time only while a run is live and falls still otherwise;
  settings draws each world in its own palette and the tapped world answers
  with one pulse up the trunk. The fixed full-screen backdrops are gone.
- **Line icons** `components/line-icon.tsx` replace the pixel set; the
  artifact glyph is the runestone from cohesive-2.
- **Copy**: BIFROST wordmark alone in caps (no B-glyph), "(assistant)" →
  "(agent)", 📎/📄 → line icons, settings gains "## about" (a Veraldar
  product., AGPL-3.0) and "## yours" (possession named; mic state read-only
  with the honest note that the browser grants/revokes).
- Screens: sessions, session (chat/dock/deck/hands-free/search/history),
  session settings, settings (worlds), artifacts gallery, error box.

### veraldar.org — static, rebuilt per the artifact

`index.html` is the brand surface: wordmark + cursor, 3-world switch, the
world-tree lead **"the world-tree terminus leads · 30.7%→"** (follows
`realms.json` once the pipeline has a non-seed leader), the circuit tree with
guardian-governed motion (one wake pulse on first sight, hold = amber heard
with pulses walking outward, otherwise still), three names, the mix-2 ascii
diagram **verbatim incl. its tailnet line** (checked programmatically against
the artifact), products card, a working "bifrost, wearing the brand"
miniature, footer. The previous realm-weights page lives on as
`world-tree.html` (lead line links there). Public contract (`theme.json`,
`tokens.css`, `realms.json`, `icon.svg`, `theme-assets/`, `pipeline/`)
byte-identical to main.

## Feature parity (§Hard-1) — each item and its proof

E2E: full suite against `:3311`, workers=1, phone viewport, watchdog-zombie
testIgnore'd. Result: see **Verify** below.

| feature | proof |
|---|---|
| sessions: create | `base` create session → opens view; `states` session states |
| sessions: list | `base` home: list renders; `states` home screenshot |
| sessions: swipe-delete + undo | `subs` sub-session swipes left to delete, with undo window |
| sub-sessions + mercy window | `subs` nest behind the subs pill; swipe-delete toast (`· N msgs`, window scales) |
| voice: hold-PTT | `base` voice: PTT connects to LiveKit, room stays warm; `voice-ui` held mic → heard, slide → drop |
| voice: tap-toggle hands-free | `base` hands-free arms; `states` keyword protocol status; `voice-ui` tap → hands-free |
| tap-to-send | `voice-ui` hands-free strip is the "send what you said" button (commit path code unchanged) |
| on-open autoplay of unheard reply (`lib/heard.ts`) | no spec exists on main either; effect + watermark code is byte-identical (only JSX changed) — listen chip marks heard, deck plays: `rebuild-states.mjs` speaking shots |
| settings: name / model / think / agent | `settings` ×5 (tiles render, think switch/revert, rename + URL follows, picker filter + no-think state, two-tap delete) |
| artifacts gallery + unseen watermarks | `artifacts` bell counts, gallery opens + marks seen, mark all read, api order |
| full-screen html viewer + corner open-in-new-tab | `artifacts` thumbnail opens raw page; card corner opens new tab |
| run-events SSE + wedge escape | `wedge` stacked prompt must not wedge-abort; dead run must event-quiet wedge |
| watchdog error surfacing | `wedge` (error text surfaced through ErrorBox); zombie spec needs its own server (testIgnore'd per mission) |
| message history | `history` ×3 (swipe browser, touch pipeline, input recall) |
| chat files | `chat-files` artifact links render inline viewers; `base` attachments |
| context | `context` fresh session answers with bifrost context |
| queue | `queue` mid-run send queues, cancel advances to it |
| search (transcript) | `states` search: hit ring (now sky, `oz-hit`), 1/2 counter, jump, Escape |
| themes (new) | `theme` tap a world → applies instantly, persists, tokens follow, own palette per world |
| push notifications, diag logging | logic untouched (`lib/notify.ts`, `lib/push.ts`, `lib/diag.ts`, DiagBoot unchanged); no spec on main |

Spec edits (copy/selector follow-ups, no assertion weakened): `'(assistant'`
→ `'(agent'` (base, queue, context); hit-ring probe `/oz-active/` →
`/\boz-hit\b/` (states); sent file asserted as `[data-mi] summary` with
`note.md` instead of the 📎 glyph (base). New: `theme.spec.ts`,
`voice-ui.spec.ts`.

## Theme switch — mechanism (kept, still one attribute)

`pwa/styles/tokens.css` (generated, unchanged) defines `--oz-*` per
`[data-theme]`; next-themes writes `data-theme` on `<html>` (`attribute=
"data-theme"`, themes aether/terminus/drift). New:
`disableTransitionOnChange` suppresses transitions for the swap frame (instant
flip, no morph lag); per-world finish is CSS vars in `brand.css`
(`--oz-rule: dotted` in drift, `--oz-tick: 1` corner ticks in terminus);
`<ThemeColor/>` points `<meta theme-color>` at the live `--oz-bg`. To switch
in code: `setTheme('drift')`. To add a world: one block in tokens.css + one
entry in `app/settings/page.tsx` WORLDS. Each world button carries its own
`data-theme`, so the preview is drawn in that world's palette.

On "tree changes structurally per theme": cohesive-2 defines worlds as *same
topology, different finish* (one drawing, ornament per world) — the artifact
wins over the older r2 phrasing; noted here so the coordinator can push back.

## Performance

`next build`, route sizes (size / first-load JS):

| route | before (main @ c5e4b11) | after |
|---|---|---|
| `/` | 7.04 kB / 119 kB | 7.54 kB / 119 kB |
| `/session/[slug]` | 160 kB / 487 kB | 159 kB / 486 kB |
| `/session/[slug]/settings` | 6.46 kB / 115 kB | 6.09 kB / 114 kB |
| `/settings` | 4.05 kB / 116 kB | 5.04 kB / 117 kB |
| `/artifacts` | 4.71 kB / 332 kB | 3.73 kB / 331 kB |
| shared | 108 kB | 108 kB |

Net flat-to-smaller; no dependency added; no animation library (CSS
keyframes + SVG `pathLength` dashes only, zero JS animation loops — the band
and rail are pure CSS). Removed per-page backdrop SVG fetches (5 kB aether,
27.7 kB drift, 5.7 kB terminus). The tree at rest runs no animations
(verified on the site: `document.getAnimations()` on the tree = 0).
veraldar.org: one 26 kB HTML + a cacheable 57 kB woff (the artifact inlined
it base64 in every page load).

## Verify — evidence

- bifrost `npm run build`: green (log tail above, route table).
- e2e run 1 (full): 36 passed, 1 failed (`base` voice PTT "room stays warm":
  one LiveKit socket closed), 1 skipped (its cleanup). Re-run of `base` ×3 in
  isolation: 8/8 each — flaky under load, not a regression. Log:
  `artifacts/rebuild/e2e-run-1.log`.
- e2e run 2 (full, final build): **38 passed, 0 failed** (3.9m) —
  `artifacts/rebuild/e2e-run-2.log`.
- `voice-ui.spec.ts` (new, written after run 2): 1/1 passed.
- e2e run 3 (full, 39 specs incl. voice-ui): 35 passed, 3 failed, 1 skipped —
  `base` round-trip waited >20s for the agent's reply (the echo already
  matched "pong", so the 90s window never applied), and the next two `base`
  tests cascade from the worker restart (empty `sessionId`). `base` re-run
  ×2 right after: round-trip green both times (8.7s). Log:
  `artifacts/rebuild/e2e-run-3.log`.
- **The voice "room stays warm" flake is on main too.** A throwaway build of
  main (`c5e4b11`, port 3313, removed afterwards) vs this branch, full `base`
  spec ×8 rounds each, interleaved: main 2 failures, rebuild 2 failures —
  same test, same 6.0s signature (one LiveKit socket closes). Alone (`-g
  voice`) it passes 6/6 on both. Pre-existing, not a regression. The six
  sessions the failed runs left behind (cleanup is skipped after a worker
  restart) were deleted.
- veraldar-site: `scripts/veraldar-shots.mjs` 20/20 checks (pre-paint world
  restore ×3, wake on first sight, still after, 0 animations at rest, switch +
  persist, hold → heard → dim, miniature heard → working → idle, contract
  files served, world-tree page renders).
- `agent/`: no change needed — the rebuild is UI-only.

## Decisions worth a second look

1. **Artifact glyph**: the brief lists "Mjölnir pixel rune"; cohesive-2 (the
   later user edit: "session-list doc icon → runestone artifact glyph", "no
   pixel art") draws a line runestone, and review-checklist G auto-fails a
   pixel/geometry hybrid. Shipped the runestone.
2. **Install command** on veraldar.org uses the real repo
   `github.com/veraldar/yggdrasil-bifrost` (the mock said `veraldar/bifrost`).
3. **No export link** in "## yours": the mock showed `export →`, but there is
   no export feature — the copy says where sessions live instead.
4. **Mic revoke**: a page cannot revoke its own grant; the row is read-only.
5. **World-tree lead** is live data once the pipeline writes non-seed weights;
   until then it shows the locked line.

## Ship-gate self-review (review-checklist part 2)

- A gut: one thing across app/site (same tree, same rail, same key); terminal,
  not chat-app; tree present as band/minis/hero, never behind text. ✓
- B voice/lore: no fluff/emoji in brand copy; "a Veraldar product." on the
  card and settings; limits stated; Midgard/Asgard only in the lore list. ✓
- C color: three shipped palettes only; amber only for heard; glyph + words
  accompany every state. ✓
- D loyalty: no feelings in copy; exit copy neutral; possession named
  ("## yours"); consent screens untouched (no mascot). ✓
- E screens: list readable, chat column never widens (fixed a nowrap overflow
  during build), four voice states + drop unambiguous, undo bar visible. ✓
- F site: brand surface; tree animation means something (wake/heard only). ✓
- Open: the warden mascot is not in cohesive-2 and was not added.

## Screenshots — `artifacts/rebuild/`

- before/after × aether/terminus/drift × home, session, session-settings,
  settings, artifacts: `before-<world>-<screen>.png`, `after-<world>-<screen>.png`
- voice states × 3 worlds: `state-<world>-{1-keyboard,2-working,3-replied,
  4-heard-ptt,5-drop-armed,6-handsfree,7-synth,8-speaking}.png`
- veraldar.org: `veraldar-{aether,terminus,drift}.png` (+ `-full.png`),
  `veraldar-terminus-tree-held.png`, `veraldar-terminus-mic-held.png`,
  `veraldar-world-tree-page.png`
- e2e logs: `e2e-run-1.log`, `e2e-run-2.log`

Recapture: `cd pwa && node scripts/rebuild-shots.mjs <tag>`,
`node scripts/rebuild-states.mjs`, `node scripts/veraldar-shots.mjs`.
