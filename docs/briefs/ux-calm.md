# BRIEF ux-calm — session UX-CALM (Opus, judgment-grade)

Dispatched by the PHONE session, 2026-10-27, direct user order (voice).
Mission class: judgment — the dispatcher deliberately does NOT specify the how.
You judge the design; this brief locks only the goal, the boundaries, and what
"done" means.

## The user's words (voice, lightly cleaned — treat as ground truth of intent)

1. "When you're still working, text is arriving, and then the listen button
   shows up — but I cannot tap it because you're still working. As long as
   you're working, I shouldn't be able to tap the listen button."
2. "There's a lot of help text everywhere, at the bottom, the footer — right
   now in hands-free it says 'hands-free takeover', or 'tap the bar to send'.
   All those help texts — I want all of them gone."
3. "That help belongs in onboarding: onboarding should explain how to text,
   how to push-to-talk, and how to hands-free with the word 'over' — and ask
   the user to actually do each one."

## Assumptions we hold — may be wrong. Verify each against the code; correct
## the brief in your report where wrong (assumption verdict table required).

- A1 — "listen" = the per-answer listen/replay (TTS) control that appears on
  assistant messages.
- A2 — "working" = an opencode run in flight (text still streaming, run not
  yet idle).
- A3 — the footer help texts = the state/hint lines in the session screen
  footer (`pwa/app/session/[slug]/page.tsx` and anything it renders), e.g.
  'hands-free · say "over" or tap the bars to send', tap-to-send hints.
- A4 — onboarding = the existing first-run door / first-turn card
  (`components/tree-door.tsx`, `lib/onboard-voice.ts`). Extend that system;
  do not invent a second onboarding.

## Your judgment (deliberately unspecified)

- Busy-law for the listen control: disable vs hide vs queue-tap — you decide,
  from the code and the user's intent ("I shouldn't be able to tap it").
- Which strings survive: functional state words may stay if they carry real
  state; teaching/hint/coaching text goes. If in doubt, cut. Zero help text
  in the session footer is the target state.
- Where and how the interactive teach lives (door? first-turn card? re-playable
  entry?), and its copy. Brand voice law: `~/Work/bifrost/docs/brand/brand.md`.
- The teach must ask the user to DO each mode once (send a text, hold a PTT,
  say "over" in hands-free) — guided doing, not a wall of text.
- The teach must be re-experienceable by this user (already onboarded) — not
  strictly once-ever-only.

## Boundaries (binding)

- Tree: `~/Work/bifrost-sandbox` ONLY — this is the user's daily stack
  (:8443). Read `~/Work/bifrost-sandbox/AGENTS.md` FIRST; its build/restart/
  artifacts rules are binding (restart = `systemctl --user restart
  bifrost-sandbox`, nothing else; :8080/:4096/live units are off-limits).
- `pwa/app/session/[slug]/page.tsx` is claimed by ux-mictap and rung0-bvl
  (`docs/claims.md`; both silent since 10-02/10-04). The user's direct order
  overrides — deliberate merge, surgical edits only. Do NOT consume their
  scopes (mode-word timing, bvl diag, wake lock); regions may touch, scope
  must not. Say "deliberate merge" in your claims line and report.
- Tests are the referee: `PW_BASE_URL=http://127.0.0.1:8090`, never plain
  `npx playwright test` (that targets LIVE). Build + restart in the AGENTS.md
  order before testing what you changed.
- Commits: small, req-linked (req: 10-27 user voice order, ux-calm). Claims
  line in `docs/claims.md` while working; delete when done.

## Done — checkable, all five

1. While a run is in flight, the listen control cannot be tapped — proven by a
   spec that starts a run and asserts the untappable state until idle.
2. No teaching/hint strings remain in the session footer in any mode
   (text / PTT / hands-free) — proven by a runtime spec, not a grep claim.
3. An interactive teach exists that walks the user through doing each of the
   three modes once, and can be reached again after first run.
4. Build green; your new/affected specs green against :8090 after build+
   restart; no regressions in the specs you touch.
5. Report → `~/Work/bifrost/docs/reviews/ux-calm.md`: assumption verdicts,
   decisions taken, files, evidence (spec names + run output), and how the
   user sees each change on the phone. Completion letter via the harness.
