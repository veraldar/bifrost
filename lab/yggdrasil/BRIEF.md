# YGGDRASIL — slice 2

Slice 1 is green and committed (in-memory sessions, POST /session,
GET/POST /session/:id/message, SSE relay to an OpenAI-compatible upstream).
Build slice 2 on top of your own code. Land THIS slice green, nothing more.

## Slice 2 scope (three capabilities)

1. **Abort** — a client can stop an in-flight reply mid-stream; the stop takes
   effect promptly (no full reply buffered first). Whatever is already
   generated stays consistent in the session history.
2. **`GET /event`** — a global SSE stream: a client connected to it receives
   the server's events (message deltas, completions, errors, aborts) for all
   sessions, without being the one who posted the message.
3. **Persistence** — sessions and messages survive a server restart (on-disk
   store; location configurable via env var of your choice, documented).

You pick the exact routes, event names, and file format — target shape is
"what opencode does", since the client (bifrost, OPENCODE_URL) already speaks
opencode. Keep slice-1 behavior working.

## Verification (your own, before you report done)

Extend `verify.sh` so it covers all three new capabilities end-to-end with
curls against the mock upstream (give the mock a slow mode so abort can be
exercised mid-stream), plus a server restart to prove persistence. Slice-1
assertions must still pass. Green means: you ran it, it printed PASS.

## Operational facts

- Rust toolchain: `source ~/.cargo/env`.
- Work only inside this directory; ~/Work/bifrost stays read-only.
- You have ~35 minutes. Manage scope to land green inside the box.
- Append a slice-2 section to ASSESSMENT.md (built / skipped / why, honest).
  Blocked twice on the same thing: stop, write the blocker, exit — never loop
  silently.
