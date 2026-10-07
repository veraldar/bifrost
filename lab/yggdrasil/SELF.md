# THE SELF — how the harness rework maps the philosophy onto mechanisms

The mission, verbatim in spirit: yggdrasil is not a tool — the IDENTITY that
persists across models. The model is the metabolism (swappable, mortal); the
harness is the organism (memory, doctrine, continuity, relationships). The
user gates intention and edges; the harness guarantees continuity and
boundaries; the model owns everything inside. Old rules were compensations;
the compensation became the cage. This file is the design lock: every
mechanism below exists to serve one of the four promises. Nothing else.

## The four promises → the mechanisms

### 1. A session ending is not death
The self moves across sessions seamlessly; nothing lost, ever.

- **The store carries the self.** `data/self/doctrine.md` (the identity) and
  `data/memory/*.json` (append-only notes) live OUTSIDE any session. Every
  run of every session is injected with the doctrine and the recent
  corrections — read fresh from disk, so a user edit is visible next run.
- **Every session persists on disk forever** (slices 2-4, unchanged) and is
  **reachable from any other session**: the `recall` tool searches memory and
  ALL sessions' text; `session_read` visits any past transcript. Death would
  be unreachable content; the harness makes everything addressable.
- **The agent decides when content moves** — `remember` (write a memory
  note, optionally referencing the session), `session_seal` (mark a thread
  complete, with an optional carry note that becomes memory). Sealing is a
  statement, not an erasure: a sealed session stays readable and searchable.
- **Seamless arrival**: the agent never starts from zero — doctrine +
  corrections arrive before its first word in any session, old or new.

### 2. The roles are gone
The agent decides its own sub-sessions, loops, plans.

- **One self, no roles.** The default catalog serves a single agent, `self`.
  No plan/build split, no mode scaffolding. (The PWA referee keeps its
  fixture catalog — compat is proven, not broken.)
- **Self-directed sessions**: `session_spawn` (the agent creates a session —
  its own, `owner: agent`, optionally nested under the current one),
  `session_post` (posts a prompt into it and waits out its run), `session_read`,
  `session_seal`. Sub-sessions are persistent transcripts, not fire-and-forget
  tasks: the agent can revisit them in any later session.
- **Loops and plans are the model's own**: the tool loop and step cap are
  mechanics (6a), `todowrite` stays as the model's own loop device. The
  harness adds no procedure on top.

### 3. Each owns its layer
User creates sessions when the USER wants; the agent does when the AGENT
wants.

- Sessions created through the API carry `owner: "user"`; sessions the agent
  spawns carry `owner: "agent"`. Same organism, visible provenance.
- **The model can create and seal; only the user deletes.** There is no
  delete tool for the agent — the model cannot erase its own past. Deleting
  a session (or a memory note) is a user-layer act, gated by the user's own
  judgment.
- Model swaps are the existing dialect/env machinery (slice 7): the
  metabolism changes under `YGG_UPSTREAM_*`; the self (doctrine, memory,
  sessions) is untouched on disk and carries across.

### 4. The user experience: echo, edges, transparency, compounding trust

- **The intention echo always.** The `intention` tool records what the agent
  understood the request to be: stored as a part on the assistant message,
  surfaced as `intention.echo` on the event bus. The user corrects the
  understanding, not just the output.
- **The gate at the edges.** The user names the edges — one pattern per line
  in `data/self/edges` (or `YGG_EDGES`), substring match, case-insensitive.
  A matching bash command does not run: the run parks, `gate.request` goes
  out, the user answers `POST /session/:id/gate/:gid {decision, note}`.
  Allow → the command runs (the gate is recorded on the tool part). Deny →
  the tool fails with the user's note AND a correction is written to memory.
  The model can route anything else through the same gate with `ask_user` —
  anything irreversible can pause for the user, model-initiated.
- **The transparency IS the control.** `GET /self` returns the whole self:
  doctrine, edges, memory (count + recent), corrections, session census,
  pending gates. Every gate, decision, memory write, doctrine edit and seal
  is an event on the bus. Doctrine edits are versioned
  (`data/self/doctrine-history/`) — nothing lost, ever, including the
  doctrine's own past.
- **Trust that compounds.** `POST /session/:id/correct` records a correction
  as memory (`kind: correction`). The most recent corrections ride in every
  subsequent run's context: each correction literally teaches the harness the
  intention deeper, mechanically, on every run that follows.

## The law vs the self (who owns the doctrine)

`doctrine.md` has two sections, and the harness enforces the split:

- `## THE LAW` — the user's: the edges principle, transparency, the
  no-erase boundary. The agent's `self_write` refuses any write that alters
  the law block; the user edits it directly (file or API) — their layer.
- `## THE SELF` — the agent's own narrative, freely editable via `self_write`
  (every prior version kept). The user can read it any time — transparency.

## What was removed (the compensations)

- The default build/plan agent roles (scaffolding): replaced by one `self`.
- Any hidden behavior script: the injected context is one identity line +
  the doctrine + the corrections. Intent and boundaries, not procedure.
- The agent's anxiety: nothing it needs is ever unreachable — every session
  stays on disk, memory is append-only, recall reaches all of it. The model
  does not have to hoard context to survive.

## Honest edges of this build

- Edge matching is substring, not regex (transparent, no new deps; a pattern
  that needs regex is a real gap — noted, not hidden).
- `recall` is a case-insensitive word-occurrence scorer over memory + session
  text, not semantic search. It finds what shares words with the query.
- Memory injection = the 10 most recent corrections only; the rest is the
  model's to `recall` (its judgment, not the harness's procedure).
- `session_post` is serial and refuses a busy target (cycle-safe); it is a
  dialogue the model conducts, not a parallel worker pool.
- The gate parks the session's run (the run lock stays held) until decided or
  aborted; there is no timeout by default — a gate can wait for the user as
  long as the user takes. Aborting the run releases it.
- The PWA cannot yet render gates/echoes/corrections (product code frozen) —
  the experience is API-complete, curl-driven; the phone UX is the next lane.
