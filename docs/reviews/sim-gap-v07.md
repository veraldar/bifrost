# SIM-GAP v0.7 — what the labs tested vs what shipped

2026-10-19 · session SIM-GAP · evidence-first, short, honest.

**Verdict.** The labs never tested the v0.7 artifact. The "simulate until
bulletproof" claim was true for the plumbing (brain, transports) and for the
*live* v0.6 app — and false for the thing the user then held in their hand.
The v0.7 failures were reproducible in a phone-class browser before ship; no
lab ever ran that repro. Repro-first was absent — that absence is the root,
and Rule 10-08 is its fix.

## 1. What shipped on :8090/:8443

Not a rust PWA — correction for the record: the only rust in the v0.7 slot is
the brain (`yggdrasil` :4100, `lab/yggdrasil`, one binary). The PWA the phone
loaded at `https://<tailnet-host>:8443` is the **tree-first Next.js 15.5.18
app from the sandbox worktree `~/Work/bifrost-sandbox/pwa`** — a *younger,
separate implementation* of the phone client (evidence: `bifrost-sandbox.service`
ExecStart = `next start -p 8090`, cwd = that worktree; `tailscale serve`:
`:8443 → 127.0.0.1:8090`; no PWA anywhere has a Cargo.toml). It was never
frozen into a release (STABLE.md named "freeze the next slot" as v0.7's first
step — not done), so what shipped was un-released, un-gated worktree code.

## 2. What the labs actually tested

| lab | artifact it drove | device class | covers v0.7 UX? |
|---|---|---|---|
| pwa Playwright e2e (46/46, the referee) | **live :8080 app** (trunk, v0.6.1 release) | **Desktop Chrome, phone-shaped viewport** (tree-first config: `devices['Desktop Chrome']`, 360×780) | no — wrong artifact, wrong class |
| ygg-sim cycle 6/7 — MATRIX 30, 0 FAIL ("CYCLE VALID") | `rest.*`/`bridge.*` hit **brain + proxy**; version pairing locked `app 0.6.0 ↔ sim 0.6.0` = the **live app** | headless + AVD for the 5 `app.*` probes | no scenario exists for: sandbox cold load, tree tap, onboarding flow, sandbox voice path (scenario list verified) |
| `app.chrome-mic-origin` (the one phone-class jewel) | gUM probe **against origins**, not the app's own voice path; run **before** tree-first deployed to :8090 | AVD, real Chrome, real prompt | proves :8443 *can* hold a mic — proves nothing about the shipped page |
| AGI-LOOP receipts (sandbox worktree, 10-06 night) | brain voice-mode, agent first-sound **1248 ms (server-side)**, STT = **wav file injected** ×3, TTS receipts, APK "renders the tree door" | backend + AVD webview render | **voice loop BLOCKED on the emulator** — receipts say it in bold: "the last red cell"; the audio track never published |
| yggdrasil e2e 1–8, bifrost-net M1 | brain / v0.8 bridge | headless | plumbing only |

## 3. Was the shipping artifact ever phone-class tested? No.

- Mobile browser: the tree-first app's only e2e is desktop Chromium in a narrow
  window (its own config says so).
- Mic permission on :8443: tested as an *origin property* on a clean probe —
  never as *the shipped page's* flow.
- Tailnet HTTPS + cold start on a phone: never. STABLE.md §next said it in
  plain words before ship: *"Not provable on an emulator: your phone's Chrome
  version, One UI battery rules… — one probe run on the S22 closes it."* The
  probe was owed and never run; the user became the probe.
- Voice end-to-end on any phone-class lane: blocked (emulator RTC cell) and
  shipped anyway — the receipts' own unlock #2 was *"a real phone mic … the
  human test path works now."* That is a plan to test **on the user**.

## 4. Why the sim passed while reality failed

Three stacked gaps, plus the root:

1. **Artifact-parity gap.** Sim paired to `app 0.6.0` (live). The tree-first
   fork shipped with zero sim scenarios, zero e2e against :8090, no frozen
   release, no gate. Its receipts came from a parallel loop with different,
   weaker legs.
2. **Device-class gap.** "Phone" in the labs meant: desktop browser in a
   360px window; AVD for render and origin probes; server-side timers for
   latency. The 1248 ms first-sound receipt measured the *agent*, not the
   phone-audible chain (page load + LiveKit join + dispatch + voice ≫ 1248 ms).
3. **Mock gap.** STT was proven with a wav file injected into the backend —
   the phone's mic, permission flow, and page wiring never touched the sandbox
   artifact. The receipts are real measurements of the wrong legs.
4. **Repro-first absent — the root.** None of the four reported failures
   (slow load, slow tap, dead STT, unclear flow) existed in the INCIDENTS
   register, the scenario matrix, or any diag before the user's test — because
   nobody had ever run the flow on a phone-class client against :8090/:8443.
   The failures were **reproducible without a phone**: this investigation ran
   the repro after the fact, in one pass, on the stock AVD (see §6). It could
   have run before ship. It didn't, because no rule required it.

## 5. The repro (run 10-19, shipping artifact, shipping origin)

AVD ygg-sim (Android 16, Chrome 133), clean profile, real navigation to
`https://<tailnet-host>:8443`:

- cold load of the tree door: **1409 ms** (warm 667 ms) — emulator-class CPU,
  box-local network; a real radio only adds to it.
- tap the tree → next page frame starts: **2394 ms** on a fast network — the
  "tree slow to respond" failure, reproduced.
- post-tap: mic permission still `prompt`, and the page opens its voice
  channel to **`wss://<tailnet-host>/livekit/...` on :443 — the LIVE slot's
  LiveKit path — from the :8443 sandbox origin**; the sandbox env
  (`bifrost-sandbox.env`) overrides no LiveKit URL, so the build ships the
  live slot's public URL. Config drift between artifacts, visible in one
  console line. (Root-cause/fix: session STT's territory.)
- screenshots: `/tmp/opencode/shots/repro-1-cold-tree.png`,
  `repro-2-after-tap.png` (out of git, raw host).

Every failure class the user reported was therefore catchable pre-ship by a
~15-minute probe. That is the whole argument for Rule 10-08.

## 6. PROPOSED Rule 10-08 — ARTIFACT PARITY (lab-law amendment)

> **10-08 ARTIFACT PARITY.** A simulation may only claim to cover what the
> *shipping binary* does on the *shipping device class*. Concretely:
> 1. **Artifact-identical:** before a version is declared lab-proven, the
>    labs must have driven the same artifact (same commit, same build, same
>    env) that will serve the user — a frozen release or its byte-identical
>    build, never a sibling implementation, never "the live app while the
>    fork ships". Version pairing (`app X ↔ sim X`) must name the shipped
>    artifact, and a younger fork with no pairing cannot inherit the older
>    artifact's green.
> 2. **Device-class honest:** every scenario declares its device class
>    (`headless | desktop | avd | phone`). A lane may not borrow another
>    lane's verdict: a desktop-viewport pass is not a phone pass, a wav
>    injection is not a mic pass, a render is not a round-trip. Remaining
>    device-class distance (AVD→phone) is listed as an OPEN obligation, not
>    folded into the pass count.
> 3. **Repro-first:** every user-visible failure becomes a failing phone-class
>    repro *before* the fix is claimed, and the repro is promoted into the
>    matrix (incident→scenario, per the v6 law) so the same failure can never
>    ship green again.
> 4. **No mock passes without artifact-identical verification:** a green
>    matrix may gate a *lab* verdict, but a *ship* verdict additionally
>    requires the artifact-identical check on the shipping device class —
>    for bifrost, the S22 probe (STABLE §next) until a standing phone lane
>    exists. "The human test path works now" is a test *plan*, not a test
>    *result*.

Enforcement sketch (cheap, scriptable): `gate.py --slot next` grows an
artifact-parity section — release-frozen check (already exists for live),
sim pairing name = shipped label, device-class column in the matrix digest,
and one `app.sandbox-first-run` AVD scenario (cold load ≤ budget, tap →
navigation ≤ budget, mic permission resolves, LiveKit URL == page origin's
slot) that runs the §6 repro on every cycle. The repro script from this
report is the seed of that scenario.

## 7. Open obligations this report creates

- Rule 10-08 adoption = user's call (it's a lab-law change).
- `app.sandbox-first-run` scenario + slot-next gate section: candidate first
  task under the new rule (owner: YGG-SIM lane).
- The INCIDENTS register should absorb the four v0.7 failures (onboarding
  slow-load, tree-tap latency, sandbox STT dead, post-onboarding flow) —
  three are already dispatched (onboarding-flow, voice-stt-sandbox sessions);
  the flow-unclear one has no session yet.

— SIM-GAP
