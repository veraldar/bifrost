# Slice 1 — assessment

**Status: green.** `./verify.sh` builds the binary, starts the mock upstream and yggdrasil, curls all three endpoints, and asserts on the results. It prints PASS.

## Built
- `src/main.rs` (axum 0.8 + reqwest 0.13, about 250 lines). Sessions are stored in memory (`Mutex<HashMap>`).
  - `POST /session` returns `{id, title, time}`.
  - `GET /session/:id/message` returns `[{info:{id,sessionID,role,time}, parts:[{type:"text",text,...}]}]`. This is opencode-shaped. Unknown id gives 404.
  - `POST /session/:id/message` with body `{"parts":[{"type":"text","text":"..."}]}`. It stores the user message, sends the full session history to `{BASE}/chat/completions` with `stream:true`, and relays each delta as SSE `event: message.part.delta` / `data: {"text":...}`. When the reply finishes it stores the assistant message and emits `event: message.completed` with that message. Upstream failures emit `event: error`. A non-streaming JSON reply from upstream is also accepted.
- Env vars: `YGG_UPSTREAM_BASE_URL` (required, e.g. `https://api.openai.com/v1`), `YGG_UPSTREAM_API_KEY` (optional bearer), `YGG_UPSTREAM_MODEL` (default `gpt-4o-mini`), `YGG_LISTEN` (default `127.0.0.1:4096`).
- `mock/mock_upstream.py` is a throwaway OpenAI-compatible SSE mock that echoes the last user message.
- `verify.sh` is the smoke test. It runs on port 14096 so it doesn't clash with a live opencode on 4096. It checks for 2 turns, the reply text inside the SSE, delta events, GET history roles and contents, and a 404.

## Skipped / caveats
- Persistence, /event, abort, and session list/get are left for later slices.
- The SSE event names and message JSON follow opencode's shape but are not byte-compatible with opencode's API. Bifrost hasn't been driven against this yet.
- If the client disconnects partway, the upstream call still runs to completion and the reply is still stored. There is no cancellation.
- Only the mock upstream was tested. No real provider or TLS endpoint was tried.

# Slice 2 — assessment

**Status: green.** `./verify.sh` prints PASS. I ran it 3 times in a row and it passed every time. All slice-1 assertions are still in place and passing.

## Built
- **Abort**: `POST /session/:id/abort` uses the same route as opencode. It returns `true` if a reply was in flight, `false` if the session was idle, and 404 if the session id is unknown.
  - Each in-flight reply registers a `Notify` keyed by session. The relay future runs inside `tokio::select!` against that `Notify`, so an abort drops the future and closes the upstream HTTP connection. The mock logs "client disconnected mid-stream" when this happens.
  - The text streamed so far is stored as the assistant message with `info.error = {name:"MessageAbortedError"}`, matching opencode. The poster gets `event: message.aborted` and its stream closes.
  - Measured: the stream closes about 0.01s after the abort call.
  - Verify also checks that the stored partial text equals the concatenation of the deltas the client received, so history stays consistent with what was streamed. It also checks that the session works normally for a later turn.
- **`GET /event`**: a global SSE stream fed by a `tokio::broadcast` bus. Each frame is an unnamed `data: {"type", "properties"}` frame, as in opencode, and the first one is `server.connected`. Event types:
  - `session.created`
  - `message.updated` (the user message)
  - `message.part.delta` (`{sessionID, text}`)
  - `message.completed`
  - `message.aborted`
  - `error`

  A slow listener that lags skips the events it missed instead of blocking the relay. A keep-alive is set. Delta payloads now also carry `sessionID` on the per-request stream, which is an additive change.
- **Persistence**: the store directory is set by `YGG_DATA_DIR` (default `./data`, gitignored).
  - Each session is one file, `session/<id>.json`, containing `{info, messages}`.
  - It is rewritten atomically (tmp + rename) under the sessions lock on every change: create, user message, completion, abort.
  - All files are loaded at startup. Unreadable files are skipped with a log line.
  - Added `GET /session` to list sessions, since it's cheap and useful after a restart.
- **Mock**: if the last user message starts with `slow`, the reply is long and arrives at 0.2s per chunk (about 10s total). The mock also tolerates the client disconnecting partway.
- **verify.sh**:
  - Starts a background `/event` listener before anything else.
  - Runs the slice-1 flow.
  - Checks the abort 404 and idle-`false` cases.
  - Starts a slow post, aborts after 1.5s, and checks the result: `true` returned, stream closed in under 1s, deltas seen before the abort, no `SLOW-END` text and no completion event, partial text stored and flagged, and a later turn works.
  - Asserts on the global event stream: all event types appear, sessionIDs are correct, and there are 3 completions.
  - Kills and restarts the server on the same data dir, then checks that the history is byte-identical, the session is listed, and a new turn sees all 9 messages of context.

## Skipped / caveats
- The event shapes follow opencode's `{type, properties}` envelope and names, but they are not byte-compatible with it. opencode emits `message.part.updated` with full part objects and `session.idle`/`session.error`, not `message.completed`/`message.aborted`. Bifrost has still not been driven against this server.
- A client disconnect still does not cancel the upstream call. Only an explicit abort does. This is now arguably correct, because `/event` listeners may still want the reply.
- Each change rewrites the whole session file, which is O(n) per write. That is fine at this scale, but long sessions would want an append log. There is no fsync, so a crash right after a write could lose the last change. Nothing is pruned or deleted.
- Two concurrent posts to the same session are not serialized. A new post replaces the abort handle, so `abort` targets the newest reply.
- Only the mock upstream was tested. No real provider was tried.

# Slice 3 — assessment (bifrost drives yggdrasil)

**Status: core text-session flows green through bifrost's own, unmodified e2e suite** (see the
per-spec table). Product code untouched: every change is under `lab/yggdrasil/`.
`./verify.sh` still PASSES (slice 1-2 assertions intact, plus a new slice-3 block).

## How the referee runs: `./run-e2e.sh [playwright args]`
- **Private network namespace** (`unshare -rn`). Inside it yggdrasil binds `127.0.0.1:4096` and the
  PWA binds `:8080`, the exact ports the suite assumes. So the specs that hardcode
  `http://127.0.0.1:4096` (subs, wedge, context) also hit yggdrasil, and the live opencode and
  lk-pwa on the host are never contacted. A plain `OPENCODE_URL=` run on another port would have
  sent those specs to the live opencode.
- **PWA = the live production build**, not rebuilt. `.next` is copied (cache excluded), and
  node_modules, public, package.json, next.config.ts and .env.local are symlinked.
  It is started from the scratch cwd `run/pwa` with `OPENCODE_URL=http://127.0.0.1:4096`.
  The scratch cwd matters: the proxy writes `.oc-live.json`, `.oc-queue.json`, `.push-subs.json`,
  `.diag/` and `../artifacts` relative to cwd. Running in `pwa/` would have mixed lab runs into
  live proxy state.
- `e2e.config.mjs` is `pwa/playwright.config.ts` re-pointed: specs read in place from `pwa/e2e`
  and outputs go to `run/`. Playwright runs from `run/pwa`, so the specs' `../artifacts` writes
  land in `run/artifacts`, not in the user's artifact gallery.
- Fixtures:
  - Mock upstream with `MOCK_LATENCY=2`.
  - `fixtures/catalog.json`.
  - One seed session with one turn, because the home specs need one existing row.
  - One seed `.html` artifact, because the gallery spec expects HTML designs on disk.

## Built (yggdrasil gaps the referee exposed, closed in yggdrasil)
- **Blocking JSON `POST /session/:id/message`.** The proxy `ocFetch`es it and needs the final
  assistant message as JSON, the way opencode answers. The slice-1 SSE relay is still served
  when the client sends `Accept: text/event-stream`, and verify.sh now sends that header.
- **Run lifecycle like opencode:**
  - The user message is stored at once.
  - Runs are serialized per session (a run lock): a stacked prompt waits its turn and sees the
    previous reply in its history.
  - An un-completed assistant placeholder is written at run start. This gives the
    `|0|assistant` run state that the wedge spec and the PWA busy logic key on.
  - The placeholder is filled in place at the end, with `time.completed`. Aborted messages also
    get `time.completed` and keep the MessageAbortedError flag.
  - Events: `session.status` busy, then `message.updated` (the PWA watchdog regexes
    `"sessionID":"ses_…"` and `"completed":1…`), then `session.idle`. The idle event is the
    PWA's speak/done signal.
- **File parts.** Image `data:` URLs are stored in the user message instead of being rejected
  with a 400. Text parts still go upstream. Images are not forwarded upstream (text-only relay).
- **`POST /session` honours `{title, parentID}`.** The PWA resolves session slugs by title, and
  the subs spec seeds parent/child pairs. Sessions track `time.updated` and list newest first.
- **`GET`/`PATCH`/`DELETE /session/:id`.** Delete aborts a live run and removes the file.
- **`GET /session/status`**: opencode's busy map. The proxy's stall watchdog scans it.
- **Catalog: `GET /config/providers` and `GET /agent`** come from `YGG_CATALOG`. The default
  catalog is one provider (the upstream model) plus build/plan.
- **v2 switches: `POST /api/session/:id/model` and `/agent`.** They validate against the catalog
  and return 204. The choice is recorded on the session.
- **Mock (`mock/mock_upstream.py`)**:
  - "reply with exactly: X" or "reply: X" makes the reply X.
  - "sleep N" delays the reply N seconds, standing in for a long tool run.
  - `MOCK_LATENCY` sets the time to first token.

## Skipped (with reason)
- **Model routing.** The switch is recorded, but every catalog model relays to the single
  `YGG_UPSTREAM_MODEL`. Think levels are just catalog entries. No spec observes the provider call.
- **Tools.** There is no tool execution: "sleep N" is the mock's latency, not a bash run. The
  wedge/queue specs prove the run-state *mechanics* only.
- **Not called by the PWA, or not proven necessary:** `/project`, `/file`, `/command`, `/config`
  writes, part-level `message.part.updated` events, pagination.
- The rest of the PWA's API (artifacts, push, tts, token, diag, build, search) is served by the
  Next proxy itself. It never reaches opencode, so there is nothing for yggdrasil to serve.

## Spec-side finding (product test bug, reported, not fixed: product code is frozen)
`base`, `states` and `history` assert `getByText('pong')` after sending
"Reply with exactly: pong". That locator also matches the prompt echo. Against a real provider
it passes **on the echo alone**, seconds before the reply exists. With an instant mock reply,
both elements are present, Playwright strict mode throws, and the worker restart then wipes the
module-level `sessionId`, failing the rest of the file.
- Observed: first full run, `base` round-trip ✘ in 446ms.
- Work-around in the lab: realistic 2s first-token latency.
- Product fix suggestion: `getByText('pong', { exact: true })`.

## Per-spec results (run 2: `./run-e2e.sh`, voice tests excluded by --grep-invert after run 1 triage)
| spec / test | result | class |
|---|---|---|
| artifacts: bell, mark-all, thumbnail, card corner, md page, html render, api list (7) | ✓ 7/7 | green. The bell test was ✘ in run 1 because the scratch artifacts dir had no html. Lab fixture seeded; the proxy serves these, not opencode |
| base: home list, create, **text round-trip**, run-state headers, attachments, cleanup (6) | ✓ 6/6 | yggdrasil-gaps fixed: JSON post, title, placeholder/completed, file parts, delete |
| base: voice PTT/LiveKit, hands-free arms (2) | ✘ in run 1, excluded in run 2 | **environment-gap**: `ECONNREFUSED 127.0.0.1:7880`. LiveKit, the voice agent and speech models are outside the namespace, and the voice agent posts to the host opencode anyway, not yggdrasil |
| chat-files: inline artifact viewers | ✓ | green (the messages route is mocked by page.route) |
| context: fresh session answers with bifrost context | ✘ | **environment-gap**: needs a real model that reads the AGENTS.md chain and answers "~/Work/bifrost". The echo mock can't know that. Its tool-call assertion would pass (yggdrasil has no tools) |
| context: cleanup | ✓ | green |
| history: swipe, touch swipe, input recall, cleanup (4) | ✓ 4/4 | green |
| queue: mid-run send queues, cancel advances (+cleanup) | ✓ 2/2 | yggdrasil-gaps fixed: abort + busy placeholder + blocking post resolve on abort |
| settings: tiles, think switch, rename, model picker, delete (5) | ✓ 5/5 | yggdrasil-gaps fixed: catalog, v2 model/agent switch, GET/PATCH/DELETE session |
| states: home, empty→working→replied, search, cleanup (4) | ✓ 4/4 | green |
| states: hands-free keyword status | excluded | **environment-gap** (LiveKit, same as base voice) |
| subs: nest under parent, swipe-delete + undo (2) | ✓ 2/2 | yggdrasil-gap fixed: `parentID` on create. Hits :4096 directly, which is yggdrasil inside the netns |
| theme: world switch | ✓ | green (client-only) |
| voice-ui: rail/glyph/words per voice state | excluded | **environment-gap**: needs the LiveKit agent's `listening` status |
| wedge: stacked prompt must not wedge-abort | ✓ | yggdrasil-gaps fixed: per-session run serialization + un-completed placeholder (`|0|assistant`) |
| wedge: dead run → event-quiet escape (+cleanup) | ✓ 2/2 | green: no events during the sleep, and the client's abort lands |
| watchdog-zombie | not run | ignored by the stock config too (needs its own OC_STALL_MS server) |

**Run 2 totals: 36 passed, 1 failed (context, environment-gap), 4 voice tests excluded.**
Run 1, with the voice tests included, showed them failing on LiveKit only, as quoted above.
Evidence: `/tmp/ygg-full2.log` (not kept). Rerun with `./run-e2e.sh --grep-invert "voice|hands-free|LiveKit"`.

## Caveats
- `unshare -rn` needs unprivileged user namespaces, which this box has.
- The harness reuses the live `.next` build as-is. If the working tree is rebuilt mid-run, the copy
  is still consistent, because it is taken at start.
- The mock's "reply:"/"sleep" heuristics are tuned to the suite's prompts. A real provider would
  only change timing.

# Slice 4 — packaged for Omarchy/Arch

**Status: green.** Everything is in `install/`: `install.sh`, `yggdrasil.service`, `yggdrasil.env.example`, `README.md`, `PKGBUILD`.

## Verification (2026-10-02, this box)
- **Clean-path install.** `BIN_DIR`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` pointed at `/tmp/ygg-clean`. Files landed exactly as the README table says: the env file is mode 600, the config and data dirs are 700, and the unit has absolute `ExecStart`/`EnvironmentFile`.
  - I listed everything under `~/.config` and `~/.local` with an mtime newer than the pre-install timestamp. No yggdrasil files showed up in the real home.
- **Release-tarball path.** `install/` plus a prebuilt binary, run under `env -i PATH=/usr/bin` with no cargo available: the install was green.
- **Installed unit under the real `systemctl --user`.** The real user manager only reads `~/.config/systemd/user`, so I attached the throwaway unit with `systemctl --user --runtime link` (a tmpfs symlink in `/run/user/1000`, nothing in home) and ran `daemon-reload`.
  - Mock upstream on :18181, service on :14100. The full round-trip worked: POST /session → POST message (SSE: 6 deltas + `message.completed`) → GET history `[user, assistant]`. The session JSON landed in the prefix data dir.
  - `systemd-analyze --user verify` is clean for both the install.sh unit and the PKGBUILD unit.
- **Idempotency.** I re-ran install.sh twice while the service was running:
  - The env file and unit were byte-identical (sha1 check).
  - The binary was reported `unchanged`.
  - The service stayed active, with no "unit changed on disk" warning.
  - The session survived a reinstall plus restart.
- **Config error.** With an empty `YGG_UPSTREAM_BASE_URL` the service goes `failed` with status 2 and NRestarts=0, so there's no restart loop.
- **PKGBUILD.** `makepkg -f` built cleanly in 67s. The package holds `/usr/bin/yggdrasil`, `/usr/lib/systemd/user/yggdrasil.service` (`%h` paths) and `/usr/share/doc/yggdrasil/{README.md,yggdrasil.env.example}`. I did not install it with pacman, because root on the real box is out of scope.
- `./verify.sh` still passes after the one source change below.
- **Teardown.** Unit unlinked, `daemon-reload`, prefix deleted.

## Binary
`[profile.release] strip = true` brings the release binary from 10.5 MB to **8.1 MB** (7.8 MiB), stripped. It links only glibc and libgcc_s (`ldd`), because TLS is rustls, so there's no OpenSSL dependency.

## Judgment calls
- **Default port 4100, not 4096.** On this very box opencode-serve holds 127.0.0.1:4096. Anyone trying yggdrasil will very likely still have opencode installed, and a silent collision means a bind failure or, worse, bifrost talking to the wrong server without anyone noticing. The cost is one explicit `OPENCODE_URL=` line, and the README and install.sh both print it. The binary's built-in default stays 4096 for drop-in use outside the unit.
- **Build from source by default; no binary in git.** An 8 MB blob per commit bloats history, it's tied to one architecture, and it's unauditable. `Cargo.lock` plus `--locked` already makes the build reproducible. install.sh still prefers `./yggdrasil` next to the script, so a release tarball installs without cargo. `install/.gitignore` keeps that slot and makepkg output out of git.
- **Moderate hardening.** The unit sets NoNewPrivileges, LockPersonality, RestrictRealtime, RestrictSUIDSGID, RestrictNamespaces, MemoryDenyWriteExecute, native syscall arch only, and UMask 0077. All of these work in an unprivileged user manager because they rely on seccomp or prctl, not mount namespaces.
  - I left out ProtectSystem/ProtectHome/PrivateTmp. In user units they depend on unprivileged user namespaces, which some hardened kernels and distros disable, and then the unit fails to start, which breaks "it must just work".
  - `systemd-analyze security` scores it 8.0 "EXPOSED". That's typical for user units; the real boundaries are the user account and the localhost bind.
  - `RestartPreventExitStatus=2` turns a config error into a visible failed state instead of a restart loop.
- **Env file is created once and never overwritten.** It holds the API key. The unit and binary are replaced only when their content changes (`cmp`), so a re-run is a no-op and doesn't need `daemon-reload`.
- **install.sh does not start the service by default**, because it can't run without an upstream. `--now` enables and starts it, but only once a URL is set, and only when the unit dir is the one the user manager actually reads.
- **PKGBUILD done** because it was cheap. It reuses the same unit template: `%h` specifiers for per-user config and data, and `Environment=YGG_DATA_DIR` as a default the env file can override. `!debug` keeps makepkg from emitting an empty -debug package, since the profile already strips the binary.
- **One lab source change.** In `main.rs`, an *empty* `YGG_UPSTREAM_BASE_URL` now counts as unset. Before, the shipped template's `YGG_UPSTREAM_BASE_URL=` line started a healthy-looking server that failed on every message. Now it exits with status 2 and logs `YGG_UPSTREAM_BASE_URL is required`.
- **README tells users to set `OPENCODE_URL` in both** `pwa/.env.local` and `agent/.env`. The voice agent reads it too (`agent/agent.py:30`), and missing that would leave voice on opencode.
