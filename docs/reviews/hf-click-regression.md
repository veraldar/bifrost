# HF-CLICK — hands-free single-tap regression (req 10-27)

Session HF-CLICK · Claude Code (Opus 5.5) via `scripts/agi-run.sh` · 2026-10-27
Brief: `briefs/hf-click-regression.md`

**Verdict: root-caused, fixed, and RED→GREEN on the sim stack.** One quick tap on
the mic now turns hands-free on, and it stays on. The fix is **in the working tree
of `~/Work/bifrost-sandbox` (branch `lab/sandbox`), uncommitted and not deployed.**
The phone gets it only after a rebuild and a `bifrost-sandbox.service` restart. I did neither.

> **Deviation from the brief, stated up front.** The brief said to work in
> `~/Work/bifrost` (current checkout `rebuild/cohesive-opus`). The bug is not in that
> checkout: it has all three 10-02 guards, and so does live `:8080` (v0.6.1). The user hit
> it on the **sandbox stack** (`:8090` → `:8443`, served from `~/Work/bifrost-sandbox`,
> `lab/sandbox` @ `bb6e265`). The fix therefore went into that tree, in the same
> files the brief lists (`pwa/app/session/[slug]/page.tsx`, `pwa/e2e/**`). Nothing
> in `~/Work/bifrost` changed except this report.

## 1 · Symptom — what the user saw, and what the box logged

User: *"single click on the microphone in a session — I see the mic opening, but it
closes very quickly, and hands-free never starts."*

The sandbox diag (`~/Work/bifrost-sandbox/pwa/.diag/diag-2026-10-27.log`, UTC) has
**13 mic taps today. Every one is logged as a click on `leave hands-free`, followed
1–15 ms later by `keyboard mode — mic device released`.** That is 1 in MAIN at 06:22:42
and 12 in `test-audio` between 06:45:05 and 06:48:15. **None** is logged as a click on
`push to talk`. In other words, the click from the user's own tap never reached the mic.
It landed on the exit button.

```
06:45:05.495Z [tap]   (/session/test-audio) leave hands-free
06:45:05.500Z [voice] (/session/test-audio) keyboard mode — mic device released, room stays warm
06:45:06.880Z [tap]   (/session/test-audio) leave hands-free
06:45:06.888Z [voice] (/session/test-audio) keyboard mode — mic device released, room stays warm
… ×13
```

For contrast, the same gesture on live v0.6.1 (`pwa/.diag/diag-2026-10-27.log`, 06:55, a
`test-audio` session) logs `mic tap — toggle hands-free`. The ghost `leave hands-free` click
follows 13 ms later and is swallowed. Hands-free then holds (wake lock acquired) until the
user's real exit 4.7 s later. Live has the guard; the sandbox does not.

The served sandbox build at the time was `7hZPgUoyL7aulHsm_jus9` (built 07:27 CET from `bb6e265`,
unit up since 07:30 CET), so the user's taps hit exactly that code.

## 2 · Root cause

Two of the three 10-02 mic fixes **never existed on `lab/sandbox`**:

1. **Ghost click (the user's symptom).** A tap → `micTap` → `switchMode('free')` swaps the
   composer for the free dock. The dock's `leave hands-free` square sits exactly where
   the mic was ("the exit is always where the entry was"). On a touch screen, the
   browser synthesizes the tap's click **after** the lift, and hit-tests it against the
   new DOM. So the click lands on the exit and `toggleHandsFree()` leaves hands-free
   6 ms later. Hands-free never paints a frame. The mic device was being opened by the
   entry and is released by the exit: that is "the mic opens, closes very quickly". There
   is no `freeGhostGuardRef` on this branch.
2. **Tap-arm race.** PTT arms at 250 ms and a human tap runs 250–400 ms, so a slower tap
   armed PTT (the pill shows, the mic opens), and the release committed a PTT turn instead
   of toggling. There is no `pttDownAtRef` and no `<400 ms` reinterpret in `pttUp`. This is
   the second way a "single click" opens the mic and never starts hands-free.

### Offending commit — a branch-point gap, not a removal

No commit removed these guards. They were never on the branch:

- The 10-02 fixes were made in the `~/Work/bifrost` working tree and stayed **uncommitted**
  until the nightly sweep `6405ead` ("run 20261004T081621Z: published", 2026-10-04 10:16 +0200)
  carried them into git (`git log --all -S freeGhostGuardRef` → only `6405ead`).
- `lab/sandbox` was cut from the last committed point, **`ab00e73`** (2026-10-01 23:35). Its
  first own commit is `ce40a1a` (2026-10-04 11:33).
- `git log lab/sandbox -S freeGhostGuardRef` and `-S pttDownAtRef` are both **empty**.

The user experiences it as a regression because their daily path moved from live
v0.6.x (which has the fixes) to the sandbox v0.7 stack (which never had them).

### The brief's hypotheses, tested

| # | hypothesis | result |
|---|---|---|
| 1 | mainframe-c "roots" (`6ca0bcf`/`bb6e265`) reset or re-armed the guards | **falsified**: neither commit touches `page.tsx` (`roots.tsx`, `roots-voice.ts`, `app/page.tsx`, `tree-door.tsx`, `brand.css` only). The roots' hold is a separate handler on the front page. |
| 2 | the pill-delay refactor narrowed the `<400 ms` window | **falsified**: `setHoldPill` and the reinterpret never existed on `lab/sandbox`. |
| 3 | the ghost guard expired early or was never set | **closest**: never set, because it never existed on this branch. |

Across all 12 `lab/sandbox` commits that touch `page.tsx` since the fork, none adds or removes any of the guard symbols.

## 3 · The fix

`pwa/app/session/[slug]/page.tsx` (+71 −13). The 10-02 guards are ported from
`rebuild/cohesive-opus`, adapted to this branch:

- `pttDownAtRef` is stamped at the physical press (`onPointerDown`). `pttUp` treats a press released
  under 400 ms as a **tap**: it aborts the 0–150 ms PTT capture agent-side (`ptt_abort`),
  releases the device, and toggles. The sandbox has no pill delay, so this uses `setHolding(false)`
  instead of `setHoldPill(false)`.
- `freeGhostGuardRef` is set to `now + 400 ms` on every tap toggle. The free dock's
  `leave hands-free` and `send what you said` clicks inside that window are swallowed.
- `micTap` logs `mic tap — toggle hands-free` again, so the next "the tap did nothing" report
  is readable in the diag. On this branch it was invisible.
- New `pressTap()` is the one tap path, shared by the pre-arm tap and the `<400 ms`
  reinterpret. It keeps the sandbox's **first-turn rule** (a tap during the door's first
  turn says "released, nothing sent" and never switches modes), so a slow tap there doesn't
  bypass it through the reinterpret.

Spec side, ported verbatim from main's 10-02 change: `e2e/voice-ui.spec.ts` (now
byte-identical to main's) and `e2e/base.spec.ts` (×2) wait 450 ms before clicking the exit.
A bot clicking the exit within 400 ms of entering *is* the ghost by definition. These
two tests went red under the fix until they waited, which is the same thing main hit on 10-02.

<details><summary>page.tsx diff</summary>

```diff
diff --git i/pwa/app/session/[slug]/page.tsx w/pwa/app/session/[slug]/page.tsx
index 56a84e1..80d6926 100644
--- i/pwa/app/session/[slug]/page.tsx
+++ w/pwa/app/session/[slug]/page.tsx
@@ -1234,6 +1234,18 @@ export default function SessionView({
   // toggling can't churn the publisher transport (rapid enable/disable
   // killed ICE in the live room 2026-09-30) and a tap can't buffer audio.
   const holdArmRef = useRef<ReturnType<typeof setTimeout> | null>(null);
+  // when the current press began — classifies a press that armed PTT but
+  // released fast (see the <400ms reinterpret in pttUp)
+  const pttDownAtRef = useRef(0);
+  // entering hands-free replaces the composer with the strip MID-GESTURE: the
+  // same lift's synthesized click lands on whatever now sits under the finger
+  // — the 'leave hands-free' exit — and instantly un-toggles (diag 10-02
+  // 09:38: five mic taps, each followed 30-40ms by a 'leave hands-free'
+  // click; the user saw a flash and 'never hands-free'). Free-dock clicks
+  // within 400ms of the toggle are that ghost, not a user. (HF-CLICK 10-27:
+  // this branch forked before that fix — every tap logged only 'leave
+  // hands-free' again; e2e/hf-quick-tap.spec.ts taps with a real touch.)
+  const freeGhostGuardRef = useRef(0);
   function clearHoldArm() {
     if (holdArmRef.current) {
       clearTimeout(holdArmRef.current);
@@ -1267,6 +1279,33 @@ export default function SessionView({
     // invocation just reconnected — the reconnect storm of 2026-09-25
     if (!pttWantRef.current) return;
     const discard = forceDiscard ?? pttCancelArmRef.current;
+    // HUMAN taps run 250-400ms — slower than the 250ms PTT arm, so every
+    // 'single click' armed PTT and hands-free never toggled (diag 10-02
+    // 09:16: the user's tap logged 'hold — push to talk armed'; their words:
+    // 'I can push the talk, but nothing happened if I single click'). A press
+    // that armed PTT but released this fast held ~0-150ms of room tone, not
+    // speech: abort that nothing agent-side and treat the gesture as what it
+    // was — a tap (req 09-30 tap-toggle, restored for slow human fingers).
+    const heldMs = Date.now() - pttDownAtRef.current;
+    if (!discard && heldMs < 400) {
+      pttWantRef.current = false;
+      pttCancelArmRef.current = false;
+      setPttCancelArm(false);
+      setHolding(false);
+      const room = roomRef.current;
+      if (room) {
+        pttDiscardRpc(); // the buffered 0-150ms is noise — die agent-side
+        try {
+          if (modeRef.current !== 'free') await mic(false); // hands-free keeps listening
+        } catch {
+          /* release below still applies */
+        }
+        if (modeRef.current !== 'free') releaseMicDevice(room);
+      }
+      diagEvent('ptt', `released after ${heldMs}ms — short press = tap`);
+      pressTap();
+      return;
+    }
     pttWantRef.current = false;
     pttCancelArmRef.current = false;
     setPttCancelArm(false);
@@ -1969,9 +2008,28 @@ export default function SessionView({
    *  pure tap — toggle hands-free. No mic was touched, nothing to discard. */
   function micTap() {
     clearHoldArm();
+    // mic taps fire no click (pointerdown preventDefault) — invisible in the
+    // tap diag. Log the gesture so a 'the tap did nothing' report is readable
+    // in the log (2026-10-02 hands-free hunt)
+    diagEvent('voice', 'mic tap — toggle hands-free');
+    freeGhostGuardRef.current = Date.now() + 400;
     toggleHandsFree();
   }
 
+  /** a press that was a TAP — released before the arm, or armed and let go
+   *  under 400ms (see pttUp): the hands-free toggle. On the first turn a tap
+   *  is not a turn, and hands-free ("over") is taught after — say what
+   *  happened instead of switching modes. */
+  function pressTap() {
+    if (first === 'practice' || first === 'sent' || first === 'mic') {
+      clearHoldArm();
+      setFirstHint(FT[firstLang].released);
+      diagEvent('ptt', 'first-turn: tap — released, nothing sent');
+      return;
+    }
+    micTap();
+  }
+
   /** Tap the live equalizer to commit the turn — the tap equivalent of
    *  saying "over" (both stay: keyword OR tap, req 09-30). Reuses pttUp's
    *  free-mode commit path minus the hold-specific state. */
@@ -2045,6 +2103,9 @@ export default function SessionView({
       clearHoldArm();
       pttStartRef.current = { x: e.clientX, y: e.clientY };
       pressAtRef.current = performance.now();
+      // physical press start — the <400ms tap reinterpret in pttUp measures
+      // from HERE, not from pttDown (which runs 250ms later, at arm time)
+      pttDownAtRef.current = Date.now();
       // PTT arms at 250ms — a shorter press is a tap (see micTap)
       holdArmRef.current = setTimeout(() => {
         holdArmRef.current = null;
@@ -2054,17 +2115,8 @@ export default function SessionView({
     onPointerUp: () => {
       unlockLines(); // a release is a gesture: the first-turn lines may play later
       // tap = the arm timer never fired → no PTT state exists at all
-      if (holdArmRef.current) {
-        if (first === 'practice' || first === 'sent' || first === 'mic') {
-          // first turn: a tap is not a turn, and hands-free ("over") is
-          // taught after — say what happened instead of switching modes
-          clearHoldArm();
-          setFirstHint(FT[firstLang].released);
-          diagEvent('ptt', 'first-turn: tap — released, nothing sent');
-          return;
-        }
-        micTap();
-      } else void pttUp();
+      if (holdArmRef.current) pressTap();
+      else void pttUp();
     },
     onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
       if (!holding) return;
@@ -2562,7 +2614,10 @@ export default function SessionView({
           <button
             data-testid="free-strip"
             aria-label="send what you said"
-            onClick={() => void commitFreeTurn()}
+            onClick={() => {
+              if (Date.now() < freeGhostGuardRef.current) return; // gesture ghost — see freeGhostGuardRef
+              void commitFreeTurn();
+            }}
             className={`oz-pill strip ${
               voiceState === 'ready' && freeCycle === 'listening' ? '' : 'wait'
             }`}
@@ -2590,7 +2645,10 @@ export default function SessionView({
             <button
               data-testid="free-exit"
               aria-label="leave hands-free"
-              onClick={toggleHandsFree}
+              onClick={() => {
+                if (Date.now() < freeGhostGuardRef.current) return; // gesture ghost — see freeGhostGuardRef
+                toggleHandsFree();
+              }}
               className="oz-k red"
             >
               <StopSquare size={12} />
```
</details>

<details><summary>spec diffs (base + voice-ui)</summary>

```diff
diff --git i/pwa/e2e/base.spec.ts w/pwa/e2e/base.spec.ts
index 24e88d0..8e40eed 100644
--- i/pwa/e2e/base.spec.ts
+++ w/pwa/e2e/base.spec.ts
@@ -99,8 +99,10 @@ test('voice: PTT connects to LiveKit, keyboard mode keeps the room warm', async
   // a hold shorter than that join dropped the whole turn (req 09-29). The
   // LiveKit socket must therefore STAY open after the switch. The only mode
   // switch is the composer mic (req 09-30): a TAP toggles hands-free —
-  // text → hands-free → text, the button never moves.
+  // text → hands-free → text, the button never moves. Wait out the free-dock
+  // ghost guard (400ms) before the exit tap — see freeGhostGuardRef.
   await micBtn.click();
+  await page.waitForTimeout(450);
   await page.getByRole('button', { name: 'leave hands-free' }).click();
   await expect
     .poll(() => sockets.filter((s) => s.isClosed()).length, {
@@ -117,6 +119,8 @@ test('hands-free mode arms without error', async ({ page }) => {
   await expect(page.getByText(/hands-free/).first()).toBeVisible({
     timeout: 30_000,
   });
+  // wait out the free-dock ghost guard (400ms) — see freeGhostGuardRef
+  await page.waitForTimeout(450);
   await page.getByRole('button', { name: 'leave hands-free' }).click();
   await expect(page.getByTestId('free-phase')).toHaveCount(0);
 });
diff --git i/pwa/e2e/voice-ui.spec.ts w/pwa/e2e/voice-ui.spec.ts
index a11b01d..d4c8576 100644
--- i/pwa/e2e/voice-ui.spec.ts
+++ w/pwa/e2e/voice-ui.spec.ts
@@ -47,6 +47,10 @@ test('rail, glyph and words follow every voice state', async ({ page }) => {
   await expect(rail).toHaveAttribute('data-s', 'heard');
   await expect(free).toContainText('tap the bars to send');
   await expect(page.getByRole('button', { name: 'send what you said' })).toBeEnabled();
+  // the exit click must be a real gesture: within 400ms of the entering tap
+  // it IS the gesture's ghost and the free-dock guard swallows it (see
+  // freeGhostGuardRef) — wait out the window like a human finger would
+  await page.waitForTimeout(450);
   await page.getByRole('button', { name: 'leave hands-free' }).click();
   await expect(free).toHaveCount(0);
   await expect(rail).toHaveAttribute('data-s', 'idle');
```
</details>

## 4 · The regression lock — `pwa/e2e/hf-quick-tap.spec.ts`

**Why no spec caught it:** every existing hands-free spec enters with `mic.click()`.
That is a *mouse* click, and Chrome sends it to the pressed element, so the ghost never
exists in e2e. This is the sim gap the user named. The new spec taps like a thumb:
CDP `Input.dispatchTouchEvent` touchStart → a beat → touchEnd on a `hasTouch`/`isMobile`
page. Chrome synthesizes the click from the tap itself, hit-tested after the dock swaps, as a phone does.

Each test films every frame (is the free dock up, is the PTT pill up) and stamps every
pointer and click event with the button it landed on. It then asserts:
- the press really was this press (`pointerdown` on `push to talk`, down→up under the limit)
- hands-free came up **once** and never went away (filmed, so a ghost exit followed by re-entry fails too)
- it held **≥ 2 s**
- **no turn was sent** (session `x-total-count` unchanged)
- quick click only: the PTT pill never appeared, so nothing armed
- afterwards a real touch on `leave hands-free` still leaves, so the guard isn't over-broad

Two presses: **quick click, 90 ms** (the user's gesture, under 150 ms) and **slow human tap,
300 ms** (past the 250 ms arm, under 400 ms: the 09:16 race).

## 5 · RED → GREEN evidence

Rig: a scratch worktree `~/Work/hf-click-sandbox` (detached `bb6e265`, `node_modules`
symlinked) was built and served by `scripts/sim-stack.sh` (sim-pwa `:8096` → sim-ygg `:4111` →
mock LLM, voice dispatch to `sim-none`). This lane runs inside `lk-yggdrasil`'s hardening, so
the build used the no-JIT recipe (`node --jitless` plus the wasm shim), and so did Playwright (`PW_JITLESS=1`).
I did **not** build inside `~/Work/bifrost-sandbox`: replacing `.next` under the running
`:8090` unit would have broken the user's phone session.

**RED — unfixed `bb6e265` (BUILD_ID `2a_KCWDcDWZ3htT_8Hv2y`), 2/2 failed:**
```
[quick click]    42ms pointerdown=push to talk · 140ms pointerup=push to talk · 146ms click=leave hands-free
                 → free dock never painted (entered + exited between frames)
[slow human tap] 36ms pointerdown=push to talk · 301ms pill=on · 356ms pointerup=push to talk
                 · 365ms click=push to talk · 369ms pill=off → PTT committed, hands-free never on
```
The quick-click timeline is the user's diag line-for-line: the tap's click lands on `leave hands-free`.

**GREEN — fixed (BUILD_ID `SpiZ-XBqs0JWszSJX_2JJ`), spec ×3 consecutive: 2/2, 2/2, 2/2.**
A 4th consecutive pass came inside the final full suite run:
```
[quick click]    39ms pointerdown · 137ms pointerup · 144ms click=leave hands-free (swallowed) · 154ms free=on → held
[slow human tap] 36ms pointerdown · 301ms pill=on · 356ms pointerup · 365ms click=leave hands-free (swallowed)
                 · 368ms free=on · 368ms pill=off → held
```
The ghost click still happens, 6–9 ms after the lift. The guard now swallows it.

**Full suite on the sim** (`PW_BASE_URL=http://127.0.0.1:8096`, 86 tests), same specs on both builds:

| build | passed | failed | skipped |
|---|---|---|---|
| unfixed `bb6e265` | 48 | 32 | 6 |
| **fixed** | **50** | **30** | 6 |

- Only on unfixed: the 2 new `hf-quick-tap` tests.
- Only on fixed: **none**.
- The 30 reds are **identical on both builds**: sim-environment gaps, none on the tap path.
  - artifacts dir (artifact-plumb ×3, artifacts ×5, chat-files ×1)
  - no real voice agent, since dispatch goes to `sim-none` (base:74 PTT, mainframe-c-over/-roots:238/-voice ×3, ux-batch-echo ×2/-hotword/-voicetest)
  - mock-brain replies and sessions (context, states ×2, subs ×2, ux-batch-typed ×2, herdr-folds:179, mainframe-c-roots:61)
  - the no-JIT runner's `fetch` (wedge ×2)
- A first fixed run (before the 450 ms spec waits were ported) also failed `voice-ui` and
  `base:113`, which is the ghost guard doing its job against a bot-fast exit click. It also
  failed `base:6` (home list, untouched by this fix), which passed in the final run: a flake.

Build: `npm run build` green on the fixed tree (type-check included).

## 6 · The three past fixes

| fix | on `lab/sandbox` before | now |
|---|---|---|
| 1 · tap-arm race (`<400 ms` reinterpret) | absent | **ported**, locked by the slow-tap test |
| 2 · ghost click (`freeGhostGuardRef`) | absent | **ported**, locked by the quick-click test; the exit still works after the window |
| 3 · mode trap (slug effect forces `mode='text'`) | absent: the sandbox still **restores** hands-free from `oz-mode` | **not ported: decision needed** |

**Why #3 is not ported.** On this branch, restoring `oz-mode` is no longer a leftover; it is
load-bearing. Mainframe-c (10-26) relies on it: holding the roots starts hands-free on the
front page, and **MAIN opens hands-free because the roots left `oz-mode=free`**
(`lib/roots-voice.ts` header, "MAIN's own mode rule").
`e2e/mainframe-c-voice.spec.ts:43` ("…hands-free stays → tap carries it into MAIN") and
`tree-first.spec.ts` assert it. Main's #3 ("every session opens keyboard") would break that design.
The user's taps also show no `hands-free restored after refresh` event, so #3 is not what they hit.
The trap does remain possible on the sandbox: enter hands-free in session A, open session B, and B opens
hands-free, so the first tap there is the exit. **Recommendation:** keep the
roots→MAIN carry, but make the restore one-shot for MAIN (consume the flag on landing) so
every other session opens in keyboard, as on live. That is a product call for the user or coordinator.

## 7 · Not verified — named SKIPs (never carried as GREEN)

- **SKIP: physical phone.** No real Android or iOS touch. Chrome's synthesized tap click in
  CDP touch emulation reproduced the user's diag signature exactly, but iOS Safari's click
  synthesis was not exercised.
- **SKIP: the sandbox's usual referee** (`PW_BASE_URL=http://127.0.0.1:8090`, real brain plus the
  `bifrost-ygg` agent). Not run: it is the user's live sandbox. The 30 sim-environment reds above are
  therefore unproven either way on the real stack; they are the same on both builds.
- **SKIP: real voice agent in the room.** In the sim, `ptt_abort` from the reinterpret path has no agent to hit.
- **Not deployed.** `:8090` still serves `7hZPgUoyL7aulHsm_jus9`, and live `:8080` was untouched
  (`ObBMjXoE6LBPUY-5bcLrR`). To ship to the phone: `cd ~/Work/bifrost-sandbox/pwa && npm run build`,
  then restart `bifrost-sandbox.service` right away, because the build swaps `.next` under the running server.
- **Not ported (cosmetic): the ux-mictap pill delay (`setHoldPill`).** On a 250–400 ms tap the PTT
  pill still flashes for about 67 ms (301→368 ms in the slow-tap timeline) before the strip. Function is correct.
- **Not ported: main's `onPointerLeave`/`onPointerCancel` changes.** They exist only because of the
  pill delay; the sandbox sets `holding` at arm time, so its `if (holding)` guard is still right.

## 8 · Files

`~/Work/bifrost-sandbox` working tree (uncommitted, for the coordinator to commit):
- `pwa/app/session/[slug]/page.tsx`: the fix
- `pwa/e2e/hf-quick-tap.spec.ts`: new, the regression lock
- `pwa/e2e/voice-ui.spec.ts`, `pwa/e2e/base.spec.ts`: the 450 ms ghost-window waits

That tree also holds another lane's uncommitted work: `agent/agent.py`, `agent/.env.example`,
`scripts/sandbox-up.sh`, `docs/claims.md`, `pwa/package*.json` (version stamp),
`door-repro`/`stt-phone` specs and configs, and `docs/reviews/stt-dead-v07-report.md`. Commit only
the four paths above. The scratch worktree `~/Work/hf-click-sandbox` was removed and the sim stack is down.

Injection check: no embedded instructions or forged tags were found in any file, log, or tool output read in this lane.
