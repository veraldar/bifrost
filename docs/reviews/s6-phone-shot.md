# S6 PHONE-SHOT — report (2026-10-27)

**Tool:** `scripts/phone-shot.mjs` — Playwright (from `pwa/node_modules`), Pixel 7 class (412x915 @2.625, touch, mobile).
States: `door` (fresh device), `front` (returning: `bifrost-door`, `bifrost-first-turn`, `bifrost-roots-held` set), `main` (`/session/main`), `settings`.
Output: `artifacts/phone-<tag>-<state>.png`; prints one `![state](/api/artifact/…)` line per shot. Tag defaults to the build's BUILD_ID.

    node scripts/phone-shot.mjs --url http://127.0.0.1:PORT [--states door,front] [--tag x] [--out dir] [--wait ms]

Default URL is the sandbox (:8090). It refuses :8080/:4096 (live). It only reads; live is never touched.

## Done-check (F5): the 10-27 glyph as a png, one call, pre-`bb6e265`
- Scratch worktree of `bb6e265^` (`61182dc`, from lab/sandbox), `npm run build` (39 s), `next start -p 8197`. Worktree removed and server stopped afterwards.
- One call: `node scripts/phone-shot.mjs --url http://127.0.0.1:8197 --tag pre-bb6e265` → rc 0, four pngs `phone-pre-bb6e265-{door,front,main,settings}.png`.
- Read back: **front** shows the mic glyph at the right end of the roots bar (bottom-right), the glyph `bb6e265` removed. **door** shows the tree alone, "hold the tree to begin". I did not open the main/settings pngs; they were produced without error.

## Notes
- `roots.tsx` exists only on lab/sandbox, not on `rebuild/cohesive-opus`; the script takes a URL, so it is branch-agnostic.
- Not covered: a post-`bb6e265` comparison shot, hold/tap interaction states, pixel diffing. Nothing committed.
