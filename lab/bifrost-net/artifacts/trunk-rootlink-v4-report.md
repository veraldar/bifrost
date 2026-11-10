# rootlink-v4c — sim2 gap fixes (health probes, in-flight caps, root-dial + mint)

**Status: RUNNING**
Base: ff913c5d (trunk: root-link dial-in registry, root-scoped dispatch)

## Scope (from prompt, exact)
- GAP-A fix:
  - (a) per-root in-flight cap (default 1, config `[root-link].max_inflight`) — at-cap root gets immediate 429-style error result, NOT queued worker slot.
  - (b) agent-level health: before RESULT_WAIT trunk sends `root.ping`; dial client must answer `root.pong` (proves AGENT loop, not socket). 3 consecutive probe failures → auto-unlink + branch gets 'root unhealthy' (not a 20s worker eat).
- GAP-B fix:
  1. `scripts/root-dial.py` — stdlib-only ws client (~40-60 lines): dial, `{op:'root-link',token}` first frame, answer ws pings, respond `root.ping`→`root.pong`, on `root.job` exec subprocess (`--exec`, default `opencode run`), reply `root.result{tid,ok,text}`; reconnect with `--token-file` fresh-token law (takeover-safe); `--listen` note: `[bridge.root-link].listen` settable non-loopback for Mac-over-tailnet (default stays loopback).
  2. mint: `bifrost-net rootlink mint --root <id> --dev <dev> --ttl <secs> --out file` (reuse roots.rs mint, jti single-use) — main.rs subcommand + tests.
  3. tests: extend `rootlink-sim.py` — wedged-root scenario (answers ws, never jobs → unlinked after 3 probes, fast error, worker freed); cap scenario; mint CLI smoke.
  4. `cargo test` + sim green → build → `artifacts/bifrost-net-v4c`, ONE commit.

## Results
(pending)

## Verification
(pending)
