# TOOL-SCOPE plan — session-scoped tool profiles on the root (yggdrasil)

Session TOOL-SCOPE, 2026-10-28. Branch `lab/tool-scope` (worktree `~/Work/bifrost-tool-scope`),
base `f30217d`. The root's code under `lab/yggdrasil` is unchanged since `412a9c4`, the binary
live on :4100 (md5 `8103fb3d…`, identical to `target/release`).

## 0. What exists today (verified, not trusted)

- `tools.rs`: 8 tools (bash, read, write, edit, glob, grep, webfetch, todowrite). The one lever is
  `YGG_TOOLS=0`, which turns off all 8 for every session in the process.
- `main.rs` `POST /session` reads `{title?, parentID?}`. `PATCH` handles `title` only, and it
  ignores any other field without telling the caller (tool-policy saw `PATCH {tools}` → 200).
  `GET /agent` serves `[{name, mode, description}]` from the catalog, with no permissions.
  `POST /api/session/:id/agent` records `info.agent`, which only labels the session and enforces nothing.
- opencode (:4096, read-only probe of `GET /agent`): each agent carries
  `permission: [{permission, pattern, action: allow|deny|ask}]`. The **last matching rule wins**.
  `write`/`edit` check the `edit` permission. A tool whose last matching rule is a blanket
  `{pattern:"*", action:"deny"}` is removed from the model's tool list. Live examples:
  `explore` = `* * deny` then allow grep/glob/list/bash/webfetch/read. `plan` = `edit * deny`
  plus allows for specific plan files.
- tool-policy lab (`lab/tool-policy/runs`, 42/45 turns, the partial rerun killed at C/t5):
  prompt-only policy, violations = 1 (C t3 r3). Reading the trace shows that one violation is a
  **grader false positive**: C delegated to a sub-session created *without* `parentID`, so the
  grader saw no kid but did see a new file. The real leak shows up in B/C traces as **porosity**:
  every coordinator does all its "session management" through `bash` + `curl`, so a ban by
  prompt alone cannot be observed or enforced. The earlier run's B inline edit (the brief's
  "partial finding") had no trace of its own in `runs/`, and the report says so.

## 1. Decisions

### D1. The profile model is opencode's agent permission ruleset (the familiarity law)
A profile is an object in exactly the shape opencode serves on `GET /agent`:
`{name, description?, mode?, permission: [{permission, pattern, action}], override?}`.
- Config file `YGG_PROFILES=<path.json>`:
  `{"default_agent": "build", "agent": {"<name>": {description, permission: [...], override?}}}`.
  The key names follow opencode.json (`agent`, `default_agent`). Rules are the **array** form,
  which is opencode's wire/internal ruleset. The object shorthand is not accepted, because its
  key order carries meaning and serde_json without `preserve_order` drops that order. Adding
  `preserve_order` would reorder every JSON byte the root writes, which counts as a regression.
- With no `YGG_PROFILES`, there is one built-in profile `build` = `[{"*","*","allow"}]`. That is
  today's behaviour, byte for byte, in what goes upstream.
- JSON, not YAML: no new crate (serde_yaml would be a new dependency in a harness-thin root).

### D2. Matching semantics (opencode's)
- The tool's permission name: `write`, `edit` → `edit`. Every other tool uses its own name.
  Rule `permission` and `pattern` are wildcards: `*` = any run of characters (including `/`),
  `?` = one character, the whole string is anchored. Following opencode, a pattern ending
  in ` *` also matches the bare command (`git *` matches `git`).
- **Last matching rule wins.** No match → `ask`.
- `ask` → **denied** with a distinct message ("needs approval; the root has no approval channel").
  The root never blocks waiting on a human (contract §2: it waits on nothing but its own run).
- Subjects (the string a rule's `pattern` is matched against):
  | tool | subject |
  |---|---|
  | read / write / edit | file path, lexically normalized (`..` resolved). Relative to the project dir when inside it, absolute when outside |
  | glob / grep | the `pattern` argument |
  | webfetch | the URL |
  | todowrite | `*` |
  | bash | **each simple command**: the command is split on unquoted `;` `&&` `||` `|` `&` and newline, and `$(…)` / backtick / `<(…)` bodies are added as extra commands. Every command must be allowed |
- Two derived checks, both opencode permission names:
  - `external_directory` (path tools only): a path outside the project dir must ALSO pass
    `external_directory` with its absolute path.
  - Unquoted output redirection in bash (`>`, `>>`, `&>`; not `>&N`, not `/dev/null`): the target
    must ALSO pass `edit`. A shell write counts as an edit. This closes the observed drift path
    (`curl … > docs/x.md`) without banning the `>` characters inside a quoted JSON body.
- **Hidden tools** (opencode's `disabled()`): if a tool's last matching rule, considered by
  permission alone, is `{pattern:"*", action:"deny"}`, the tool is not declared upstream. If every
  tool is hidden, no `tools` key is sent, the same as `YGG_TOOLS=0`.

### D3. Selection: `POST /session {profile?}`, fixed for the session's life
- `profile` absent → the server default, stored as `info.profile`. Unknown name → **400**
  `{"error":"unknown profile X","profiles":[…]}`. The request fails closed: a session that asked
  for a narrow profile must never silently get `build`.
- `PATCH /session/:id {profile}` → **400** "profile is fixed at session creation". It is rejected
  out loud and never silently ignored. The v2 agent switch does not touch `info.profile`.
- `parentID` does not pass the parent's profile to the child. Children get their own profile
  or the default (see G1).
- Sessions created before this feature (no `info.profile`) run under the current server default.

### D4. Enforcement point: tool dispatch (`run_tool`), plus the declared list (`relay`)
One `profile.rs` module (pure, unit-tested): `Profile::check(tool, input, project_dir) ->
Decision{allowed, rule, subject}`, `visible(tool)`, `allowed_summary()`. `run_tool` calls
`check` before `tools::run`. `relay` / `relay_anthropic` send `schemas()` filtered and renamed
for the session's profile. Hidden tools are still checked at dispatch, because a model can
hallucinate a call to a tool it was never shown. The routing contract (§2.3) covers this:
the root decides what a session may route to. No wrapper tools, no new tools.

### D5. What a denied call returns to the model (explicit, so GLM adapts)
The tool part ends `status: error`, and the model reads:
```
Permission denied by profile "coordinator": bash `sed -i s/a/b/ docs/x.md` (segment `sed -i s/a/b/ docs/x.md`)
matched rule {permission:"*", pattern:"*", action:"deny"}. Do not retry this call; this session cannot do it.
Allowed in this session: read *, glob *, grep *, bash `curl *`.
```
`state.metadata.denied = {profile, permission, subject, rule}` is machine-readable for clients and
labs. An `ask` reads "needs approval (action ask) — this root has no approval channel; treat as denied".

### D6. Listing: `GET /profile`
Returns `[{name, description, mode, permission, override?, default: bool}]`, which is the
`GET /agent` element shape. `GET /agent` itself is **unchanged**. The PWA agent picker reads
it, and putting profiles there would offer a picker entry whose switch cannot change
enforcement (D3).

### D7. Surface override (unblocks surface-familiarity)
`override: {"<tool>": {"name"?: "<exposed>", "description"?: "<text>"}}` per profile. The schema
goes upstream under the exposed name, dispatch maps it back, and permissions are always written
against the canonical opencode names. The stored tool part records the name the model **called**,
so replayed history stays consistent for the model. A call to the canonical name of a renamed
tool counts as an unknown tool, and that number is the familiarity lab's metric. Profiles are
config, so a lab varies a profile by editing its own scratch file and restarting its own scratch
root (boot < 1 s).

### D8. Loading
`YGG_PROFILES` is read **once at boot**. A malformed file, an unknown action, an empty name, an
override of an unknown tool, or a default that names no profile → exit 2 (the same rule as
`YGG_CATALOG`). Rule permissions that match no tool and are not `external_directory` get a boot
warning (catches typos; opencode-only names like `doom_loop` are allowed but enforce nothing).

## 2. Gaps review (before code)

| # | Gap | Decision |
|---|---|---|
| G1 | **Can a session change its own profile?** | Through the API, no: no endpoint writes profiles, PATCH rejects `profile`, the agent switch doesn't touch it. Through the file, no: it is read at boot only, so a session that edits the file changes nothing until a human restarts the root. **The residual is stated plainly.** A profile that allows `bash curl *` to its own root can create a `build` child and drive it, which is what a coordinator is for. Profiles are a **guardrail against drift, not a sandbox against an adversary**. A profile meant to contain must not allow bash that reaches the root. `bash *` allow plus `edit` deny is porous (`sed -i`, `python -c`), the same as opencode. |
| G2 | Event-bus exposure of denials | No new event type (contract §5: one event per state change). The denial is the tool part's own `message.part.updated` (status `error`) carrying `state.metadata.denied`. `session.created` / `GET /session/:id` carry `info.profile`, so observers know the scope before any call. |
| G3 | Compaction / roll-up | The summarize call already sends no tools, so nothing changes. Denied calls replay in history as `Error: Permission denied…`, so after a compaction the model still sees why it stopped. The profile is fixed at create, so a history never holds calls to tools the profile later hides. Exceptions are pre-feature sessions after a default change, and hallucinated calls to hidden tools. **Anthropic edge:** a zero-tool profile whose model still emits a tool call stores a denied part, and the next request would carry `tool_use` with no `tools`, which the API rejects. That gets a mock test, and if it reproduces, a minimal fix: declare the hidden tool's schema only when history needs it. |
| G4 | No special-casing of the orchestrating session | The root knows nothing about which session orchestrates. The client creates that session with `profile: "coordinator"` (or any name in config). No reserved names in root code (contract review bar: no MAIN/voice/rooms strings in the root). |
| G5 | Zero regression | Default `build` = allow-all, and `schemas()` goes out unchanged (no filter applied). `verify.sh` must stay PASS. harness-bench through the scratch root must land within noise of the :4100 baselines. |
| G6 | `YGG_TOOLS=0` versus profiles | `YGG_TOOLS=0` still wins: it is global, nothing is declared, and every call is denied as "tools disabled". |
| G7 | Symlinks / `..` | Matching is on the lexical normal form only. A symlink inside the project pointing outside is not followed. Documented, the same as opencode. |
| G8 | Old sessions / restart | `info.profile` persists in the session JSON. If the config at boot no longer has that profile, the session's runs **fail closed**: blocked, with reason error and "profile X no longer configured". They never fall back to default. |

## 3. Validation plan (all simulated; :4100 / :443 / :8090 never touched)

Scratch roots run on **127.0.0.1:4121–4124**. 4101 is already bound by a uid-0 listener (most likely the sudo-run `/root/.local/bin/yggdrasil`,
pid 3021805, up since Oct 06; it answers `GET /session` with `[]`). That is the brief's port,
taken by something that isn't ours, so we leave it alone. Stores live under
`/tmp/tool-scope-store/<root>`. Upstream is the same z.ai anthropic / `glm-5.3-flash` /
`YGG_MAX_TOKENS=16384` as live, with the key read from the tool-policy lab's bare key file
(the live env file is never loaded).

- **V0 unit + mock:** `cargo test` (matcher, splitter, redirect, hidden, summary). `verify.sh`
  PASS unchanged. A new `verify-profiles.sh` (mock upstream, both dialects) covers: default
  equals today; tools declared per profile; deny path plus message plus metadata; unknown profile
  400; PATCH 400; zero-tool profile; rename round trip; arg patterns; redirect → edit; the G3
  anthropic edge.
- **V1 bench compatibility (5a):** a harness-bench adapter `yggdrasil-scratch` (base from
  `HB_YGG_BASE`, optional `HB_YGG_PROFILE`), 2 reps × 11 tasks with the default profile, rows
  to the bench ledger. Pass = every category mean within ±0.17 (one task-rep flip at n=6) of
  `hb-v1-ygg-FULL`.
- **V2 enforcement rerun (5b):** the tool-policy battery (its tasks, graders, fixtures, imported
  unchanged) on scratch roots with real profiles, variants B and C under a `coordinator` profile.
  Before = prompt-only (`lab/tool-policy/runs/results.tsv`, 412a9c4). Violations are re-graded with
  an **attributed** detector that checks the coordinator's own write/edit calls plus bash
  write-shapes, applied to both arms. Success = 0 violations enforced, with no success loss on t1/t2.
- **V3 edge cases (5c):** unknown profile, zero-tool profile (the speech-room shape), denial UX
  (does GLM adapt or retry?), arg patterns. Live GLM runs on a scratch root.
- **V4 familiarity probe (5d):** a profile renaming `bash` → `shell`, 5 voice-brevity runs,
  compared with the default-profile runs (call names, unknown-tool calls, score).

## 4. Deliverables
Branch `lab/tool-scope` (small commits) · this plan · `docs/reviews/tool-scope-report.md`
(tables plus a **deploy runbook** for :4100, the human-gated step) · bench ledger rows ·
`/tmp/sub-status.tsv`.

## 5. Addendum — what changed while building (10-28, same session)

- **D4 add:** when nothing is declared upstream (`YGG_TOOLS=0` or a no-tool profile), tool calls the
  model emits anyway are **not run and not stored** (logged). A stored call without declared tools makes
  the next anthropic request invalid (G3), and before this change `YGG_TOOLS=0` still *executed* calls.
  Mock-proven in both dialects (`verify-profiles.sh` B8).
- **D2 fix (from the first live battery):** `$((…))` is arithmetic, not a command. Bash's rule decides it:
  the inner `(` closes right before the outer `)`. Only the substitutions inside get checked. Before the
  fix, date math in a coordinator's polling loop was denied as a command `t/1000)`. That failed closed,
  but it cost legitimate work. The first B/C battery was stopped, archived under
  `lab/tool-scope/runs/aborted-1st-splitter-bug/` and rerun on the fixed binary.
  - Also from the same pass: subshell `(…)` parens are stripped, and `case` arms stay inside a
    command, so a narrow rule refuses them (fail closed).
  - A 70k-input fuzz test proves the splitter cannot panic.
- **Ports:** `verify-profiles.sh` uses 18290/14197. 14196 belongs to `scripts/root-store-backup.sh`.
- **Scratch profiles** (`lab/tool-scope/profiles.json`) were tuned from the first battery's denials:
  `read`, `curl -o /dev/null`, text filters. `python3 -c` stays denied on purpose, because it
  runs arbitrary code.
- **Deploy candidate:** `lab/yggdrasil/profiles.live.json` = `build` (default) + `coordinator` + `quiet`.
