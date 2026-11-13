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
- **Roots** (`peers.rs`): `YGG_PEERS name=url`, shared `YGG_PEER_TOKEN`. A session on another
  root is a proxy here and real there; the peer digests its own turns and POSTs
  `/tree/report` home; reading or talking to the proxy (tree tools or the phone) forwards.
  `GET /root` describes a root; the door's `[roots]` view lists them so work goes where the
  hardware fits. Transport-agnostic: tailnet, an SSH line, or the bifrost-net trunk.
- **Harness sessions**: the turn runs `claude -p` / `opencode run` / `codex exec`
  non-interactively, resuming the harness's own session (`info.harness.id`).

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
`YGG_ROOT_NOTE` · `YGG_PEERS` · `YGG_PEER_TOKEN` · `YGG_MAX_INFLIGHT` (upstream calls in flight, 6)
· `YGG_MAX_HARNESS` (3) · `YGG_DIGEST_MODEL` · `YGG_WAKE_DEBOUNCE_MS` (4000) ·
`YGG_TREE_MAX_DEPTH` / `_CHILDREN` / `_WAKES`.

## Agents (editable)

What used to be "profiles" is one concept, **agents**. Every agent runs on a harness: `root` (this brain:
model, thinking, system prompt, tools, steps, manages-sessions are all customizable) or `claude` /
`opencode` / `codex` (description + model; Claude Code also takes extra instructions via
`--append-system-prompt`). Built in: coordinator (MAIN's alone, tools locked), lead, build, fix, research,
review (read-only; writes only its report), **AGI** (Claude Code on Opus). `GET /agent/:name` is the editor's
detail (incl. `customizable`, `locked`, `models`); `PUT /agent/:name` creates or edits (partial body,
persisted to `YGG_PROFILES`, live at once); `DELETE` removes agents you made. Switching a session's agent
stamps the agent's model + thinking (+ harness); the model can be changed afterwards.

## Endpoints added

`GET /tree` · `GET /root` · `GET/PUT /shared-prompt` · `GET /extensions` · `GET /session/:id/inbox` · `POST /session/:id/close` · `GET/PUT/DELETE /agent/:name` ·
`POST /tree/report` (peer token). `POST /session` takes `agent`, `model`, `variant`,
`report_to`. `GET /agent` lists the profiles.
