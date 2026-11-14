# root-coord — one door, a tree of sessions, several roots

*11-12. The root (yggdrasil) becomes a tree of sessions behind one door. Code: `src/profiles.rs`,
`src/tree.rs`, `src/peers.rs`, `src/harness.rs` + hooks in `main.rs`. Tests: `cargo test`,
`sim/tree-e2e.py` (deterministic), `sim/hsim.py` (human simulation).*

## The model

```
you ⇄ [MAIN] coordinator            the transcript you read: only you + MAIN
          │  [tree] view + [inbox] lines ride MAIN's turns (frozen, cache-safe)
          ├─ lead "kvstore"           owns a project, splits it, loops until green
          │    ├─ build "lib"         reports go UP to their parent's INBOX,
          │    └─ build "server"      never into anyone's transcript
          ├─ research "rate limits"
          ├─ claude-code "slugify"    a harness session: Claude Code / opencode / Codex
          └─ build "sales" on lab     a session on another root (proxy here, real there)
```

- **Agent = what a session is**: role prompt (+ a short one for lite models), tool permissions
  (opencode ruleset, enforced at dispatch), model, thinking level, step cap, fold, `sessions`
  (manages others), `harness`. Built in: coordinator · lead · build · fix · research · review · AGI.
  `YGG_PROFILES` overlays fields and adds agents. Model and thinking: the agent's default, the
  session's explicit choice wins, stamped at creation (the agent too — the list shows `[BUI]`, `[FIX]`…).
- **One shared prompt, stored once**: every agent reads the same shared system prompt first — the
  yggdrasil preamble + "re-interpret the user's intent before you do what you are asked"
  (`profiles::default_shared`). It lives once, as `shared_prompt` in the agents file, edited from the
  agents page (`GET/PUT /shared-prompt`, empty = default); each agent's prompt holds only its own role
  (owner 11-13: no per-model variants, nothing repeated per agent). Claude Code agents get it appended
  with their instructions. A model marked `id:lite` still reads the short role + lean tools.
  `GET /agent/:name` returns `system`: everything the model reads.
- **Card** (`info.card`): topic, brief, status, headline, summary, needs. Rewritten after every
  turn by a one-shot **digest** call (no session, no history); facts override the model (a failed
  run is failed, `QUESTION:` is blocked, running sub-sessions mean working, an outcome is never
  routine).
- **Inbox** (`Session.inbox`): the digest's event goes to the parent. A lead is **woken** with
  the reports and keeps looping. The door is woken (debounced) only for what matters and comes
  back to you; `(quiet)` replies are hidden. Everything else rides your next turn as
  `[inbox since your last turn]`. Automation posting to MAIN (watcher, lanes) lands here too.
- **Tree tools** (managing profiles): `sessions_find`, `session_start` (+ `root`),
  `session_send`, `session_read`, `session_close`. Guards: depth 12, 24 open children, 60 wakes.
- **Roots** (`peers.rs`): `YGG_PEERS name=url`, shared `YGG_PEER_TOKEN`. A hub brain can also
  learn its peers from the trunk: with `YGG_PEERS_FROM=http://127.0.0.1:<bridge>/_roots`, every
  linked root becomes a peer named by its id, reached at `YGG_PEERS_VIA` (default `…/_root/{id}`).
  Static entries win a name clash, and a root that unlinks stays listed as unreachable. A session on another
  root is a proxy here and real there; the peer digests its own turns and POSTs
  `/tree/report` home; reading or talking to the proxy (tree tools or the phone) forwards.
  `GET /root` describes a root; the door's `[roots]` view lists them so work goes where the
  hardware fits. Transport-agnostic: tailnet, an SSH line, or the bifrost-net trunk.
- **Harness sessions**: the turn runs `claude -p` / `opencode run` / `codex exec` / `agy`
  non-interactively, resuming the harness's own session (`info.harness.id`).

## Continue a Claude Code session from the phone (11-13)

`GET /harness/claude/sessions` lists the newest 20 Claude Code sessions on this box
(`~/.claude/projects/*/*.jsonl`, or `$CLAUDE_CONFIG_DIR`): `{id, cwd, modified, title}` — read from
metadata lines only (the transcript's `cwd`; custom-title › newest ai-title › summary › the first line
the owner typed, ≤80 chars, never tool output). `POST /session {agent:"AGI", harness:{id}, cwd}`
attaches one: the agent must run on Claude Code, the id must be a uuid, `cwd` must exist on this root
and `~/.claude/projects/<cwd mangled>/<id>.jsonl` must be there — else 400 saying which. The session is
`info.harness = {kind:"claude", id, attached:true}` + `info.cwd`, titled "<title, 40> · Claude Code".

Its turns (`harness.rs` `Attach`): the first is `claude -p --resume <id> --fork-session`, so the
terminal's transcript is never written; the fork's id replaces `harness.id` (`forked:true`,
`origin:<id>`) and later turns `--resume` the fork. An attached session ALWAYS runs
`--permission-mode auto`, never `--dangerously-skip-permissions` — the owner's guard stays on when a
guarded conversation continues from the phone. Sessions the brain started itself are unchanged.
Phone: + new session → "continue a Claude Code session…" → tap one → an [AGI] session.

## Antigravity — Google's harness (11-14)

Google replaced Gemini CLI with **Antigravity CLI** (`agy`); since 2026-06-18 Gemini CLI no longer
serves personal accounts, so it is gone as a harness. An agent runs on `antigravity` like on
`claude` / `codex` (agent editor → runs on → Antigravity; no built-in agent). An agent or session
saved on `gemini` loads as `antigravity` (its model kept only if agy runs it; a Gemini CLI session id
is dropped, so the next turn starts a new agy conversation).

**Turn** (verified with agy 1.5.9): `agy --input-format stream-json --output-format stream-json
--dangerously-skip-permissions [--model m] [--conversation <id>]`, cwd = the session's folder (agy's
workspace; it reads AGENTS.md/GEMINI.md walking up from there). The prompt goes on stdin as ONE NDJSON
line `{"event":"user","message":{"content":…}}` — never argv, any length. agy has no system-prompt
flag: the shared prompt + the agent's instructions open the conversation's first message
(`<instructions>…</instructions>`); resumed turns send the prompt alone. Stream: `{event, <event>:{…}}`
lines — init (conversation_id) · step_update (agent_response `text_delta` chunks → streamed and
joined; tool steps ACTIVE then DONE/ERROR → one tool part with `tool_info` parameters + output or
error) · result (SUCCESS → `response`; any other status → the error). An unknown `--conversation`
id only warns and starts a new conversation. Every shape is REAL output in `fixtures/antigravity/`.

**Models**: `agy models` (`slug<TAB>label`) at startup, merged with a built-in floor of Google's
current models (aistudio.google.com/docs/models, 11-14) — the picker reads `default` (agy's own
pick) · gemini-4-carbon · gemini-4-argon · gemini-4-hydrogen · gemini-3.8-flash (+ agy's -high /
-medium / -low) · gemini-3.6-flash · then agy's other models (on the owner's Google sign-in 11-14:
Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B). The Google sign-in serves only Gemini 3.8 Flash of
Google's own: the Gemini 4 models and 3.6 Flash are labelled "needs GEMINI_API_KEY", and picking one
fails with "Antigravity does not offer … on this sign-in". gemini-3.5-flash-lite and the
gemini-flash-latest alias are not offered: agy 1.5.9 refuses them on either sign-in.

**Install** (no sudo; the owner did it 11-14): Antigravity CLI 1.5.9 at `~/.local/bin/agy`, which is
on the systemd --user PATH (`systemctl --user show-environment`) — units started with
`systemd-run --user` find it. A sandboxed brain (ProtectHome=tmpfs: `sim/brain-up.sh` with
SIM_HARNESS=1 binds them; the preview's `preview-up.sh` does not yet) needs `~/.local/bin/agy` and
`~/.gemini` bound in. There (11-14) turns ran signed in, but `agy models` answered "Please sign in"
(ProtectHome also hides /run/user, the keyring's D-Bus socket), so the picker showed the floor only.
agy updates itself in the background (`AGY_CLI_DISABLE_AUTO_UPDATE=1` stops that).

**Sign-in** — until then every turn ends with the session error "Antigravity is not signed in — …":
1. a one-time Google sign-in: run `agy` in a terminal and sign in with Google. agy keeps the token in
   the desktop keyring (Secret Service — gnome-keyring here — over the user's D-Bus session bus), so a brain unit with
   `DBUS_SESSION_BUS_ADDRESS` (every `systemd-run --user` unit) shares it; or
2. an API key: a `GEMINI_API_KEY=<key>` line in the brain's environment, then restart the brain. agy
   reads the key only with `modelProvider: "gemini"`, so the brain adds
   `--settings {"modelProvider":"gemini"}` to every turn while the key is set (seen against a fake API:
   the request goes to `/v1beta/models/<model>:streamGenerateContent`). On the key, agy serves the
   Gemini 4 models; a key Google refuses ends the turn with "Google refused the GEMINI_API_KEY…".

## Extensions (outside the core)

Heavier capabilities run as their own processes behind one small interface (`src/ext.rs`,
`extensions/README.md`): `YGG_EXTENSIONS name=url`, `GET /manifest` → tools (+ an optional prompt
line for every agent), `POST /call/<tool>`. Agents see `<extension>_<tool>`; a `self`-scoped tool is
for every agent, a `world`-scoped one only where an agent's rules allow it. First one: the
**librarian** (`extensions/librarian/`) — full-text index of every session + artifacts, keywords,
facts per topic: `search`, `recent`, `remember`, `recall`.

Every newest turn also tells the session its own size: `[context ≈ 43k tokens · rolls up at 200k]`,
next to the clock header's gap since the last user turn.

## What changed for every session (the 11-09 regression)

The AGENTS.md chain is back (OG-ctx). The "fewest words" preamble and the brain-wide voice
prompt + 60-word cut are gone: speech shaping applies to voice turns only. Folding is the
door's alone. Thinking `off` is sent explicitly (GLM thinks by default). Rate-limit 429s back
off instead of killing a run; an empty step (thinking ate the token cap) retries once with
thinking off.

## Behaviour notes

- Dispatch answers `STARTED/SENT, NOT DONE YET`; the door reserves "done" for confirmed reports and never
  contradicts the live `[tree]` (`running` = still working).
- `session_close` refuses a running family unless `cancel=true`; the door never closes to tidy up.
- A door wake that carries an outcome (done / failed / blocked) does not offer `(quiet)`, and a `(quiet)`
  answer to one is retried once (11-13: a MAIN with a run of quiet replies in its history drifted into it).
- Bugs go to `fix` (reproduce → root cause → smallest fix → a test that catches it; never weaken a test);
  the phone's "fix this" starts a `fix` session. Reports for the user land in `YGG_ARTIFACTS_DIR` and
  reach the phone as `[name](/api/artifact/<name>)`.
- The door has no bash: it no longer launches `agi-run` lanes itself. Heavy coding goes to a `claude-code`
  session (the visible, reporting successor of a sonnet lane) or a `lead`. Lanes started elsewhere still
  land in MAIN's inbox through the watcher.

## Env

`YGG_MODELS` (`id[:lite]`, comma list) · `YGG_EXTENSIONS` (`name=url`) · `YGG_EXT_TOKEN` · `YGG_ROLLUP_TOKENS` (200000) · `YGG_VISION_MODELS` · `YGG_ARTIFACTS_DIR` (review's only write) · `YGG_PROFILES` · `YGG_CONTEXT_FILES` · `YGG_ROOT_NAME` ·
`YGG_ROOT_NOTE` · `YGG_PEERS` · `YGG_PEERS_FROM` · `YGG_PEERS_VIA` · `YGG_PEER_TOKEN` · `YGG_MAX_INFLIGHT` (upstream calls in flight, 6)
· `YGG_MAX_HARNESS` (3) · `YGG_DIGEST_MODEL` · `YGG_WAKE_DEBOUNCE_MS` (4000) ·
`YGG_TREE_MAX_DEPTH` / `_CHILDREN` / `_WAKES`.

## Agents (editable)

What used to be "profiles" is one concept, **agents**. Every agent runs on a harness: `root` (this brain:
model, thinking, system prompt, tools, steps, manages-sessions are all customizable) or `claude` /
`opencode` / `codex` / `antigravity` (description + model; Claude Code also takes extra instructions via
`--append-system-prompt`; Antigravity reads the shared prompt on its first message). Built in: coordinator (MAIN's alone, tools locked), lead, build, fix, research,
review (read-only; writes only its report), **AGI** (Claude Code on Opus). `GET /agent/:name` is the editor's
detail (incl. `customizable`, `locked`, `models`); `PUT /agent/:name` creates or edits (partial body,
persisted to `YGG_PROFILES`, live at once); `DELETE` removes agents you made. Switching a session's agent
stamps the agent's model + thinking (+ harness); the model can be changed afterwards.

## Endpoints added

`GET /tree` · `GET /root` · `GET /harness/claude/sessions` · `GET/PUT /shared-prompt` · `GET /extensions` · `GET /session/:id/inbox` · `POST /session/:id/close` · `GET/PUT/DELETE /agent/:name` ·
`POST /tree/report` (peer token). `POST /session` takes `agent`, `model`, `variant`,
`report_to`, and `harness:{id}` + `cwd` (continue a Claude Code session). `GET /agent` lists the profiles.
