# Mission: mic-tap / hands-free UX hardening (phone-diag handoff)

Session: PHONE-DIAG (handing off) · req 10-02 · priority: user-blocking voice UX

## The complaint (user's words, verbatim)

> "I click on the microphone once, and I just see the animation of the push to
> talk, and only the push to talk works. Never see the full hands-free — or
> I'm doing something wrong, I'm not touching the right thing."

Environment: phone PWA, Chrome 153, Android, 360x780 (client 89274cfb in diag).

## What was actually broken — five layered causes, all diag-proven

The rebuild (cohesive-2, yesterday evening) did NOT change the voice logic.
The failure was a stack of small causes that together made "single click =
hands-free" impossible on a real phone:

1. **Duplicate-agent race (server side, agent/agent.py)** — a page refresh
   re-dispatches the LiveKit job while the previous one drains; the new job
   saw the old agent and self-terminated ("duplicate agent"), then the old
   one exited too → room agentless ~30s → every hold/tap failed
   "no voice agent in the room". Live evidence 08:48, room `review`.
   **FIXED (live):** new job now waits (≤20s, 250ms polls) for the draining
   previous agent to leave before proceeding; only a stubborn sibling shuts
   down as duplicate.

2. **Hands-free auto-restore on open** — oz-mode in localStorage silently
   re-armed hands-free on every session open/refresh. The user's first tap
   then hit the red "leave hands-free" exit (diag 08:54 + 09:11: every
   opening tap logged `leave hands-free`). The tap never failed to turn it
   on — it turned it OFF.
   **FIXED (live):** restore removed entirely; the preconnect effect resets
   `mode='text'` on every slug change (state survives route-instance reuse —
   navigating session→session inherited the mode, found at 09:09
   "no I did it again in a new session").

3. **250ms tap-vs-hold threshold vs human fingers** — the composer mic arms
   PTT after 250ms of press. Human thumb taps run 250-400ms, so EVERY tap
   the user made armed PTT (diag 09:16: their "single click" logged
   `hold — push to talk armed`; taps fired no click at all because the
   pointerdown preventDefault suppresses it — they were invisible in diag
   until instrumentation was added).
   **FIXED (live):** pttUp now measures the press from the PHYSICAL
   pointerdown (`pttDownAtRef`) — an armed press released <400ms is
   reinterpreted as a tap: buffered nothing discarded agent-side, mic
   released, hands-free toggled.

4. **The ghost click (the one the user kept feeling)** — toggling hands-free
   replaces the composer with the strip MID-GESTURE. The same lift's
   synthesized click lands on whatever now sits under the finger: the red
   "leave hands-free" exit. Diag 09:38:39-42, five taps in a row:
   `mic tap — toggle hands-free` followed 30-40ms later by
   `[tap] leave hands-free` — ON and instantly OFF, five times. The user
   saw a flash and "never hands-free".
   **FIXED (live):** `freeGhostGuardRef` — free-dock clicks within 400ms of
   the toggle are ignored (applies to exit + tap-to-send strip). e2e specs
   patched to wait 450ms before the exit click (they ARE fast ghost clicks).

5. **Invisible gestures** — mic taps and holds fired no click event, so the
   diag showed nothing for them. **FIXED (live):** `mic tap — toggle
   hands-free` / `hold — push to talk armed` / `released after Nms` now log
   to diag. THIS is how every cause above was pinned — do not remove.

## Current state

- All fixes live on lk-pwa + lk-agent (restarted 09:30-10:05 UTC).
- e2e: base + voice-ui + states 14/14 green (37s) after the spec patches.
- Files touched: `agent/agent.py` (entrypoint duplicate check),
  `pwa/app/session/[slug]/page.tsx` (restore removal, slug reset, tap
  reinterpret, ghost guard, gesture logging),
  `pwa/e2e/{base,voice-ui,states}.spec.ts` (450ms waits),
  `docs/claims.md` (PHONE-DIAG lines). Nothing committed yet.

## What the worker should do (UX pass — the user's remaining ask)

The mechanics now work; the user still says "or I'm not touching the right
thing". The hands-free state is real but SUBTLE: composer swaps for a strip
(equalizer bars + timer + small red ■) plus a one-line status sentence at
the bottom. On a 360px screen mid-conversation, that is easy to miss, and
a slow tap still flashes the PTT pill for ~150ms before flipping to the
strip (arm at 250ms, reinterpret at release).

1. Make hands-free unmistakable WITHOUT shouting: a visible mode word
   ("hands-free") on/near the strip (copy law: lowercase, see
   docs/brand/brand.md §3), consider tinting the phase line, keep one
   tone token (state law: amber = heard only).
2. Kill the PTT-pill flash on slow taps if cheap: raise the arm threshold
   to ~300ms OR delay the pill's visible state until 350ms — measure
   against the e2e hold (base.spec uses 450ms hold; keep it passing).
3. Verify tap ergonomics with REALISTIC timing: Playwright click() is
   ~0ms; add a spec (or extend voice-ui) that simulates a 300ms press
   (mouse.down, waitForTimeout(300), mouse.up) and asserts hands-free
   arms. This is the regression that ate the user for a day.
4. Optional: android-lab emulator pass (scripts/android-lab/) tapping the
   real composer mic with touch, screenshot the strip.

## Constraints

- Do NOT touch the five fixes above (list: refs `freeGhostGuardRef`,
  `pttDownAtRef`, slug-reset in the preconnect effect, pttUp <400ms
  branch, agent.py drain wait). They are diag-evidenced; reverting any
  re-breaks the phone.
- Keep req 09-30 semantics: tap toggles hands-free, hold is PTT, keyword
  "over"/"over and out" still works, exit stays reachable while listening.
- Verify: `cd pwa && npm run build` + `npx playwright test e2e/base.spec.ts
  e2e/voice-ui.spec.ts e2e/states.spec.ts` green before claiming done.
- Claim scope first in docs/claims.md (session name e.g. UX-MICTAP), delete
  the line when done. Commit small with req-linked messages is repo
  convention; user has not asked for a commit today — leave uncommitted.
- The user is ON the phone right now: after deploy, say what changed in
  one short paragraph, no jargon.
