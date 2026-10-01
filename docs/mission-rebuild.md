# MISSION — rebuild bifrost PWA + veraldar.org per cohesive-2-opus

You are the REBUILD-COHESIVE worker session. Execute this mission end-to-end,
autonomously, on the branches you are already sitting on. You were started with
claude opus + effort high. Proceed autonomously; verify with evidence.

## Source of truth (the design)

- `/home/dweeb_xyz/Work/bifrost/artifacts/cohesive-2-opus.html` — THE chosen design
  ("signal path — veraldar.org + bifrost"). Self-contained: veraldar.org screens +
  bifrost PWA screens + working 3-theme switcher (aether / drift / terminus) +
  state-law motion. Rebuild the real product to match this, same brand image.
- Theme previews: `/home/dweeb_xyz/Work/bifrost/artifacts/cohesive-2-{aether,drift,terminus}.png`
- Brand law (binding): `/home/dweeb_xyz/Work/bifrost/docs/brand/brand.md` (§3 loyalty
  clause), `tokens.md`, `visual.md`, `rework-brief.md`, `review-checklist.md` (part 2
  is the ship gate — self-review against it).
- Copy decisions already locked: no "tailnet" in brand copy; BIFROST full caps, no
  B-glyph in the app; world-tree lead "terminus leads · 30.7%→"; mix-2 ascii diagram
  verbatim; artifact glyph (Mjölnir pixel rune) for artifacts/docs.

## Territory — work here, nowhere else

You are in a git worktree. This is deliberate:

- YOUR bifrost checkout: `/home/dweeb_xyz/Work/bifrost-rebuild` (branch
  `rebuild/cohesive-opus`, cut from main). All bifrost work here.
- YOUR veraldar-site checkout: `/home/dweeb_xyz/Work/veraldar-site-rebuild`
  (branch `rebuild/cohesive-opus`). All veraldar.org work here.
- OFF-LIMITS: `/home/dweeb_xyz/Work/bifrost` and `/home/dweeb_xyz/Work/veraldar-site`
  main checkouts — the LIVE box serves from there (lk-pwa runs
  `next start -p 8080` from `/home/dweeb_xyz/Work/bifrost/pwa`). Never edit,
  never build, never restart `lk-pwa` / `lk-agent` / `opencode-serve`.
- Do NOT edit `docs/claims.md` anywhere — the coordinator holds the claim
  "rebuild-cohesive" for you.
- Other sessions are working on main (wedge-fix, onboard-p1, launch, android-lab).
  Merge conflicts later are expected and fine — log every file where your branch
  diverges hard from main in `docs/MERGE-NOTES.md` (both repos).

## Hard requirements

1. All functionality and features must stand. Current PWA feature inventory
   (e2e specs in `pwa/e2e/` are the referee):
   sessions (create/list/swipe-delete/sub-sessions w/ mercy window), voice
   hands-free + hold-PTT + tap-toggle, tap-to-send, on-open autoplay of unheard
   last reply (heard watermark, `pwa/lib/heard.ts`), settings (name/model/think/
   agent via opencode switch endpoints), artifacts gallery + unseen watermarks +
   full-screen html viewer + corner open-in-new-tab, run-events SSE + wedge
   escape + watchdog error surfacing, message history, chat files, context,
   queue, push notifications, diag logging.
2. Theme switch must stay as easy as it is now — `pwa/styles/tokens.css` +
   next-themes (`data-theme` attribute: aether/drift/terminus). Keep the
   mechanism; re-skin the token values + themed surfaces per the artifact.
   Themes are different worlds of one civilization — tree/backdrop changes
   structurally per theme, but switching is instant, no morph lag.
3. Performance/quality must improve or stand: no heavy animation libs — the
   artifact does everything with CSS/SVG/inline JS; keep the server-component
   structure lean; bundle must not grow meaningfully; keep e2e green.
4. veraldar-site: rebuild the public page per the artifact (three names,
   products, bifrost-wearing-the-brand, ascii diagram verbatim incl. its
   tailnet line, world-tree with "terminus leads · 30.7%→", guardian-governed
   tree animation). Preserve the repo's public contract: `theme.json`,
   `tokens.css`, `realms.json`, `icon.svg`, `theme-assets/` must keep working
   for consumers; `pipeline/` is untouched tooling. It is a static site —
   keep it static.
5. Secrets stay out of git. Commit small and often on your branches with
   req-linked messages (`req 10-01 cohesive rebuild`). Do NOT push, do NOT
   touch main. Publishing to the world is a LATER decision — not this mission.

## Verify (evidence before "done")

- bifrost: `cd /home/dweeb_xyz/Work/bifrost-rebuild/pwa && npm run build`
  (node_modules pre-installed by coordinator).
- e2e: the repo's playwright config hardcodes baseURL `http://127.0.0.1:8080`
  (the LIVE server — never point tests at it). Start your own production build
  on a spare port, e.g. `PORT=3311 npm start`, and run playwright against it by
  making a branch-local config override (copy playwright.config.ts to
  playwright.rebuild.config.ts with baseURL `http://127.0.0.1:3311` and
  `npx playwright test --config=playwright.rebuild.config.ts`). workers=1,
  same phone viewport. All specs except watchdog-zombie (testIgnore'd) must
  pass; do not weaken test assertions to get green.
- Agent (`agent/`): Python livekit worker — UI rebuild should not need agent
  changes; if you believe it does, stop and write the reasoning to
  `docs/MERGE-NOTES.md` instead of changing it.
- veraldar-site: serve the dir (e.g. `python3 -m http.server`) and screenshot
  all 3 themes + interactive checks (theme switch, tree animation).
- Screenshot evidence: save before/after + per-theme screenshots into
  `/home/dweeb_xyz/Work/bifrost-rebuild/artifacts/rebuild/` so the coordinator
  can deliver them to the user (who is on a phone and cannot open paths).

## Deliverables

1. Both branches rebuilt and verified (build + e2e evidence in the log).
2. `docs/MERGE-NOTES.md` in each repo: divergence summary vs main.
3. `/home/dweeb_xyz/Work/bifrost-rebuild/docs/mission-report.md` — final report:
   what changed, feature parity checklist (every item from §Hard-1 ticked with
   the e2e spec that proves it), theme-switch mechanism description, perf notes
   (bundle size before/after from build output), screenshots index.
4. When done, print "MISSION COMPLETE" + the report path as your final output.
