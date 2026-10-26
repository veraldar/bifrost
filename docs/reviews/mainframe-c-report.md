# MAINFRAME-C — hold the roots, built

*Session MAINFRAME-C, 2026-10-26. Tree `~/Work/bifrost-sandbox` (lab/sandbox), served on :8090 → :8443, build
`PhQqRi2UDsb_2SuvmGSk5`. The live stack is untouched. This builds the user's pick: Proposal C from
`docs/reviews/mainframe-design-proposals.md` §5, with the upgrade where holding the roots talks to MAIN hands-free
without leaving the page.*

## Verdict in five lines

1. **Built.** The roots are the ground of the front page, and they are MAIN. There's one tree on the page: the band on
   top is the crown (the work), and the roots at the bottom are MAIN. The corner door and the `[MAIN]` row are gone.
2. **Tap = MAIN. Hold = talk to MAIN here.** Press turns the roots amber and shows "heard" in the same frame. A hold
   starts hands-free on the spot. Let go and the turn is sent. The reply is spoken on the list, and then the mic comes
   back (hands-free). "Over" sends the next turn. ■ or "over and out" ends it. Sliding off (or Esc) drops the turn.
3. **e2e: one spec per interaction, 12/12 green**, 4 of them with real voice through Chrome's own mic path. **MAIN
   unchanged:** MAIN's file only lost 4 helpers, moved verbatim (+1/−44 lines). MAIN's own specs are green, apart from
   two red ones that fail the same way on the pre-change build; the evidence is below.
4. **Speed**, measured as an interleaved A/B against the pre-change build: the list shows **40 ms sooner** and the way
   to MAIN **33 ms sooner**. First paint is +8 ms (noise), and the open pulls **+2.7 kB** of script.
5. **One pre-existing agent bug needs your call (F1).** When a page connects while an old agent job is still leaving,
   a second agent listens with auto turn-taking for up to 20 s and sends what it hears. MAIN already hits this. The
   roots' "talk here, then tap into MAIN" path will hit it more often. The fix is one line in the agent. I didn't apply
   it because it's outside the front page.

![the roots in the three worlds: idle · pressed · MAIN working · MAIN replied (412 px)](/api/artifact/mainframe-c-sheet-worlds.png)

![a real hold, step by step: talk · sent · spoken here · hands-free · drop · let go early](/api/artifact/mainframe-c-sheet-voice.png)

![the front page on the real list, and a tap in hands-free carrying into MAIN](/api/artifact/mainframe-c-sheet-pages.png)

## Try it (phone, :8443)

- **Tap** the roots to open MAIN, as the corner door did.
- **Hold** them. They go amber at once and say "heard". The first hold of a visit says *opening the mic — talk when the
  bars move*. Talk when the bars move (there's a small haptic tick on Android), then let go. You stay on the list. The
  roots go *sent · awaiting answer…*, then the reply plays and its words sit on the roots in green. After that the mic
  is back (*listening · say "over" to send*).
- **■** at the right end stops hands-free. "Over and out" stops it too, and that reply stays as text.
- **Slide up off the roots** while holding (or press Esc on a keyboard) and nothing is sent.
- **Settings → voice tests on:** the nameplate says `voice-test` in blue, and the roots talk to that room, never to
  MAIN.

## What I built, against your plan

| Your plan | Built | Where |
|---|---|---|
| 1 · the roots are the full-width ground, one tree only | 84 px + safe area, full width, the C geometry in brand tokens, all three worlds. The corner door (`TreeDoor`) is deleted. MAIN leaves the list, and its sub-sessions move up to the top level so nothing disappears. The band walks only for branches. MAIN's run walks the roots, on one shared 8 s clock (crown at 0 s and 4 s, roots at 2 s and 6 s). | `components/roots.tsx`, `components/ygg.tsx` (`YggRoots`), `app/page.tsx`, `styles/brand.css` § roots |
| 2 · tap = MAIN, same warmth | A press shorter than 0.3 s calls `router.push('/session/main')`. It's a real `<Link>`, so prefetch, middle-click and new-tab all still work. A tap mints no token and dispatches no agent (the test proves it). | `roots.tsx` |
| 3 · hold = hands-free with MAIN, without leaving; four states on the roots | Same room (= slug), same token route, same agent RPCs (`ptt_begin`, `commit_turn`, `ptt_abort` out; `free_state`, `end_free` back). Same TTS deck (`lib/speech`). Same heard and read marks, so MAIN never replays a reply already spoken here. States: **heard** (amber, bars), **working** (one green signal walks), **speaking** (roots breathe green, the reply's words on them), **idle** (MAIN's last line). Hands-free carries over: `oz-mode=free`, which is MAIN's own rule, so a tap opens MAIN hands-free. | `lib/roots-voice.ts` (lazy), `lib/voice-room.ts` (MAIN's primitives, shared) |
| 4 · voice-test toggle | With voice tests on, the roots use the `voice-test` room and its row. A tap lands in voice-test through MAIN's existing redirect. With voice tests off, the room is `main`; the test proves the room name without writing MAIN. | `roots.tsx`, `app/page.tsx` |
| 5 · keyboard | The roots are a focusable link with a visible focus ring. Enter = tap. Space held = hold-to-talk. A short Space = tap. Esc while holding = drop. ■ is reachable with Tab and works with Enter. A status region reads the voice states out. | `roots.tsx` |

**Refinements I made (please check them):**

- **The mic opens at the hold, not at the press.** That's why a tap costs nothing: no token, no agent dispatch, no
  extra agent job, just like today's door. The cost is that on a cold room (the first hold of a visit) capture comes
  up **0.8–1.2 s after the press**. Re-holds on a warm room take about 0.37 s. The roots never pretend: amber and
  "heard" come at once (the house law), and the suffix tells the truth (*opening the mic — talk when the bars move*).
  The bars and the tick start only once **both the mic and the agent** are live. Words said into an empty room were
  the "Frost" lesson.
- **Let go before the mic is live:** nothing was captured, and the roots say so. Hands-free stays on, so you just keep
  talking and say "over". That's your "keep talking" rule.
- **Drop** = as if you never held. If that hold is what turned hands-free on, the drop turns it off again. The abort
  reaches the agent *before* the mic device goes dark.
- **The one hold phrase**, *hold to talk · tap to open*, shows on a device's first 3 visits, or until its first hold.
  After that the roots show MAIN's own line.
- **The first voice turn still happens inside MAIN.** On a device that hasn't done it yet, a hold says *your first talk
  is inside main · let go to open it*. If the mic is blocked or unasked, the roots say that instead.
- **After the door, the roots grow up** from the bottom edge once (1.1 s), on the same one-shot key as the corner
  door's shrink.
- **Speed:** `livekit` and the voice cycle load lazily. They're never in the front page's first load. The voice chunk
  (4.5 kB gz) warms on idle, and only on devices that have done their first voice turn. `livekit` itself is the chunk
  MAIN's link already prefetches.

## One test line per interaction (all on :8090, build `PhQqRi2UDsb_2SuvmGSk5`)

`cd pwa && npx playwright test -c playwright.mainframe-c.config.ts`. The voice specs play a spoken wav as Chrome's mic
→ LiveKit → lk-agent-ygg → Qwen3-ASR → the brain. They use voice tests on, so MAIN is never written.

| # | Interaction | Spec | Result |
|---|---|---|---|
| 1 | one tree: band + roots only, no corner door, MAIN not a row, roots full width on the ground, last row clears them | `mainframe-c-roots` · one tree | ✓ |
| 2 | the hold phrase: first 3 visits, then MAIN's line; a hold retires it | `mainframe-c-roots` · the one hold phrase | ✓ |
| 3 | press = amber **inside the pointerdown dispatch** + "heard"; let go < 0.3 s → MAIN; **0 tokens minted** | `mainframe-c-roots` · press = amber | ✓ |
| 4 | slid off inside the tap window = nothing (no navigation, no mint) | `mainframe-c-roots` · slid off | ✓ |
| 5 | keyboard: Tab reaches the roots, Enter = MAIN, short Space = MAIN, Space doesn't scroll | `mainframe-c-roots` · keyboard | ✓ |
| 6 | first turn not done: a hold says so, let go opens MAIN's card | `mainframe-c-roots` · first voice turn | ✓ |
| 7 | voice tests **off**: a hold asks for room `main` (intercepted, so MAIN stays +0 and the mode is back to text) | `mainframe-c-roots` · voice tests OFF | ✓ |
| 8 | MAIN's state on the roots: working walks (the crown stays still); with a branch → computed `oz-turn` delays crown `0s, 4s` / roots `2s, 6s`; replied = ● + first words + taproot pulse | `mainframe-c-roots` · MAIN's state | ✓ |
| 9 | **hold → talk → let go = sent → transcript → reply spoken on the list → hands-free → tap = MAIN twin, still hands-free, no replay**; tokens only `voice-test`, MAIN +0, heard and read marks = the reply's time | `mainframe-c-voice` · hold → talk | ✓ cold mic+agent 1.1 s after press, transcript **82–479 ms** after release, reply speaking **4.3–5.4 s** after release |
| 10 | slide off while talking = red *drop* (slide back in = talk again) → let go = off, mode text, **no turn lands** in 8 s | `mainframe-c-voice` · slide off | ✓ |
| 11 | keyboard parity: Space held → talk → Esc = drop (nothing lands); Space held → let go = sent (lands); Tab → ■ → Enter = hands-free off | `mainframe-c-voice` · keyboard parity | ✓ |
| 12 | let go before the mic is live → *nothing captured yet*, hands-free stays → "what is three plus three? **over**." → agent keyword commit → spoken here → listening → ■ = off | `mainframe-c-over` | ✓ (the keyword never reaches the brain) |
| — | phone shots: 3 worlds × 360/412/430 × idle/pressed/working/replied | `mainframe-c-shots` | ✓ 9/9 |
| — | speed budget (cold phone-class open, below) | `mainframe-c-speed` | ✓ |

## MAIN unchanged: the evidence

- **The code:** `app/session/[slug]/page.tsx` changed by +1 import and −44 lines. `agentInRoom`, `withTimeout`,
  `releaseMicDevice` and `ECHO_TAIL_MS` moved verbatim into `lib/voice-room.ts` (commit `5f9d34b`). Nothing else in
  MAIN changed. The door lost only `TreeDoor` (the corner door). `Door` is untouched.
- **The door and the first turn** (`playwright.tree-first.config.ts`): **8/8**. That covers the door, the real
  hold-to-talk first turn in a MAIN-like session, and voice-wait. The door spec's step 7 now asserts the roots
  instead of the corner door.
- **ux-batch** (MAIN's voice): **6/7**. The echo gate (it uses the moved `ECHO_TAIL_MS`), PTT onset ("Bifrost"
  arrives whole) and the typed turns are green. The red one is `ux-batch-voicetest`, and it **fails identically on the
  pre-change build** (commit `43b10ce`, served from a temp worktree on :8097, same environment). Its "landed" check
  matches any older "two plus two" in voice-test, then reads the count before the new turn lands. Each run still adds
  exactly one turn (12 → 13 → 14 → 15).
- **The general suite** (15 files on :8090): **51 passed, 3 skipped, 1 failed**, followed by A/B runs:
  - `base` "home: sessions list" was a strict-mode race. `name: 'new session'` also matched three store rows titled
    "New session …", and the new page lands the list about 40 ms sooner. I fixed the test with `exact: true`: 3/3.
  - `base` "PTT … keeps the room warm" fails on **both** builds (old: 1 of 7 file runs, new: 3 of 9; 3/3 each in
    isolation). The cause is in LiveKit's log. MAIN's page mints two tokens per load (5 mints per `base.spec` run on
    both builds), and the second join with the same identity makes LiveKit "remove the duplicate participant", which
    closes the socket the test watches. That's pre-existing (F4).

## Speed budget

Interleaved A/B: 3 rounds × (5 cold runs of the old build, then 5 of the new). Pixel-class settings: 4× CPU, 4 Mbps,
100 ms RTT. Numbers are medians of the round medians.

| | before (`43b10ce`) | after | Δ |
|---|---|---|---|
| first contentful paint | 1388 ms | 1396 ms | +8 ms |
| DOMContentLoaded | 449 ms | 462 ms | +13 ms |
| **list on screen** | 1732 ms | **1692 ms** | **−40 ms** |
| **way to MAIN on screen** | 1741 ms | **1709 ms** | **−32 ms** |
| script pulled by the open | 137.4 kB | 140.1 kB | +2.7 kB |
| script incl. idle (Link prefetch + voice warm-up) | 530.3 kB | 540.2 kB | +9.8 kB |
| `/` First Load JS (next build) | 131 kB | 133 kB | +2 kB |

The page no longer draws the whole tree a second time (the corner door), so the list and the way to MAIN show sooner.
The roots' own logic adds 2.7 kB to the open.

## Findings: not changed, your call

- **F1 · agent: a second agent auto-sends speech for up to 20 s.** This is pre-existing, and MAIN hits it too. When a
  dispatch lands while the room's previous job is still leaving, the new job's session is already live on VAD with
  1.5 s endpointing. It waits up to 20 s for the old job to leave, because `agent.py` sets manual turns at line 528,
  *after* the duplicate wait at around lines 350–374. During that wait it turns speech into turns by itself.
  - Evidence: in the drop test, job `kKcBAE` logged `turn → opencode (mode=text)` at 19:17:37.765 while waiting.
    MAIN's own voicetest produced two identical turns 0.9 s apart (18:13:55.37 / 18:13:56.25).
  - Why it matters for the roots: talking on the roots and then tapping into MAIN is exactly that sequence. MAIN mints
    while the roots' job is still serving, so for up to 20 s a second agent can turn hands-free speech into extra
    turns.
  - **Fix (one line):** pass `turn_detection="manual"` to the `AgentSession(...)` constructor, or call
    `update_options` right after `session.start`.
  - The sandbox agent runs from `~/Work/lane2-merge/agent`. I didn't apply the fix, because it's outside the front page
    and changes MAIN's voice behavior. Say go and I'll ship it with a before/after.
- **F2 · MAIN's first-turn card still points at the corner tree.** The copy in `session/[slug]/page.tsx` (`FT.*.now[3]`)
  reads *"the tree, in the corner of your list — back to main"*. Proposed replacement: *"the roots, at the bottom of
  your list — back to main"* (fr: *"les racines, en bas de votre liste"*). I left it alone because of the MAIN
  constraint.
- **F3 · `e2e/door-repro.spec.ts`** is untracked, from another session. Its 4d check still waits for
  `data-testid="tree-door"` and will report red. It should point at `roots`.
- **F4 · MAIN mints two tokens per page load**, so LiveKit kicks a duplicate identity. That's the warm-room flake
  above. Pre-existing.
- **F5 · the agent's commit waits its full 8 s transcript timeout** when a hold ends about 1 s or more after the last
  word. The same turn took 8.05 s with a long silent tail and 82 ms with a short one. MAIN's PTT behaves the same way.
- **F6 · iOS:** the reply on the list plays through MAIN's own playback path, which has no explicit audio unlock.
  It's the same as MAIN's hands-free, and it's untested on iOS Safari.
- **By design, worth knowing:** hands-free outlives the front page (`oz-mode=free`, MAIN's rule). If you open any
  session from the list while hands-free is on, it opens hands-free.

## Not built

- **One hold-to-talk implementation for MAIN and the roots** (the proposal's layout-level provider). Doing it would
  mean refactoring MAIN's ~2,700-line voice state, which the constraint rules out. The roots run their own compact
  cycle (`lib/roots-voice.ts`) on MAIN's protocol and MAIN's moved primitives. Merging the two is a later slice, once
  MAIN may change.
- B's named crown tags (not asked).

## Files and commits (sandbox, `lab/sandbox`)

`5f9d34b` the voice primitives, shared (pure move) · `7c17c6b` the roots drawing · `6ca0bcf` the roots on the front
page (tap / hold / states / keyboard / gates) · `f00cd8f` e2e · `8d0adf0` the mic key's icon (CSS scope) · `6108a3a`
the shots spec and the `base` locator · `3b96d2d` the hint test · `74d63f2` the settled "sent" frame · and this report (with the real-list shot taken before the scroll check).

New files: `pwa/components/roots.tsx`, `pwa/lib/roots-voice.ts`, `pwa/lib/voice-room.ts`,
`pwa/e2e/mainframe-c-{roots,voice,over,shots,speed}.spec.ts`, `pwa/e2e/mainframe-c-lib.ts`,
`pwa/e2e/fixtures/roots-over-en.wav`, `pwa/playwright.mainframe-c.config.ts`.

Artifacts: `mainframe-c-sheet-{worlds,voice,pages}.png`, `mainframe-c-shot-*.png` (36),
`mainframe-c-speed-*.json`.
