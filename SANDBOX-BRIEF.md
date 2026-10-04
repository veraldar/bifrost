# SANDBOX — finish tree-first: the FRONTEND wiring

A previous run built the backend and died before the UI. Present and green:
`lib/tree-first.ts` (flags, MAIN_SLUG, onboarding slugs, prefs),
`app/api/onboard/route.ts` (start → onboarding session + prompt; done →
reserved `[MAIN]`, verified live), MAIN delete guard (403), session routes.
MISSING: nothing in `app/page.tsx` or `components/` imports tree-first —
the phone never sees the tree.

## Your scope (frontend only)

1. **First open** (no `tree-first-done` in localStorage — per-device, do
   NOT gate on the server store being empty): home renders the fullscreen
   tree ALONE (use the existing ygg tree component, cohesive design law —
   no list, no chrome, one quiet invitation).
2. **Click/tap the tree** → POST `/api/onboard {step:'start'}` → navigate
   to the onboarding session, hands-free armed (the existing hands-free
   path). The brain's onboarding conversation is already fired by the
   route.
3. **Onboarding completes** → the page calls `/api/onboard {step:'done',
   from, prefs}` (prefs from the conversation: voice, style — parse or let
   the user confirm by voice; pragmatic is fine), sets `tree-first-done`,
   navigates to `/session/main`.
4. **Afterwards** (flag set): home shows the NORMAL locked list design
   plus the tree shrunk to its corner — the tree stays THE DOOR: click →
   `/session/main`. The shrink animation plays once (the lib already has
   TF_SHRINK_KEY).
5. MAIN must never offer swipe-delete in the UI (the guard exists
   server-side; mirror it in the list UI).

## Verification (your own)

`npm run build` green; serve :8090; Playwright (browsers exist in
~/Work/bifrost/pwa/node_modules): fresh context → fullscreen tree, list
hidden (screenshot 1) → click → lands on the onboarding session with the
brain greeting in the transcript (screenshot 2) → simulate completion →
corner tree + list + MAIN link (screenshot 3) → MAIN row shows no delete
affordance. Save screenshots under ~/Work/bifrost-sandbox/artifacts/ with
tree-first- prefix, and write SANDBOX-REPORT.md (built / skipped / why —
the previous run left no report; reconstruct honestly from git).

Territory unchanged: ~/Work/bifrost-sandbox only, ~45 min, blocked twice →
stop and write the blocker.
