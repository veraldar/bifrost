# SANDBOX PWA — tree-first first-run (user add-on, approved)

Territory: `~/Work/bifrost-sandbox` (branch lab/sandbox, the locked cohesive
design at ab00e73). Live bifrost (~/Work/bifrost, :8080) is FROZEN — do not
touch it. The sandbox PWA serves on :8090; its env already points
OPENCODE_URL at yggdrasil (127.0.0.1:4100, live) and reuses the LiveKit/
speech stack. You are FREE to improve quality, performance, and bifrost-net/
yggdrasil compatibility — but DO NOT change how bifrost looks: the cohesive
design system is locked law. The tree-first flow is the one visual addition
you are allowed (and ordered) to build.

## The flow (HER-style, voice-first)

1. **First open** (no `tree-first-done` in localStorage): the tree fills the
   screen ALONE — no list, no chrome. Quiet. One invitation: click/tap.
2. **Click → hands-free onboarding.** Mic opens (the existing hands-free
   path), and yggdrasil runs the onboarding conversation: it asks (voice)
   voice choice (woman/man), reply style (short and fast vs more
   explanation), then THE BRAIN: local-free / OpenRouter pay-per-use /
   coding plan, with the data trade-offs stated in one plain sentence each
   (local free = stays on this machine; OpenRouter = per-provider data;
   coding plan = cheapest, vendor sees data). Local + free preferred where
   quality allows. The flow ends with expectations set: "want me shorter,
   faster, or more detailed — just ask."
3. **Onboarding completes → THE MAIN session is created**: reserved slug
   `main`, caps-tagged title (e.g. `[MAIN]`), never swipe-deletable (UI
   guard; the brain also has no delete endpoint — belt and suspenders).
   `tree-first-done` set.
4. **Afterwards**: the tree shrinks to its corner but stays THE DOOR — click
   it anywhere → open MAIN.

The onboarding conversation itself is a yggdrasil session with an
onboarding system prompt (you author it; it must ask, listen hands-free,
confirm choices back by voice, then end cleanly). Voice in/out rides the
existing livekit agent path (lk-agent already speaks to yggdrasil) — no
agent changes needed; if a sandbox-specific env tweak is required, do it in
the sandbox only.

## Verification (your own, before you report done)

- `npm run build` green in ~/Work/bifrost-sandbox/pwa.
- Serve :8090 (prod build) and prove with Playwright or scripted fetches:
  first-open renders fullscreen tree and nothing else; click starts the
  onboarding session (a yggdrasil session with your onboarding prompt
  appears on 4100); MAIN is created with the reserved slug + caps title;
  corner tree present after completion; swipe-delete is blocked on MAIN;
  second open skips first-run. Voice round-trip cannot be fully asserted
  headless — assert the hands-free path engages (the same code path the
  live e2e suite exercises) and say so honestly in the report.
- A screenshot of first-open and post-onboarding states saved under
  ~/Work/bifrost-sandbox/artifacts/.

## Operational facts

- Work ONLY in ~/Work/bifrost-sandbox. ~60 minutes. Blocked twice on the
  same thing: stop, write the blocker, exit.
- Write your process notes into ~/Work/bifrost-sandbox/SANDBOX-REPORT.md.
