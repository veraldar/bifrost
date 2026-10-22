# Film v1 report: the far vision on veraldar.org, and no more dead air

*Session FILM-V1, 2026-10-22. Built from the user's 10-22 feedback (second pass): two asks.*

**Where:** `~/Work/bifrost-sandbox` (branch `lab/sandbox`, served by `bifrost-sandbox`: :8090 locally,
:8443 on the tailnet) and `~/Work/veraldar-site` (**deployed to veraldar.org**). I didn't touch the live
stack (`lk-pwa`, `lk-agent`) or `docs/urd/`.

**Try it:** https://veraldar.org/#&film (the film), and https://veraldar.org/#&film=3 starts at chapter 3.

## 1 · The film on veraldar.org

**Before:** `#&film` opened the 15-second names film, behind a button in the "three names" section.
*The far vision* (the artifact the user loves) wasn't on the site at all.

**Now:** a **"the film"** section sits right under the hero, before anything else. Its poster is a still
from the film, drawn in the site's own colors. It shows three computers (desk, tv, workshop), each a tree
with its own root in green (the brain), one private line in sky blue joining them, and one phone's arcs
reaching each tree. On first sight one pulse runs the private line from desk to tv, once, then it's still
(the site's motion rule). Under it: one plain paragraph, the honest note (*"the replies are written ahead;
what is still being built is marked growing"*), and the **7 chapters as ways in**.

![the film section, staged](/api/artifact/film-v1-staged.png)

**The film** (`onboarding/far-vision.html`) grew from `artifacts/js-movie-far-vision.html`. It keeps the
same line drawings and the same story, retold in the door's names and spoken in the door's own recorded
voice:

| # | Chapter | What it shows |
|---|---|---|
| 1 | the way in | the workshop at dusk, hands busy, headphones on; the phone in the pocket is the way in; "hold the mic and speak. amber means you are heard." |
| 2 | the work | you hold the mic (amber, your words typed on screen); the desk computer reads the levels and drafts level two; "the work stays on your computer." |
| 3 | the trees | **every computer is its own tree, with its own root: its own brain, its own memory**; one private line joins them, only your devices on it; one app in your hand reaches them all, and that app is bifrost |
| 4 | the move | "put it on the tv": the tv takes the night level from the desk, down the private line, and nothing goes public. **Marked growing** (plan.md: "put it on the tv" is the v1.0 test) |
| 5 | the edge | "post it online": not from here, you publish by hand; **the one limit, said plainly**: a cloud brain sees what you send it, a brain at home keeps it all in; the machines serve, they never feel |
| 6 | the world | the trees host, the line carries, the app connects; that world is veraldar; the manifesto types itself, then the end card |
| 7 | your tree | "it starts with one tree. yours. hold it to begin." **Hold the tree, let go, and the site's door opens** (onboarding). Back from the door returns to the page. |

![the seven chapters](/api/artifact/film-v1-chapters.png)

How it plays: by itself (EN about 1 min 45, FR about 2 min 17, measured). Tap a chapter mark to jump,
▮▮ pauses. You can skip with ✕, the back button or Escape. A `#&film` link opens it even on a fresh load
(the browser wants one tap first). French follows the door's language. The 15-second names film moved to
`#&tree` (the door's "why these names?" and the names section's "watch it").

**Choices I made, and why:**
- **Root = the brain.** Door v3 teaches tree = your computer, root = the brain, trunk = the private line,
  branch = bifrost. The film follows that, so it never contradicts what the door just said. "Several roots
  on different hardware" means each tree has its own brain. *The 10-02 narration canon
  (`docs/brand/narration.md`, brand.md) still says "the roots = the private network". I flagged it and left it
  alone (brand docs need your call).*
- **A film, not a quiz.** The original needed a tap at every step. It also used the browser's robot voice
  and the browser's speech recognition, which sends your audio to a cloud service, against "the voice stays
  local". The site film plays by itself in the recorded voice. Your moments appear as hold-to-talk (amber)
  with your words typed. The original artifact is unchanged.
- **Plain words.** No "box", "tailnet", "federation" or "llm" (the e2e checks the staged section).
  Speakers are labeled `desk ›` and `tv ›`.
- **Honest.** "Growing" sits on everything not built yet (trees passing work to each other). The limit is
  spoken out loud, not hidden.
- **One file, both surfaces.** It's a built-in artifact like the tree film: `/api/artifact/far-vision.html` on
  the app, copied to the site by `scripts/onboard-voice-site.sh`.

## 2 · The loading gap: no dead air

**Root causes:**
- **Nothing showed while a line loaded.** The door's line appeared at once, but its sound came later with no
  sign anything was happening. Every surface had this.
- **The tree film fetched each beat's audio only when that beat began.** It ran in a sandboxed frame, which
  can't fetch the pack itself (no origin), so it played each line straight from its address with no
  preload. On a slow phone that meant a gap at every beat.
- **The brain step waited on the computer in silence**, and its line was never preloaded.
- **MAIN's first-turn lines** (heard / in / not heard / mic denied) were fetched cold, at the moment they
  were needed.
- **The site door** played every line from its address on demand.

**The signature, the same everywhere.** It's the app's own signal rail. Amber stays reserved for "you are
heard".
- **Loading**, from the step's first frame until the first audio frame: a signal glides along the rail.
  That's the app's *working* state, and the rail is the door panel's top edge. On the app's door a pulse also
  climbs the tree's trunk. In the films the line waits dim and a seed breathes where the tree grows from.
  After 0.7 s the words say so: *"the voice is on its way…"* / *"la voix arrive…"*.
- **Speaking** starts only on the audio element's own `playing` event, never a guess: the rail breathes
  green.
- **No sound at all:** *"no sound here — the words are on screen"*. Never a silent wait. A line that never
  comes (8 s) goes on in words.
- **Cached** (the normal case): the glide enters from off the rail and the words wait 0.7 s, so a line in
  memory (~20–70 ms) never flickers.

![no dead air: app door, app film, site door, site film — all mid-load](/api/artifact/film-v1-no-dead-air.png)

**Preloading, never faking ready:**
- Each line is fetched into memory ahead of its step and played from there, on both doors.
- The brain line is preloaded as soon as the computer answers. MAIN's lines are preloaded when its card
  comes up.
- The films ask their parent for their lines (`{voice:'need'}` → ack → the files themselves). The door
  already holds them, so the sandboxed frame fetches nothing. Standalone, a film fetches its own lines;
  failing that, it plays them from their address. The far vision stays one chapter ahead.
- Each beat's drawing starts **with** its voice, not before.
- The film frame shows the same rail under it until its first paint.

## Evidence

| What | Result |
|---|---|
| `voice-wait.spec.ts` (new, sandbox) | **3/3.** The pack is slowed 1.8 s. Step open → loading **0 ms** (same frame) → first audio **1656 ms**, never idle in between. A cached line plays first audio in **18 ms** and never shows the wait. The tree film: zero requests from the frame, each line fetched once (by the door), and the beat's drawing only arrives with its voice. The far vision is built in, its lines match the script, and every mp3 is served. |
| `tree-first.spec.ts` (door) | **4/4.** Greeting first audio **62 ms**, answer → spoken confirmation **15 ms** (the ~100 ms budget holds). |
| `first-turn-voice.spec.ts` (a real voice turn) | **1/1.** Transcript 1306 ms, spoken reply 9148 ms. |
| `site-door.spec.ts` on the working copy | **6/6** (+1 needs APP_URL). |
| `site-door.spec.ts` on **live veraldar.org** | **6/6**, plus site → app → back via :8443 **1/1**. Covers the far vision staged, playing, chapters, pause, back, a `#&film=7` link on a fresh load, and hold → door. Also no dead air: the pack slowed 3 s, then loading → the words → speaking. |
| Voice pack | 25 film lines × EN + FR = **50 renders**. Each was transcribed back by the referee; the lowest kept is 0.89 (`fv_host`, "tree's host"; `fv_world`, "Vereldar"). EN 72 s of speech, FR 103 s. |
| Film length, measured | EN **105 s**, FR **137 s** from the open to "your tree". |
| veraldar.org deploy | **54 files**, all sha-identical to `fd7807e` (then `far-vision.html` again at `96b44e4`). Backups: `index.pre-film1.bak.html`, `onboarding.pre-film1.bak/`. |
| Phone-class repro (Pixel UA, 4× CPU, 4 Mbps / 100 ms, cold, sandbox) | **All PASS.** Load 529 ms · tap → amber 16 ms · **greeting voice 35 ms** · door → MAIN 226 ms · transcript 2.8 s · spoken reply 13.1 s. Same as door v3 (523 / 20 / 33 / 230 / 2.8 s / 13.1 s): the budget holds. |
| General suite on the sandbox (`PW_BASE_URL=:8090`) | 32 passed / 10 failed / 2 skipped, **0 regressions from this diff**. The 9 failures door v3 recorded are back: the 6 yggdrasil-vs-opencode ones (`context:8`, `settings:32`, `subs:24/71`, `wedge:16/58`), the 2 that need their own config (`door-repro`, all PASS above; `stt-phone`), and `base:73`, the shared-load flake (passes alone, 36.5 s). **One new one, `base:6`:** a strict-mode clash. The sandbox's home list now has 3 sessions titled "New session…", so the test's "new session" button name matches 4 buttons. That's a data or selector issue on a page this diff doesn't touch. I left it for whoever owns that spec. |

## Commits

- **sandbox** (`git log --oneline 70a8537..`):
  - `ee0a77d` no dead air (app): the voice state, the door's rail, MAIN's card, the tree film
  - `52d6d7d` the site's no-dead-air test
  - `ca060dc` the far vision (film + 50 voice files + script + sync)
  - `7a4996d` chapter 6 layout (the licence line no longer sits on the phone)
- **veraldar-site**:
  - `c971fa8` no dead air (site door + film handoff)
  - `fd7807e` the far vision staged, `#&film`, its end opens the door
  - `96b44e4` chapter 6 layout (deployed, sha-identical)
- **Rollback (site):** restore `index.pre-film1.bak.html` → `index.html` and `onboarding.pre-film1.bak/` →
  `onboarding/` on the host.

## Test it on your phone (3 steps)

1. **veraldar.org → scroll once.** "the film" sits right under the tree. Tap the poster. The manifesto
   types itself, then the voice tells the story. Tap the 3rd chapter mark: three trees, green roots, the
   blue private line. Press back: you're on the page, where you were.
2. **Open https://veraldar.org/#&film=7**, tap play, then hold the tree and let go. The door opens.
   Back: the page.
3. **On a slow connection** (or the first time): hold the hero tree. The door's top edge glides green and
   after a moment says *"the voice is on its way…"*, until the voice plays and the edge breathes. On the
   app's door (:8443, a fresh device) the trunk pulses the same way. Tap "why these names?" → "watch it":
   each beat draws with its voice, never ahead of it.

## Assumptions and open items

- **Amber vs green for "loading".** The ask suggested an amber pulse. The brand reserves amber for "you are
  heard", so loading uses the *working* glide and speaking the green breathe, exactly as the site's legend
  already says. If you want amber, it's one CSS line per surface.
- **The brand canon's roots** (narration.md: roots = the network) disagree with door v3 (root = brain). The
  film follows door v3. The canon needs your call.
- **iPhone Safari** may want one tap inside a film before it speaks (the play button shows). The tree film
  already worked this way.
- The site's service worker caches voice files cache-first. If a film line is re-rendered under the same
  name, returning phones keep the old one until the cache version is bumped. The door's lines already
  behave this way.
- Built-in artifacts are served but not listed in the app's gallery. The far vision is at
  `/api/artifact/far-vision.html` on :8443.
- Not touched, noticed: the hero drawing on both surfaces has a `<path d="base">` (a console error, no
  visible effect).
- The sandbox's home list still shows 14 `e2e-*` sessions from earlier runs (4 h to 3 days old). This
  session deleted only its own 4.
