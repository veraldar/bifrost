# Veraldar design rework — brief v2 (freedom-first)

*BRAND session, 2026-09-30, revised same day. v1 of this brief was reviewed by
the user and judged too narrow. This version grants the executing model real
design freedom. v1's theses (T1–T6) are context, not constraints. Read order:
`brand.md` (Part 1 voice/lore still governs copy) → this file → inventory in
§4 → `review-checklist.md` (how the user will judge you).*

## 1. The mandate in one line

Redesign the **bifrost PWA** and **veraldar.org** completely. First propose
**three complete, deliberately different design directions** as wireframe
propositions. The user picks one — he does not yet know what he likes, your
job is to show him. Then you build the chosen direction with near-total
freedom.

## 2. Phase 1 — propose (do this first)

What the user fixed (the only hard constraints):

1. **The Yggdrasil tree stays.** The black-and-white line-art tree
   (`pwa/public/yggdrasil_final.svg`, circuit-trace geometry) is the core of
   the identity — the base everything else sits on. Nordic, minimal,
   geometric. It is currently the session-list background, switchable per
   theme; whether it stays exactly, gets refined variants, or spawns a family
   is your call — but the tree is the brand image in every direction.
2. **The palettes stay.** The three theme palettes shipped in
   `pwa/styles/tokens.css` (aether deep-space / terminus warm CRT / drift
   light) are what the user likes. Use them as given. You may propose names,
   roles, and usage refinements — not new colors.
3. **Voice and lore are fixed.** `brand.md` Part 1: tone (terse, honest,
   terminal-native), word list, attribution ("a Veraldar product"), AGPL,
   no corporate fluff. Copy in the propositions must pass it.
4. **State semantics are fixed.** "Amber means you are heard, dim means you
   are not" (req 09-30); green=alive, red=stop. How you express them
   (glow, ring, blink, anything) is yours.
5. **The loyalty clause is fixed** (`brand.md` §3, verbatim): Veraldar's
   loyalty is to the user's future independence, not to the user's continued
   presence. If a proposition includes a mascot, it reads as a calm guardian
   of the local environment — skin, never strategy; absent from all consent,
   credential, and prod moments; no simulated feelings, no guilt on exit.
   Copy never implies the system has needs or feelings of its own: no
   "I'm happy to", no favor-framing at permissions, neutral exit lines.
   Full clause + copy law + mascot rules: `brand.md` §3, `visual.md`
   ("The warden").

The open axis — answer it by contrast:

- **Pixel art vs Nordic geometry.** The user is genuinely unsure: pixel art
  exists today in some UX components and in a website tree variant, and he
  doesn't know if it should stay. Your three directions resolve this:
  **at most one** may lean pixel-art; at least two are fully geometry-native
  (old-Norse minimal line work like the tree). Even a pixel direction keeps
  the geometric tree at its core. Beyond that: no pixel-art hedge — commit.

Everything else is yours: layout, type, iconography, component shapes, motion
language, theme names, density, chrome. The previous session's leanings
(realms naming, 4px radii, mono-only, four-motion vocabulary) are recorded in
git history of this file — treat them as one voice among many, discard freely.
Surprise the user.

Deliverable for phase 1 — **exactly three propositions, one pass, no spiral**:

- Three **self-contained single-file HTML** mock pages in `artifacts/`
  (`design-1-<name>.html`, `design-2-...`, `design-3-...`). The user reviews
  on his phone through artifact links — inline everything (SVG, CSS, fonts
  via system fallbacks; no external requests).
- Each file: a 3–5 line direction statement at the top (name the idea, state
  the pixel-vs-geometry call, state what you'd change in phase 2), then the
  **website** (landing hero, the lore section per `lore-page.md`, attribution
  footer), then the **app** (session list, chat, the four voice states —
  idle / listening-amber / speaking / working — plus settings and session
  settings).
- Wireframe fidelity: real palettes, real tree, real copy rules — structure
  and direction over polish. Do not burn effort on production details; phase
  1 exists to find the direction cheaply.

## 3. Phase 2 — build (only after the user picks)

Implement the chosen direction end-to-end, both surfaces, near-total freedom:

- bifrost PWA: all screens, all motion redone completely your way, component
  system, icons, backdrops. veraldar.org: full site, animations included.
- You may rework the token pipeline (upstream DTCG source), theme names, and
  every doc under `docs/brand/` design sections — but when you land, the docs
  must describe what ships (near-CSS tokens, visual spec, updated checklist).
- Still fixed: the palettes, the tree, voice/lore, state semantics, AGPL and
  open-licensed assets only.
- Ship gate: `review-checklist.md` part 2. One review cycle. Launch opens
  after it.

## 4. Current state — inventory (verified 09-30, still true)

Product surfaces (pwa/app/): session list `app/page.tsx`; chat/voice
`app/session/[slug]/page.tsx` (PTT + hands-free, mid-right mic button — a
separate session is reworking it in flight; expect merge, design for the
interaction not the current markup); session settings
`app/session/[slug]/settings/page.tsx`; global settings `app/settings/page.tsx`
(includes theme); shell `app/layout.tsx` (next-themes).

Styles: `pwa/styles/tokens.css` (GENERATED — veraldar-theme DTCG →
`scripts/build.sh`; phase 1 never edits it; phase 2 works upstream),
`pwa/styles/globals.css` (wiring, current motion, backdrops). Assets:
`pwa/public/yggdrasil_final.svg` (the tree), `pwa/public/backdrops/*.svg`,
Commit Mono woff, pixelarticons base. Website today: `docs/launch/landing.html`
(LAUNCH session's — coordinate, don't clobber) + `docs/launch/positioning.md`
copy.

Prior art (scratch, `artifacts/`): `proposal_{niflheim,muspelheim,alfheim}.png`
(realm-named theme explorations), `ident-{1-rune,2-bridge,3-sigils}.svg`,
`veraldar-seven-realms.png`, `bd-*.svg`, `bifrost-pixelart.png`. Input, not
verdicts. Also: `artifacts/veraldar-wireframe.html` — the first probe (opus,
09-30): aether-primary landing, working palette switcher, hold-the-tree amber
"heard" interaction, loyalty-clause-clean copy. Count it as one of the three
directions or supersede it.

## 5. Decisions split

- **You decide alone (phase 1):** everything visual. State a one-line reason
  per major call inside each proposition's direction statement.
- **You decide alone (phase 2):** implementation, pipeline, docs rewrites.
- **Only the user decides:** which of the three directions wins (phase-1
  review), and — phase 2, not blocking — the veraldar.org domain/repo
  question. Don't ask anything else; it's one review cycle per phase.

## 6. Handoff notes

- AGPL repo, open-licensed assets only (Commit Mono OFL, pixelarticons MIT;
  anything new must match that bar).
- Never hand-edit `pwa/styles/tokens.css`; upstream source is veraldar-theme.
- The lore page copy (`lore-page.md`) is drafted and launch-approved in tone —
  reuse or improve within voice rules, don't re-invent the mythology: Veraldar
  is the brand (the world), Yggdrasil the tree, Bifrost its first product.
- When done with a phase, update your claim line in `docs/claims.md`.
