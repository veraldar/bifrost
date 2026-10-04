# SANDBOX REPORT — tree-first (2026-10-04)

Territory: `~/Work/bifrost-sandbox` (branch `lab/sandbox`), sandbox PWA on :8090
→ yggdrasil on 127.0.0.1:4100. Live bifrost (:8080, `~/Work/bifrost`) was not
touched: same pid (2935139) on :8080 before and after the run.

**Outcome: the frontend is wired and the whole flow passes end to end, with the
real brain**: fresh device → the tree alone → tap → onboarding session
(hands-free armed, the brain's greeting lands and is spoken) → completion → MAIN
→ home with the list and the corner door → MAIN has no delete anywhere in the
UI. Nothing is committed (AGENTS.md: no commits unless asked).

---

## 1. The previous run, reconstructed (it left no report)

Evidence: git (`48b56f9` brief, `0cab45e` follow-up brief), file mtimes, the
yggdrasil store, the :8090 process I found running.

| when (10-04) | what | evidence |
|---|---|---|
| 10:36 | brief committed; `SANDBOX-RUN.log` created, stayed **0 bytes** | `48b56f9`, mtime |
| 10:42–10:43 | `pwa/lib/tree-first.ts` (flags, MAIN_SLUG, onboarding prompt + marker parser, `mainPreamble`) and `pwa/app/api/onboard/route.ts` (start / done) written | mtimes, untracked |
| ~10:43–11:05 | MAIN guards in the session routes: `DELETE` → 403, rename of MAIN / to "main" → 409, `POST /api/session` named "main" → 409; `speech.ts` strips `[[bifrost:…]]` markers before TTS | uncommitted diff |
| 11:05 | production build (`BUILD_ID` 11:05) | `.next/BUILD_ID` |
| 11:07 | served on :8090 (`npm start`, detached); live-verified the route: created `[MAIN]` and `onboarding-mutlkikk` on yggdrasil. The brain greeted ("Hello, I'm Bifrost… say over. Should I sound like a woman or a man?"). MAIN's first preamble reads **`brain: undefined`**, so its `done` probe sent prefs without `brain` | yggdrasil store |
| 11:09 | `SANDBOX-RUN2.log` created at 0 bytes, then the run ended | mtime |

The run built the backend, then died (timeout, per `0cab45e`) before touching
`app/page.tsx` or `components/`. **I did not modify** its backend files
(`lib/tree-first.ts`, `api/onboard`, session routes, `speech.ts`). I reviewed
them and use them as they are.

## 2. Built this run (frontend)

| file | what |
|---|---|
| `pwa/components/tree-door.tsx` (new) | `FirstTree`: the whole ygg tree full screen, alone, with one invitation. A tap adds the existing `wake` state (one pulse climbs the trunk), POSTs `{step:'start'}`, and navigates once both the POST and ~1.2s of pulse are done. `TreeDoor`: the same drawing as a 60px corner link to `/session/main`. It consumes `TF_SHRINK_KEY` before paint and plays a FLIP shrink from full screen to the corner **once**. |
| `pwa/app/page.tsx` | per-device gate on `localStorage['tree-first-done']` (never on the server store). The page renders nothing until the client knows, so neither world flashes. First run: the tree only. Afterwards: the unchanged locked list plus `<TreeDoor/>` (`pb-24` so the last row scrolls clear of it). `startOnboarding` saves the current `oz-mode` once in `TF_PREV_MODE_KEY`, sets `oz-mode=free` (the existing hands-free path the session view restores on arrival), and POSTs `start`. `SwipeRow` gets `locked`: MAIN's row has no delete zone, no drag handlers, and opens on tap. While the brain hasn't answered, an onboarding row's preview shows `setup` instead of the hidden prompt. |
| `pwa/app/session/[slug]/page.tsx` | the onboarding prompt is filtered out of the transcript (total count adjusted). `[[bifrost:…]]` markers are stripped from displayed text. The closing marker is parsed from the raw poll (`parseOnboarded`, completed messages only). The hand-off waits until the closing line has been said: speech idle, hands-free cycle back on `listening`, not busy. Delays: 1.5s after it was heard, 4s in keyboard mode, 15s fallback if TTS never played it. Then `POST {step:'done', from, prefs}` → `exitFree()` + room disconnect → `oz-mode` restored from `TF_PREV_MODE_KEY`, prefs saved in `bifrost-onboard`, `tree-first-done` set, shrink one-shot armed → `router.replace('/session/main?id=…')`. The empty-transcript hint in onboarding reads "setup — your box speaks first, then you answer by voice". |
| `pwa/app/session/[slug]/settings/page.tsx` | for MAIN: no delete block, and the name field is read-only ("MAIN keeps its name — the tree door finds it by it"). This matches the 403/409 guards. |
| `pwa/styles/brand.css` | one new block, `tree-first`, next to the tree rules: `.oz-first`, `.oz-invite`, `.oz-door`, and the shrink keyframes. Tokens only. The existing reduced-motion rule (`.oz *`) also stills the shrink and pulse. Nothing existing changed. |
| `pwa/e2e/tree-first.spec.ts` + `pwa/playwright.tree-first.config.ts` (new); `pwa/playwright.config.ts` | the spec runs against :8090 only, in a forced 360×780 phone shape (the main config's Desktop Chrome project overrides its viewport to 1280×720). It is excluded from the main suite via `testIgnore`, because that suite targets live :8080, which doesn't have the flow. |

### Judgment calls
- **Hands-free scope = the setup session.** The invitation follows the brand's
  consent copy law ("grants mic access · hands-free · this session"). So when
  setup ends, the mic leaves and MAIN opens in whatever mode the device had
  before (that is what the previous run's `TF_PREV_MODE_KEY` was for). The
  alternative is to carry hands-free into MAIN, HER-style. That is a one-line
  change if preferred.
- **Prefs:** parsed from the brain's marker (`voice`, `style`, `brain`), sent
  with `done`, and kept in `localStorage['bifrost-onboard']`. **Not applied to
  TTS:** there is no client-side voice selector (the voice is server env
  `TTS_VOICE_*`), so "woman/man" only reaches MAIN's preamble.
- The band (the existing tree crop) is left alone. The corner door is the one
  visual addition. It sits fixed bottom-right of the screen, above rows, below
  the undo toast.

## 3. Verification

- `npm run build`: **green** (final build after the last CSS change). `tsc
  --noEmit`: clean, except one pre-existing error in `e2e/artifacts.spec.ts`
  that this work doesn't touch.
- `npx playwright test -c playwright.tree-first.config.ts` against :8090: **1/1
  passed, 17.8s, real brain.** The spec asserts:
  1. Fresh context → `tree-first` visible, no rows, no header, no door
     (screenshot 1).
  2. Tap → `wake` class → URL `/session/onboarding-…`, `oz-mode=free`,
     `free-phase` present (the testid the live suite reads), an `(agent)`
     greeting in the transcript, prompt text and `(you)` absent (screenshot 2).
     In the shot the phone is **speaking** the greeting, mic paused.
  3. The closing marker is injected into the messages poll. This is the only
     simulated step: a voice round-trip can't run headless. The closing line
     renders without the marker, and the page itself POSTs `done` with
     `{from: slug, prefs: {woman, short, local}}` → 200 → URL `/session/main`,
     `tree-first-done` set, `oz-mode` back to `text`, prev-mode cleared,
     shrink armed.
  4. Home: door has `.shrink` (screenshot 3a, mid-zoom), then settles. No
     first-run tree, BIFROST header, one `[MAIN]` row, door `href=/session/main`
     (screenshot 3).
  5. MAIN row: `data-locked`, no `.oz-zone` (other rows have one); a 12-step
     left mouse drag produces no undo toast and the row stays.
     `DELETE /api/session/main` → **403**. `/session/main/settings` has no
     delete button, and the name field is read-only.
  6. Door click → `/session/main` (screenshot 4). A reload of home does not
     replay the shrink. A second open skips the first run.
  The test then deletes its own onboarding session.

Screenshots (sandbox `artifacts/`, phone shape 360×780):

![1 · first open: the tree alone, one invitation](/api/artifact/tree-first-1-first-open.png)
![2 · onboarding: brain greeting in the transcript, spoken hands-free](/api/artifact/tree-first-2-onboarding.png)
![3a · the one-time shrink, mid-zoom](/api/artifact/tree-first-3a-shrinking.png)
![3 · afterwards: locked list + MAIN row + corner door](/api/artifact/tree-first-3-corner-door.png)
![4 · the door opened MAIN](/api/artifact/tree-first-4-main.png)
![blocker evidence · onboarding while the brain's upstream returned 529](/api/artifact/tree-first-2-onboarding-brain-down.png)

## 4. Blocker episode (cleared during the run)

Runs 1–2 failed at the greeting. yggdrasil's upstream answered the onboarding
prompt with **`529 overloaded_error` (code 1305)**, and the proxy logged `async
prompt failed … opencode 500`. Yggdrasil stored an assistant message with empty
text, which the proxy drops, so the session stayed empty. That counted as
blocked twice, so I stopped retrying the brain. I verified everything after the
greeting with an explicit, labelled `TF_BRAIN_DOWN=1` switch in the spec, which
records the honest empty state instead of the greeting. Minutes later MAIN's
latest preamble got a reply ("Done."), which was fresh evidence the upstream had
recovered. One real run then passed (above).

Unrelated fix along the way: the sandbox `.env.local` lacked the live server's
`IS_VERCEL_PREVIEW=true`. `/api/token` has a production guard, so the token
route threw 500 and voice couldn't connect on :8090.

## 5. Not done / known gaps (follow-ups)

1. **Brain failure on the first turn strands the user** (seen live twice today).
   If the onboarding prompt's run errors before the page arrives, `busy` is
   never armed, and the run-events `error|…` only surfaces while busy. The
   setup screen then sits on "your box speaks first" forever, with the mic hot.
   Fix sketch (frontend): in an onboarding session with a settled run, no
   assistant text, and a good poll, show "your box did not answer — tap to ask
   again", and re-send `ONBOARDING_PROMPT` through the normal messages POST
   (it stays hidden by the same filter).
2. **Backend (out of this scope):** `mainPreamble` trusts `body.prefs` as is. A
   `done` without `brain` writes `brain: undefined` into MAIN, which is how the
   previous run's probe produced it. The route should normalise prefs. My
   client always sends parsed, defaulted prefs.
3. Abandoned onboarding: going back home before the end and tapping again
   starts a **new** onboarding session. The old one stays in the store and
   appears in the list afterwards. Resuming a stored in-flight slug would avoid
   that.
4. The door assumes MAIN exists. If the store loses MAIN while the device flag
   stays set, the door opens an empty `/session/main` and sends 404. A possible
   fallback: if a good list load has no MAIN row, re-offer the first run.
5. Voice round-trip (STT → "over" → brain → marker) is not asserted headless,
   only the hands-free path engaging, the greeting being spoken, and everything
   from the marker onward. It needs a human pass on the phone against :8090.
6. Not done: `docs/claims.md` (the sandbox is its own territory per the
   brief), the full live e2e suite (it targets frozen :8080).

## 6. Side effects

- **Sandbox `pwa/.env.local`** (gitignored): appended the live server's
  non-secret voice/speech parity keys `IS_VERCEL_PREVIEW`, `AGENT_NAME`,
  `SPEACHES_URL`, `TTS_*`, copied from `~/Work/bifrost/pwa/.env.local`, which
  was only read. The pre-change copy is at `/tmp/tf/env.local.bak`.
- **:8090** restarted on my build: `PORT=8090 npm start`, detached, log at
  `/tmp/tf/serve-8090.log`. It replaced the previous run's 11:07 server.
- **yggdrasil store:** each passing spec run seeds MAIN once (by design, once
  per onboarding slug). MAIN now holds 5 preamble messages: 1 from the previous
  run (`brain: undefined`) and 4 from my runs. My onboarding sessions were all
  deleted, and no phantom sessions were left. `onboarding-mutlkikk` (previous
  run) was left in place.
- `pwa/package.json` version is bumped by `prebuild` (`sync-version.sh`) on
  every build: now `0.5.0-17-g0cab45e`.
