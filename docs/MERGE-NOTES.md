# MERGE-NOTES — `rebuild/cohesive-opus` vs `main` (bifrost)

Branch: `rebuild/cohesive-opus`, cut from `main` at `99ba081` (+ the mission
brief `c5e4b11`). Scope: the PWA re-skin to cohesive-2 "signal path". No
agent, deploy, API-route or lib changes. Not pushed; main untouched.

## How to merge

The rebuild changed **markup and styles only** — every handler, effect, ref
and fetch in the pages is byte-for-byte the code it was cut from. When main
moved underneath (wedge-fix, onboard-p1, android-lab), resolve like this:

1. Take main's **logic** (anything above the `return (` of a page component,
   all of `lib/`, `app/api/`).
2. Take this branch's **render tree** (the JSX below `return (`) and re-thread
   any new state main added into it. Class vocabulary lives in
   `pwa/styles/brand.css`; there is no other place to look.
3. Run `cd pwa && npm run build` and the e2e suite (against a non-live port).

## Files that diverge hard (expect conflicts)

| file | what changed here | merge hint |
|---|---|---|
| `pwa/app/session/[slug]/page.tsx` | render tree rewritten: `oz-head`, signal rail (`oz-rail[data-s]`), dock (`oz-dock/oz-k/oz-ta/oz-pill`), deck (`oz-deck`), phase line (`oz-phase`, carries `data-testid=free-phase` in hands-free only). New derived `tone/words` block just above `return (`. `PixelIcon`→`LineIcon`/`StopSquare`. `PTT_BARS` 5→9, bar height clamped to 22px. | Hottest file on main (wedge-fix). Keep main's logic; re-apply the JSX. The `tone` derivation reads `holding/pttCancelArm/voiceState/speech.phase/mode/freeCycle/busy` — if main renames any, update there. |
| `pwa/app/page.tsx` | header (BIFROST wordmark alone, runestone artifact key + text badge), tree band (`YggTree`, live while any run is pending), rows (`oz-row/oz-r1/oz-r2`, swipe zone says "delete"), subs pill, kids, toast. State law: working = green breathe, unread = weight + text dot. `SwipeRow` gained an `unread` prop. | Logic identical to `99ba081`. |
| `pwa/app/settings/page.tsx` | full rewrite: about / world / yours blocks; world list = theme switch (each world button carries `data-theme`, mini tree wakes on tap); mic permission read-only. | Old slider page is gone; take this file whole unless main changed theme mechanics. |
| `pwa/app/session/[slug]/settings/page.tsx` | render tree → `oz-blk` blocks, `oz-field/oz-pick/oz-mlist/oz-chips/oz-del`. | Logic untouched. |
| `pwa/app/artifacts/page.tsx` | render tree → `oz-head/oz-tabs/oz-row`, unseen = weight + text dot, corner key `oz-k sm`. | Logic untouched. |
| `pwa/components/session-message.tsx` | `(assistant)` → `(agent)`; hit ring → `oz-hit` (sky); 📎/📄 → line icons; square frames. | |
| `pwa/components/message-history.tsx`, `marked.tsx`, `app/error-box.tsx` | small class swaps (search marks sky; error box square + `role=alert`). | |
| `pwa/styles/globals.css` | old `.oz-*` blocks (backdrop, eq, seek, tts-dot, ptt-hold, free-live, toast-bar, busy) removed → moved/restyled into `brand.css`. | If main added a new `.oz-*` rule, move it into `brand.css` (inside `@layer components`). |
| `pwa/app/layout.tsx` | `disableTransitionOnChange` on ThemeProvider; `<ThemeColor />`. | |

## New files

- `pwa/styles/brand.css` — the design system (one `@layer components` block + reduced-motion).
- `pwa/components/ygg.tsx` — the one circuit-tree drawing (13 base paths, 7 signals), CSS-governed motion.
- `pwa/components/line-icon.tsx` — 16-grid line icons (replaces `pixel-icon.tsx`).
- `pwa/components/theme-color.tsx` — `<meta theme-color>` follows `--oz-bg`.
- `pwa/e2e/theme.spec.ts` — worlds apply / persist / tokens follow.
- `pwa/playwright.rebuild.config.ts` — same suite aimed at `127.0.0.1:3311` (never the live :8080).
- `pwa/scripts/rebuild-shots.mjs`, `rebuild-states.mjs`, `veraldar-shots.mjs` — evidence capture.

## Deleted files

- `pwa/components/pixel-icon.tsx` — no importers left. If main adds a new
  `PixelIcon` use, map it to `LineIcon` (add the glyph to `line-icon.tsx`).
- `pwa/public/yggdrasil_final.svg`, `pwa/public/backdrops/{terminus,drift}.svg` —
  the fixed full-screen backdrops are gone (the tree lives in the band and the
  world minis). Nothing else referenced them.

## e2e spec edits (copy/selector follow-ups, assertions not weakened)

- `base.spec.ts`: `'(assistant'` → `'(agent'`; sent file asserted as
  `[data-mi] summary` containing `note.md` (the 📎 emoji glyph is gone).
- `queue.spec.ts`: last-role check `'(assistant)'` → `'(agent)'`.
- `context.spec.ts`: `/\(assistant/` → `/\(agent/`.
- `states.spec.ts`: hit-ring class probe `/oz-active/` → `/\boz-hit\b/` (search hits are sky now).
- If main edits these specs, re-apply the four one-line swaps.

## Not changed (deliberately)

- `agent/` — the UI rebuild needed no agent change.
- `pwa/styles/tokens.css` — palettes are generated and already the cohesive-2 values.
- `pwa/package.json` — no deps added/removed (`pixelarticons` is now unused; drop it in a later cleanup if wanted).
- `docs/claims.md` — the coordinator holds the claim.
