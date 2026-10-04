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

# Slice 6a — tools + agent loop

**Status: green.** `./verify.sh` → PASS: the slice 1-3 assertions plus a new slice-6a block. Slice 4 is packaging and has no runtime assertions. There's no slice-5 surface in verify.sh.

The bifrost e2e referee (`./run-e2e.sh --grep-invert "voice|hands-free|LiveKit"`) gave **35 passed, 2 failed**. Neither failure is a yggdrasil regression:
- `context` is the known real-model env-gap from slice 3.
- `theme` is a client-only CSS check: it expects `#100c14` and the live `.next` build, rebuilt 10-03 10:00 by another session, renders `#1c1013`. That's product/spec drift and never touches the server.

Code: `src/tools.rs` (new, the tool set) and `src/main.rs` (loop, relay, history replay, `GET /session/:id/todo`). New dependency: `libc`, used for the process-group kill.

## Shape
- **Loop.** Each run is a sequence of upstream calls. Every call carries `tools` (OpenAI function calling), and its streamed `delta.tool_calls` fragments are reassembled by `index`; the non-stream JSON `message.tool_calls` form is accepted too.
  - If a step has no tool calls, the run is done.
  - Otherwise the calls run, the step goes into the conversation as `{role:assistant, content, tool_calls}` followed by one `{role:tool, tool_call_id, content}` per result, and the loop calls upstream again.
- **One assistant message per run.** opencode writes one message per step. I kept one message per run so the PWA's run model is unchanged (placeholder, `time.completed`, `message.completed`).
  - Parts are appended in order: `text`, then `tool`…, then `text`.
  - Empty text parts are dropped, but there's always at least one text part.
  - Tool parts look like this: `{type:"tool", callID, tool, state:{status:"running"|"completed"|"error", input, output, error?, title, metadata, time:{start,end}}}`.
- **Events.** `message.part.updated` `{sessionID, part}` fires on tool start (`running`) and again on finish (`completed`/`error`). It goes to both the global `/event` bus and the poster's SSE stream.
  - `todowrite` also fires `todo.updated` `{sessionID, todos}` and stores the list on the session. It's persisted and served at `GET /session/:id/todo`.
  - Text parts get no `part.updated`; deltas stay `message.part.delta`, exactly as before.
- **Checkpoints.** The message is persisted to disk on every tool start and finish. A marathon run is visible on GET mid-run, and a crash loses at most the tool in flight.
- **History replay.** Later turns rebuild the full trace from stored parts: a tool part closes a step, and the next text part opens a new one. Unfinished tool parts are skipped, because upstreams reject a call that has no result. Verify checks this directly: after two tool turns, the mock counts 5 `tool` messages in history.
- **Concurrency: serial.** Calls within a step run in order. Edits that depend on each other stay correct, and the trace order equals the execution order. Parallel reads would be faster, but bash is 60% of the life and bash calls are usually order-dependent.

## Judgment calls
- **Step cap: `YGG_MAX_STEPS`, default 100 upstream calls per run.**
  - The real data averages about 6.3 assistant steps per user prompt (8,546 / 1,346), with a long tail. 100 leaves room for long autonomous runs and still bounds a model that loops.
  - At the cap the run ends as an error: an `error` event naming the cap, `info.error` set, `session.idle` published. Tools from the last step have already run.
- **bash.**
  - Runs as `bash -c` in `YGG_PROJECT_DIR` (default cwd, canonicalized; a bad dir exits 2), with stdin null.
  - Output is stdout, then stderr, then `[exit code N]` when non-zero. A non-zero exit still counts as `completed`, as in opencode; the model reads the code. `metadata.exit` is set.
  - Timeout is `YGG_BASH_TIMEOUT_MS`, default 120 s. A per-call `timeout` (ms) is allowed, capped at 10 min. On timeout the tool returns an **error** and the partial output is dropped.
  - Each command gets its own process group. Timeout and **abort** SIGKILL the whole group (verify: `sleep` is gone after abort). After a normal exit the group is left alone, so intentional background jobs survive.
  - `YGG_*` env vars, including the API key, are stripped from the shell's environment.
- **Truncation.** At most **30,000 chars** per tool output (opencode's bash cap), keeping the **head and tail** with a `[... N bytes truncated ...]` marker. Build errors and test summaries live at the end.
  - The stored part holds exactly what the model saw, so a 588 KB `seq` stays at about 30 KB in the session file and doesn't bloat the marathons. `metadata.truncated` is set.
  - read: 2,000 lines by default, with `offset`/`limit`; lines are cut at 2,000 chars and numbered `%6d\t`. Files with NUL bytes in the first 8 KB are refused as binary.
  - glob: 100 entries max.
  - webfetch: 5 MB body cap, 30 s timeout by default (max 120 s). HTML is crudely stripped to text unless `format:"html"` is requested.
- **glob/grep use ripgrep** (`rg`, as opencode does), so they're gitignore-aware and skip hidden files. If `rg` is missing, the tool returns an error rather than taking down the server.
- **edit** is an exact string replace. Zero matches is an error; multiple matches are an error unless `replaceAll` is set; an empty `oldString` creates the file. A failed tool is fed back as `Error: …` and the loop continues (verify covers this).
- **Bad tool-call JSON** becomes an error tool part, with the raw arguments kept as `input.raw`, and the error is fed back to the model.
- `YGG_TOOLS=0` stops declaring tools, for upstreams that reject the `tools` param.

## Security posture: deliberately not guarded
This is a single-user box, the server is bound to localhost and the network is tailnet-only. The posture matches the user's own shell.
- **No permission system.** opencode asks before risky bash/edit; yggdrasil never asks. That's out of scope by decision (LIFE.md: 13 `question` uses in 9 months, voice-first).
- **No path sandbox.** Absolute paths and `..` work anywhere the user account can reach. The project dir is a default, not a jail.
- **No command filtering**, no network egress limits for bash or webfetch, and no SSRF guard (webfetch can reach localhost/LAN).
- **The model can read secrets** on disk (e.g. `yggdrasil.env`). Only the process env is scrubbed.
- What *is* guarded is resources: timeouts, process-group kill, output caps, the step cap, and the webfetch body cap.

## Verification (`verify.sh` slice-6a block)
The server restarts with `YGG_PROJECT_DIR=$TMP/proj` and `YGG_MAX_STEPS=4`. All data lives in throwaway temp dirs; `data/` is never touched. The mock's new `tool:` mode replays scripted tool calls, splits the arguments across stream chunks, and streams `step k.` text before each step.
1. **bash round-trip.** `marker.txt` really appears in the project dir. The SSE stream carries `message.part.updated` running→completed, then deltas with `TOOL-FINAL: out-42`, then `message.completed`. The stored parts are `[text, tool, text]`, with input, combined stdout+stderr, the cwd, and `exit:0`. The final text also proves all 8 tools were declared.
2. **write → edit (plus a failing edit in the same step) → read on an absolute path.** The file content is right, the failing edit is stored as an `error` part and the loop continues, read output is numbered, and history replay is counted.
3. **glob, grep, todowrite, webfetch, bash truncation and bash timeout.**
   - glob, grep and todowrite all complete. `GET /todo` returns the list and `todo.updated` appears on the bus.
   - webfetch reads yggdrasil's own `/todo`.
   - `seq 1 100000` is cut to 30,036 chars, head and tail.
   - A 300 ms timeout on `sleep 5` gives an error part.
4. **Loop safety.** `tool:forever` (mock never stops) ends at exactly 4 tool runs (`loop.txt` has 4 lines). It gets an `error` event naming the cap, no `message.completed`, and the busy map is empty. A 20 s guard makes a hang fail the test.
5. **Abort mid-tool.** Abort during `sleep 31.5` returns `true` and the stream closes in under 1 s. The tool's whole process group is gone, `never.txt` is never written, the tool part is `error:"aborted"`, and the message carries `MessageAbortedError`.
   *Process hygiene (night M1):* the check identifies the tool by the pid it writes itself (`echo $$ > tool.pid`) and probes its process group with `pgrep -g`. It never matches by pattern. An earlier independent check used `pgrep -f 'sleep 31.5'`, which also matched the shell running the check, and the cleanup killed that shell.
6. **Bus and persistence.** `/event` carried the tool trace, including `edit` `error`. The trace and the todo list come back byte-identical after a restart.

## Not done (next slices)
- Context roll-up (6b).
- Reasoning passthrough (6c).
- The `task`/child-session tool, plus `skill`, `question` and MCP. Together they're under 0.5% of the tool parts in LIFE.md.
- Per-step assistant messages and `step-start`/`step-finish` parts, which would only matter if the PWA starts rendering steps.
- No real-model run in this slice. The mock exercises the OpenAI tool-call wire format, but a live provider may differ in small ways (e.g. sending `id` on every fragment, which the reassembly already tolerates).

# Slice 7 — anthropic upstream dialect

**Status: green against the mock.** `./verify.sh` passed three runs in a row, about 12 s each. The slice 1–6b assertions are unchanged and still pass, and there's a new slice-7 block.

**Not yet run against the real upstream.** This session's environment had no `YGG_UPSTREAM_*` variables, so `./verify-real-upstream.sh` printed `FAIL-AUTH: YGG_UPSTREAM_BASE_URL not set` and exited 3. The script itself is checked against the mock (details under Verification) and is ready for the driver's key.

The bifrost e2e referee (`./run-e2e.sh --grep-invert "voice|hands-free|LiveKit"`, OpenAI dialect, with the refactored mock) gave **38 passed, 1 failed**. The one failure is `context`, the known gap from slice 3: it needs a real model. `theme`, which failed in slice 6a because of build drift, passes again.

What changed:
- `src/anthropic.rs` (new): the mapping and the block-SSE decoder, with 5 unit tests.
- `src/main.rs`: the config, a one-line dispatch in `relay` and in `summarize`, and the new `relay_anthropic` and `summarize_anthropic`.
- `mock/mock_upstream.py`: now speaks both dialects.
- `verify.sh`: the slice-7 block.
- `verify-real-upstream.sh` (new).
- `install/yggdrasil.env.example` and `install/README.md`: document the two new env vars.

No new dependencies.

## Shape
- **Selecting the dialect.** `YGG_UPSTREAM_STYLE` is `openai` (default) or `anthropic`. Any other value exits 2. At startup the server logs the dialect and the full POST URL.
- **One internal conversation, translated at the wire.** The run keeps the OpenAI-shaped conversation that `upstream_history`, the agent loop, roll-up and prune already build.
  - In anthropic style, `anthropic::body` translates that conversation for each request.
  - The response decoder returns the same two things the OpenAI relay returns: text deltas (forwarded as `message.part.delta` and accumulated) and a list of tool calls.
  - Everything after that is shared code: tool execution, parts, events, persistence and roll-up. So the dialect can't show up in the transcript.
  - The OpenAI code path is untouched apart from the dispatch line.
- **Request.** `POST {base}/v1/messages`. If the base already ends in `/v1`, only `/messages` is appended.
  - Body: `{model, max_tokens, system?, messages, tools?, stream:true}`.
  - Headers: `x-api-key` and `Authorization: Bearer`, both with the same key, plus `anthropic-version: 2023-06-01`. The real Anthropic API rejects requests without that version header; providers that don't need it ignore it.
- **Mapping.** Also documented at the top of `anthropic.rs`.
  - User text becomes a `text` block.
  - Assistant text plus `tool_calls` become `text` plus `tool_use` blocks. `input` is the parsed arguments object; arguments that don't parse become `{"raw": ...}`, the same as the stored part.
  - Each `tool` result becomes a `tool_result` block in the next user turn. Several results from one step share one user turn, and they always come first; a following user prompt goes after them.
  - Error results keep the `Error: …` text the OpenAI dialect sends.
  - Empty tool output is sent as `(no output)`, because some providers may reject an empty tool_result.
  - Consecutive turns with the same role are merged, since the API requires strict alternation.
  - Empty or whitespace-only text blocks are dropped.
  - A trailing assistant turn is right-trimmed, because the API rejects trailing whitespace in a prefill.
  - Tool ids are sanitized to `[A-Za-z0-9_-]`. Ids minted by other providers (e.g. `functions.bash:0`) then still replay after a dialect switch.
  - Tools: `{type:function, function:{name, description, parameters}}` becomes `{name, description, input_schema}`.
- **Roll-up: the system prompt goes top-level.** I chose to send `system`-role messages as the top-level `system` field, joined with blank lines and omitted when empty.
  - Today only the roll-up's summarizer call has one.
  - The stored summary is not a system message. It stays opencode's pair: a user message with a `compaction` part (sent as "What did we do so far?") and an assistant message with `summary:true`. That maps to two ordinary turns and keeps alternation.
  - The roll-up call is non-streamed and has no tools, as in the OpenAI dialect. An SSE answer to it is accepted too.
- **Thresholds are the same in both dialects.** Token estimates are still taken on the internal shape, so both dialects make the same roll-up and prune decisions on the same history.
- **Response decoding.** Events are handled by `type`: `message_start`, `ping`, `content_block_start/delta/stop`, `message_delta`, `message_stop` and `error`.
  - `text_delta` becomes a client delta.
  - `input_json_delta` fragments are reassembled into tool arguments per block index. A `tool_use` whose whole `input` arrives in `content_block_start` works too.
  - `message_stop` ends the read.
  - An in-stream `error` event fails the run the same way an HTTP error does.
  - A plain JSON message is also accepted.
  - `thinking` blocks are ignored, just as the OpenAI dialect ignores reasoning deltas (passthrough is slice 6c).
  - `stop_reason: max_tokens` is logged with a hint to raise `YGG_MAX_TOKENS`.
- **Split characters survive.** SSE lines are split on raw bytes and decoded whole, so a multi-byte character split across network chunks comes through intact (unit-tested with "é"). The OpenAI relay still decodes each chunk with `from_utf8_lossy`; I didn't touch it in this slice.
- **Tool-use ids are re-keyed.** At the relay, each `tool_use` gets a yggdrasil id (`call_<32 hex>`). The conversation sent back uses that id in both `tool_use` and `tool_result`.
  - Without this, every stored `callID` would start with Anthropic's `toolu_`, and the transcript would reveal its dialect.
  - The cost is that the provider's own id isn't kept.
- **Abort.** Same mechanism and no new code: an abort drops the relay future, which drops the response stream and closes the upstream connection.
- **`YGG_MAX_TOKENS` defaults to 16384.** That leaves room for a whole-file `write` call, and a truncated tool call is worse than a long answer. It's within the output limit of current Claude 4.x and GLM models. Older models with a smaller limit (e.g. 8192) answer 400; set the env var for those.

## Verification (verify.sh slice-7 block)
1. **Unit tests.** `cargo test` passes 6 tests: 5 new ones plus the existing 6b prune test. The new tests cover:
   - the URL rule;
   - the full tool-loop history mapping, including merged results, sanitized ids, raw arguments, empty output and the system prompt;
   - the prefill trim;
   - block-SSE decoding, including thinking blocks, input that arrives whole in `content_block_start`, and the error event;
   - SSE lines with a character split across chunks.
2. **The same scenario in both dialects.** Each dialect gets a fresh store and project dir with `YGG_ROLLUP_TOKENS=300` and `KEEP=60`. The scenario:
   - a chat turn;
   - a tool loop: bash, then write plus a failing edit in one step, then read, then the final reply;
   - marathon turns until the roll-up crosses (it crosses on the first one);
   - one turn after the roll-up.

   Then the checks:
   - **Stored transcripts are equal**, not just the same shape, after normalizing ids (by order of appearance), timestamps and the project path. That covers parts, tool states, outputs and metadata, the summary text and the replies. Each transcript has 10 messages.
   - **The client SSE stream of every turn is equal too**: event kinds and payloads, with the same normalization.
     - One value, the roll-up's `tokensBefore`, is only checked for direction (it must be above `tokensAfter`). It's an estimate over the stored call ids, and their length differs: the mock's OpenAI ids are `call_0_0`, the re-keyed ones are 32 hex characters.
     - The project dirs have equal-length names, because tool output contains the path and the summary reports a character count.
   - **No dialect leak.** There is no `toolu_` anywhere in the anthropic transcript or streams, and all 4 callIDs are `call_<32 hex>`.
   - **Each dialect hit only its own endpoint.** Both made the same number of chat calls (7), plus exactly one summary call without tools, with zero rejections. `YGG_MAX_TOKENS=777` arrived upstream as `max_tokens`.
3. **The mock checks requests strictly; it doesn't just echo.** Every `/v1/messages` request is validated the way the real API validates it, and anything else gets a 400 `invalid_request_error`. It checks:
   - both auth headers plus `anthropic-version`;
   - `max_tokens`;
   - the conversation starts with a user turn and roles strictly alternate;
   - no empty text blocks;
   - every `tool_use` is answered by `tool_result`s placed first in the next user turn;
   - tools are declared whenever tool blocks appear;
   - tool definitions have the `{name, description, input_schema}` shape.

   A valid request is mapped back to the OpenAI shape and answered by the same reply logic, so equal histories get equal replies. That is what makes the transcript comparison exact.

   It answers in real block SSE, with `toolu_` ids, a `ping`, and arguments split across two `input_json_delta` events. The OpenAI dialect's output is unchanged: the slice 1–6b assertions and the e2e referee pass against it.
4. **Abort mid-SSE in the anthropic dialect.**
   - The abort returns `true` and the stream closes in under 1 s.
   - The client gets `message.aborted` and no completion.
   - The stored partial text equals the deltas the client received, flagged `MessageAbortedError`.
   - The mock's disconnect counter shows the upstream connection really was dropped.
5. **Real-upstream script self-test.**
   - Against the mock, `verify-real-upstream.sh` prints `PASS-REAL`.
   - Key `mock-429` (a zai-style "Insufficient balance" 429), key `mock-401`, and no key each print `FAIL-AUTH` and exit 3 without crashing.

## Real upstream (`verify-real-upstream.sh`)
- **Env.**
  - `YGG_UPSTREAM_BASE_URL` and `YGG_UPSTREAM_API_KEY` are required.
  - `YGG_UPSTREAM_STYLE` defaults to **anthropic** in this script.
  - `YGG_UPSTREAM_MODEL` defaults to `glm-5.3-flash`, the model opencode uses on this box through `zai-coding-plan`.
  - `YGG_MAX_TOKENS` defaults to 4096 here, to keep the bill small.
- **Isolation.** It runs its own yggdrasil on `127.0.0.1:14199` with a throwaway store and project dir, and contacts nothing but the provider.
- **Hard checks:**
  1. The chat turn completes.
  2. The model makes a tool call, and a completed bash part printed `ygg-real-42`. The command is `echo ygg-real-$((6*7))`, so this proves it really ran.
  3. A roll-up crosses (`YGG_ROLLUP_TOKENS=100`), and a non-empty summary is stored with `summary:true`.
  4. An abort after the first delta of a long count returns `true`, the stream closes in under 2 s, the stored partial equals what was streamed, and the message is flagged `MessageAbortedError`.
  5. Transcript shape: every message, part and tool state has the opencode keys, callIDs are `call_<32 hex>`, and there's no `toolu_`.
- **Warnings only.** Whether the reply says "pong", repeats 42, or recalls 42 after the roll-up is model behaviour, not protocol, so those checks only warn.
- **Exit codes.**
  - 0 prints `PASS-REAL`.
  - 1 is `FAIL` on our side (mapping or server).
  - 3 is `FAIL-AUTH`: no key, 401/403/429, or an error mentioning balance, quota, recharge, rate limit and so on. The error is read from the server's `event: error` text, so errors that arrive inside the stream are classified too.
- **This session's run:** `FAIL-AUTH: YGG_UPSTREAM_BASE_URL not set`. The environment had no `YGG_UPSTREAM_*` variables. I didn't look for keys elsewhere (for example opencode's own auth store), because the brief has the driver supply the key.
- **To run it:** `YGG_UPSTREAM_BASE_URL=https://api.z.ai/api/anthropic YGG_UPSTREAM_API_KEY=… ./verify-real-upstream.sh`

## Caveats / not done
- **Not run against a real Anthropic-shaped provider.** The real run's turn 2 (the first tool step) will answer what the mock can't:
  - whether zai returns `thinking` blocks for GLM by default (they're dropped);
  - whether it then wants them back on tool_use turns;
  - whether it accepts re-keyed tool ids (the official API accepts any id that fits the pattern).
- **`YGG_TOOLS=0` on a session whose history already has tool parts isn't handled.** The anthropic API rejects tool blocks when no tools are declared; the OpenAI dialect doesn't care. Turn tools off only on fresh sessions.
- **No prompt caching** (`cache_control`): every turn re-sends the full history uncached. That's worth a slice for marathon cost on Anthropic itself; zai's coding plan is flat-rate.
- **No `is_error` on tool_result.** The `Error: …` text carries it, the same as in the OpenAI dialect.
- **Images still aren't forwarded upstream**, as in slice 3.
- **ASSESSMENT.md has no slice-6b section.** The night run committed 6b (ceb3724) without appending one. 6b is still covered by verify.sh's 6b block, which passes.
- **Housekeeping.**
  - Nothing is committed, per the house rule of no commits unless asked.
  - `docs/claims.md` is untouched: it's outside `lab/yggdrasil/`, and the driver's night-builder claim covers this directory.
  - The e2e harness wipes `run/`, so I backed up `run/night/` (the night-builder prompt) and restored it afterwards.
