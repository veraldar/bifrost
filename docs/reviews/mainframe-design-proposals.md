# Main-frame entry: three proposals (one tree, roots = MAIN)

*Session MAINFRAME-DESIGN, 2026-10-24. Design only. I changed no product code. The user's note from 10-24: the
button that opens MAIN is a small tree icon at the bottom, while the top of the page already shows the living tree.
Showing the tree twice is wrong. The bottom spot is right. Sketch: the top tree stays the working light and maybe
shows more of the branch (the work); full width at the bottom go **the roots**, and tapping them opens MAIN.*

**Try it:** [the interactive mockup](/api/artifact/mainframe-proposals.html). It has today plus A, B and C, each in
four states. Press the roots and they go amber. Let go and MAIN "opens". In C, hold longer than 0.3 s to talk.

![the entry itself, every state](/api/artifact/mainframe-roots-close.png)

## Verdict in four lines

1. **Every proposal has one tree, split between the two ends of the screen.** The crown sits on top (the work, the
   working light). The roots are full width at the bottom (MAIN). The list in between is the trunk. The drawing has
   **no roots today**: its trunk leaves the bottom edge at five points. So the roots are that same tree continued
   downward, not a copy of it. That removes the duplication by construction.
2. **A · roots** (S) is the user's sketch built clean: the corner door is gone, the MAIN row leaves the list, and the
   roots carry MAIN's state. **B · one tree** (M) is A plus a crown that names the work on its boughs. **C · hold
   the roots** (L) is A plus MAIN's mic on the roots: hold to talk to MAIN without leaving the list.
3. **The press stays sacred in all three.** Press = amber in the same frame (a class flip on pointerdown, the door's
   exact code path), and the word is "heard", nothing more (`tree-door.md`). Only C makes the roots a real mic, and
   it reuses MAIN's hold-to-talk as is.
4. **My pick: B, built A-first.** A is a strict subset of B, so you can stop after A. C waits until MAIN's voice
   room can be warm from the list (details in the verdict). **You decide.** Below is the full case for each.

---

## 1. What the front page is today (sandbox build, 10-24)

Sources: `bifrost-sandbox/pwa/app/page.tsx`, `components/tree-door.tsx`, `components/ygg.tsx`,
`styles/brand.css`. Screenshot from a Pixel 7-class run (412 × 915 CSS px):

![today, four states](/api/artifact/mainframe-today.png)

| Piece | Where | What it shows |
|---|---|---|
| Header | `page.tsx:445` | `BIFROST` wordmark (opens settings) · artifact runestone + unseen badge · refresh |
| **The band** (top tree) | `page.tsx:474`, `.oz-band` | The tree cropped to trunk + low boughs (`BAND_VIEWBOX '150 430 1108 338'`), 88 px tall, 20 % opacity. The caption reads `all quiet` / `n working`. **State:** `working = sessions.filter(s => s.pending).length` counts every run, MAIN's and sub-sessions' included. While n > 0 the band walks: 4 traces take turns, 2 s each in an 8 s cycle, so **one thought at a time** (`brand.css:105`). |
| New session + search | `page.tsx:485` | 44 px keys |
| The list | `page.tsx:594` | Live runs float to the top, then unread, then by recency. State law: working = green breathing ●, unread = weight + ●, open question = ○. Sub-sessions nest under their parent. **`[MAIN]` is a row here** (locked, never swipe-deleted). |
| **The corner door** | `tree-door.tsx:706`, `.oz-door` | The **same drawing again**, uncropped, 60 × 60 px, fixed at bottom 14 / right 14. A plain `<Link>` to `/session/main`. A one-shot shrink from full screen plays after the door. |
| Undo toast | `page.tsx:733` | `fixed bottom-4`, full width |

What's wrong, measured on the phone:

- **The tree twice.** The band draws it, and the door draws it again, with no different job.
- **MAIN twice.** It's both a list row and the door.
- **The door carries no state.** MAIN working, MAIN answered, MAIN idle: the 60 px icon looks the same in all three.
- **No press feedback.** It's a plain link, so the door's own lesson ("press = amber at once") is broken on the
  one control that is literally a tree.
- **It covers content.** `pb-24` only clears the end of the list. While you scroll, the door sits on the time stamp
  and the end of the preview of every row it passes.
- **Reach and discoverability.** 60 × 60 in the corner is fine for a right thumb and a stretch for a left one. The
  icon has no visible word; "open MAIN" exists only as an aria-label.

What the MAIN page needs from the entry: its composer mic sits at the **bottom right** (`session/[slug]/page.tsx`,
`composer-mic`). A quick tap toggles hands-free; a hold talks (amber, ringing). The entry should keep that spot under
the thumb.

**Naming check.** Under the 10-22 ladder (`docs/brand/naming-ladder.md`), the **root is the tree's brain**. MAIN is
your direct line to the brain, so "the roots open MAIN" is canon, not decoration. The ladder makes **branch** =
bifrost, the app. The user's "branch = the work" is the plain-English sense: on screen the work is never *labelled*
"branch" (B names sessions, not branches), so the ladder stays intact. The 09-30 map ("roots = the network") would
make roots → MAIN read wrong. It's superseded on public copy, and this design depends on that staying true.

---

## 2. Shared by all three

- **The roots drawing (new).** The crown's trunk leaves the bottom edge (y 767) at x 540 · 602 · 704 · 806 · 867:
  four 45° flares plus the vertical bus. The roots carry on from those exits in the same direction, then spread in
  the crown's own vocabulary: 45° bends, horizontal runs, the same 20–28-unit trace widths. Same horizontal scale as
  the band, so on any width **the trunk leaves the band and enters the roots at the same x**. A vertical mask fades
  them into the ground, and the label sits on the fade. Geometry for `ygg.tsx` is in the mockup source (`ROOTS`,
  `RSIG`).
- **The roots bar.** Full width, edge to edge like the band. **84 px + `env(safe-area-inset-bottom)`**, so the
  target is 412 × 84 on a Pixel 7, about 10× the corner door's area (34 600 vs 3 600 px²). It sits in the easiest thumb zone for either
  hand. Contents: the drawing, then a `main` nameplate (a word, not just an icon), MAIN's last line, and `›`.
  The whole bar is one target.
- **The MAIN row leaves the list.** The roots *are* that row, promoted to the thumb. They read MAIN's `pending`,
  `preview`, `lastRole`, `lastHasQ` and unread state from the same `sessions` array: no new fetch, no new API.
- **States** (glyph + word for each, never color alone):

  | State | Roots | Word on the roots |
  |---|---|---|
  | idle | 20 % traces, still | MAIN's last line (dim) |
  | heard (finger down) | **amber this frame**, glow; signals run *down* to the root tips (the film's "words make the trip down to the root") | `heard` |
  | released | (navigates) | `opening main…` (the door's existing string) |
  | slid off / cancelled | back to idle, nothing happens | — (the door's release law: neutral, no guilt) |
  | working | **one thought walks the roots** (green) | `● main` breathing · `awaiting answer…` |
  | replied (unread) | the existing **wake** pulse climbs the taproot once ("the box answered"), then still | `● main` weight · first words of the reply · `○` if it asks |

- **One thought on the screen at a time.** If MAIN and a branch both work, the crown and the roots share one 8 s
  clock: crown at 0 s and 4 s, roots at 2 s and 6 s. The thought hops between the two ends of the tree and never
  shows twice. If only one end works, it gets all four slots (today's rhythm). This is CSS only (delays).
- **Reduced motion:** traces drawn whole instead of walking (the existing law). The word still differs per state.
- **The first time, after the door:** the one-shot shrink (`TF_SHRINK_KEY`) gets a new target. The full-screen
  tree *settles*: the crown rises into the band and the roots grow up from the bottom edge, 1.1 s, once. It
  teaches "MAIN lives in the roots" without a word.
- **Housekeeping all three need:** the toast moves above the roots (`bottom: roots + 8`); `pb-24` becomes the
  roots height; the press handlers go on a real `<Link>` (prefetch, a11y, middle-click), with
  `-webkit-touch-callout: none` and contextmenu prevented so a long press on iOS opens no link menu. Keyboard:
  Space/Enter press and release, like the door.

---

## 3. Proposal A · roots

> **The user's sketch, built clean: the crown stays the working light, the roots are the ground, and the ground is
> MAIN.**

![A · roots, four states](/api/artifact/mainframe-a-roots.png)

**Layout.** Header → band (**unchanged**: same crop, caption, walk) → new session / search → the list (MAIN no longer
in it) → **the roots**, fixed at the bottom. The band keeps its job (is my box working?). The roots get a new job
(MAIN, where I talk to the brain).

**Duplication.** One tree. The band is the top of the drawing (trunk + low boughs). The roots are its continuation
below the bottom edge. Neither repeats the other, and the corner door is deleted.

**Tap the roots → MAIN on a phone.**
- Target 412 × 84 px, full width, bottom: the largest and easiest target on the screen for either thumb. The
  bottom-right corner still opens MAIN, so muscle memory from the corner door carries over.
- Discoverable: the word `main` plus MAIN's own last line. It reads as a row, the drawing says "tree", and the
  first-run settle animation shows the tree going into it.
- Feedback: press = amber in the same frame (`classList.add('heard')` on pointerdown, no React round-trip, the same
  code as the door's `press()`), let go = `opening main…` and navigate. Slide off = nothing.

**The states and the walk.** As in the shared table. The band walks for branch runs and the roots walk for MAIN's
run, on the shared clock. An answer from MAIN climbs the taproot once.

**Cost: S.** About a day with tests. Files: `components/tree-door.tsx` (`TreeDoor` → `Roots`, press handlers, keeps
`data-testid="tree-door"` and `href="/session/main"` so most assertions hold), `components/ygg.tsx` (+ `ROOTS`,
`RSIG`, and the root viewBox), `app/page.tsx` (MAIN filtered out of `roots`, roots fed MAIN's row, toast offset,
padding), `styles/brand.css` (§ roots, shared-clock delays), e2e `tree-first.spec.ts` step 7 and
`door-repro.spec.ts` 4d (the `[MAIN]`-row assertion becomes "the roots carry MAIN").

**Risk: low.** It doesn't touch the mic or the voice path. Watch: pointer capture on an anchor must still let the
click through (test on Android Chrome and iOS Safari); the drift (light) theme's amber `#b9862e` on white must stay
legible on the nameplate (the mockup is aether only).

**First step.** Draw the roots into `ygg.tsx` and render them static at the bottom of the sandbox home. Compare
them with a phone-class screenshot at 360 / 412 / 430 widths in all three themes, before any state work.

---

## 4. Proposal B · one tree

> **The screen is the tree: the crown names the work on its boughs, the list hangs on the trunk, the roots are
> MAIN.**

![B · one tree, four states](/api/artifact/mainframe-b-one-tree.png)

**Layout.** A's layout plus three things:
1. **A taller crown.** 136 px (from 88), cropped to the boughs (`150 252 1108 364`) instead of the trunk: this is
   the "more of the branch" the user asked for.
2. **The work, named on its bough.** Each *working* session gets a bough. A tag sits at the bough's end (state
   glyph + title + sub count, e.g. `● v07 gate waves · 2 subs`), with a node and a leader line, and **only that
   bough walks**. At most 3 tags at fixed bough slots at least 44 px apart; a 4th or later folds into the caption
   (`5 working`). Tapping a tag opens that session. When nothing works the crown is a still drawing with
   `all quiet`: no tags, no motion. Unread and question states stay in the list, because the crown is the
   *working* light, not an inbox.
3. **The trunk.** A hairline down the left gutter, crown to roots. The rows hang off it. When MAIN answers, the wake
   pulse climbs the taproot and **carries on up the trunk to the crown**. The answer travels the whole tree, once.

Later, if wanted: on scroll the crown flattens into the 2 px **rail** pinned at the top (the rail is canonically
"the tree's signal, flattened to one trace"). The walk keeps going as the rail's glide, so the working light never
scrolls away.

**Duplication.** One tree, used at full height: crown (work) · trunk (the list) · roots (MAIN). Each part has one
job. The one overlap: a working session shows both as a crown tag and as its green row. The tag is the summary at
the top and the row is the index. Both use one glyph law.

**Tap the roots → MAIN.** Exactly as A. Crown tags are a secondary target: 24 px tall visually, with the hit area
padded to 40 px, kept apart by the fixed slots.

**The states and the walk.**
- idle: still crown, `all quiet` · roots idle.
- heard: roots amber, `heard` (the crown doesn't react: one press, one place).
- working: the named bough walks, the roots walk for MAIN, shared clock. If several sessions work, the crown's
  slots rotate across their boughs, still one thought at a time.
- replied: taproot → trunk → crown, one climb.

**Cost: M.** About 2–3 days on top of A. New: bough-slot geometry (3 anchor points per crop), tag layout + ellipsis
(18 ch), shared clock across crown and roots, the trunk hairline + climb, an e2e for "working session ⇒ tag on a
bough, tap opens it". Optional rail-on-scroll: half a day more.

**Risk: medium-low.** The crown costs 48 px of list (about ¾ of a row above the fold). Long titles and many runs need
the cap and fold rules above. Tags over a dense drawing need their own surface backing (the mockup does this). Still
no mic or voice change.

**First step.** A, exactly as above. Then the crown crop + one tag for the first working session. Look at it on the
phone before the trunk or the rail.

---

## 5. Proposal C · hold the roots

> **The roots are MAIN's mic: tap to open, hold to talk to MAIN without leaving the list.**

![C · hold the roots, four states](/api/artifact/mainframe-c-hold-the-roots.png)

**Layout.** A's layout. The roots' right end shows **MAIN's mic key**: the same 40 px square, in the same
bottom-right spot as MAIN's composer mic. The whole bar takes the hold, not only the key.

**Duplication.** As A (one tree). It adds one more meaning to the roots: they're also where you speak to the brain,
which matches the ladder (root = brain).

**Tap vs hold on a phone.**
- Press = amber at once and `heard`, the same for both (the sacred part, unchanged).
- Release within 0.3 s → **tap** → MAIN opens (as A).
- Hold past 0.3 s → **a talk**: level bars appear (the same delay idea as the PTT pill's ~350 ms, `ux-mictap`).
  Capture counts **from the press**, not from the 0.3 s mark, so the first word survives. Release = sent to MAIN.
- Slide off while talking → red `drop`, nothing sent (MAIN's existing PTT cancel).
- One hold phrase per surface (`tree-door.md`): the first time only, the nameplate reads `hold to talk to main`.
  After that, the mic glyph carries it.

**The states and the walk.**
- idle: as A, with the mic key.
- heard / listening: amber roots, signals running down, level bars, `heard`.
- working: on release, one pulse runs *down* the roots (your words go down to the root), then the walk while MAIN
  thinks. You stay in the list.
- replied: the answer is **spoken here**. The roots breathe green (the rail's `speaking` state) and the reply's
  words sit on them. Tap to open MAIN and read.

**Cost: L.** About 1–2 weeks with tests. Today the voice room lives and dies with the session page (disconnect on
unmount, `session/[slug]/page.tsx:899`). C needs MAIN's room and the PTT capture in a layout-level provider shared
by the composer and the roots, so there's one hold-to-talk implementation, not two. It also needs TTS playback on
the home page, and the first-turn gate (`FIRST_TURN_KEY`: only after STT is proven on this device). Mic permission
has to be already granted, because the list can't host the first-turn card.

**Risk: high.** It touches the sacred path. Onset clipping is a known failure ("Bifrost" heard as "Frost" when the
capture cue is late), and a cold room makes it worse. That means a warm room or a local pre-roll buffer. An
accidental hold sends a turn (mitigation: a hold has to start *on* the roots, and scrolls never start there because
of `touch-action: none`). A hot mic from the list is a privacy surface. Repeated room churn has hurt MAIN before
(5 dispatches in 3 s, the v0.7 repro).

**First step.** Don't start with UI. Prove the voice side first: on a phone-class repro, a warm MAIN room from the
home page, with press-to-first-word capture under 150 ms and no lost onset. Only if that's green, build A's roots
with the hold path on top.

---

## 6. Side by side

| | A · roots | B · one tree | C · hold the roots |
|---|---|---|---|
| Pitch | the sketch, clean | the screen is the tree | the roots are MAIN's mic |
| Trees on screen | one (crown + roots) | one (crown + trunk + roots) | one (crown + roots) |
| Top shows | the band, unchanged | the work, named on boughs | the band, unchanged |
| MAIN entry | 412 × 84, tap | 412 × 84, tap | 412 × 84, tap = open · hold = talk |
| Press | amber, same frame | amber, same frame | amber, same frame |
| Mic path touched | no | no | **yes** |
| Cost | **S** (~1 d) | **M** (~2–3 d on A) | **L** (~1–2 wk) |
| Risk | low | medium-low | high |
| First step | roots geometry, static, 3 widths × 3 themes | A, then crown + one tag | voice proof: warm room from home |

## 7. My verdict (you decide)

**I'd ship B, built A-first.**

- **A alone answers your note completely.** One tree, the bottom spot kept and made full width, MAIN with state, the
  press answered in amber. It's S cost and changes no gesture you know. If A on the phone already feels right, stop
  there.
- **B is what makes the front page say what it is**: crown = the work, trunk = the list, roots = the brain's line.
  The one-thought walk becomes one rule for the whole screen. It's the "more of the branch" from your sketch, and it
  still leaves the mic alone.
- **C is the most powerful and the wrong first move.** It puts the sacred hold in a second place before the voice
  stack can guarantee the first word from a cold start. It's additive to A or B, so it can come later as its own
  slice, with its own voice proof.

**If you pick:** A → I start with the roots geometry. B → A first, and the screenshots go to you before the crown
work. C → the voice proof first, with no UI until it's green.

**Defaults I'd take unless you say otherwise:** the MAIN row leaves the list (the roots are that row), and the band's
caption keeps counting MAIN's run in `n working` (it describes your box, not just the branches).

---

*Files: this doc · `artifacts/mainframe-proposals.html` (static, self-contained, aether tokens, real tree paths from
`ygg.tsx` + the new roots) · `artifacts/mainframe-{today,a-roots,b-one-tree,c-hold-the-roots,roots-close}.png`. No
product code was touched. Nothing was written in the sandbox or live trees, except removing two untracked scratch
scripts (`pwa/.mf-{snap,grid}.mjs`) that an earlier, dead run of this session left in the sandbox.*
