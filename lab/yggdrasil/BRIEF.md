# YGGDRASIL — slice 3

Slices 1-2 are green: sessions, messages, SSE relay, abort, global /event,
persistence (release build verified). You now live inside the bifrost repo at
`lab/yggdrasil/`. This slice is THE mission constraint: bifrost itself must
drive you.

## Slice 3 scope

Point bifrost's PWA at yggdrasil via its `OPENCODE_URL` mechanism and make the
core flows work end-to-end. The referee is bifrost's own e2e suite:
`cd pwa && npx playwright test` with `OPENCODE_URL` pointing at a running
yggdrasil instance (fed by the mock upstream — a real provider is not needed;
echo replies satisfy the flows). Text/session specs must pass. Specs that fail
for reasons yggdrasil cannot own (voice/livekit/speech infrastructure) must be
triaged and documented as such — honestly, per spec.

You may READ anything in the repo (that is how you learn the real surface:
`pwa/lib/`, `pwa/app/api/`, `pwa/e2e/`, README, AGENTS.md). You may RUN the
tests. You may MODIFY ONLY `lab/yggdrasil/`. The product code is frozen —
zero product impact is a lab law; compat gaps are closed in yggdrasil, never
in bifrost. Note `pwa/.diag/` (diag log) and the playwright artifacts are
run outputs, not product code.

Bifrost's surface is wider than what you serve (provider/model listing,
config, agents, artifacts, history endpoints...). Discover by reading what
the pwa actually calls, implement what the referee proves necessary, skip the
rest with a written reason. Do not guess: the specs are the oracle.

## Verification (your own, before you report done)

`OPENCODE_URL=<yggdrasil> ` + playwright: core text-session specs green
(session create, send, streamed reply visible, history). Slice-1/2
`verify.sh` still PASS. Per-spec results listed in ASSESSMENT.md:
green / yggdrasil-gap fixed / environment-gap (why).

## Operational facts

- `source ~/.cargo/env`; node/npm are installed; playwright browsers should
  already be set up in `pwa/` (if not: `cd pwa && npx playwright install chromium`).
- You have ~50 minutes — discovery-heavy. If the e2e harness cannot run at
  all after ~15 min of trying, write the blocker to ASSESSMENT.md and exit.
- Append a slice-3 section to ASSESSMENT.md (built / skipped / why, per-spec
  table). Blocked twice on the same thing: stop, write, exit — never loop.
