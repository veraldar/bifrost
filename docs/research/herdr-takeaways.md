# herdr takeaways + field-watch proposal (10-22)

Source: cloned `herdrdev/herdr` (Rust, ~12k lines in `crates/` + large `src/`,
vendored ghostty-vt/pty), read README, AGENTS.md, socket-api/agent-skill docs,
`events.rs`, `handoff_runtime.rs`, `agent_resume.rs`, `detect/`, `server/`.
Context: delivered right after `docs/reviews/root-coordination-design.md` —
this doc reads herdr against that design.

## 0. What herdr actually is (correction to the brief)

The brief said "fast router + specialist agents in group-chat style." The repo
says otherwise: **herdr is a terminal multiplexer for coding agents** — "the
runtime your coding agents live on." It owns panes running claude code, codex,
opencode etc., keeps them alive across detach/SSH loss/server restarts, and —
the part that matters to us — makes their state visible and drivable:
every pane is marked **working / blocked / idle**, and an agent-native socket
API lets agents spawn panes, prompt each other, and wait on each other. No
router LLM, no group chat, no model routing. It orchestrates *terminals*, and
lets the humans/agents do the talking. The lessons below survive the
correction — several get *stronger*, because this is a shipped product solving
the follow/status problem we just designed around.

## 1. TAKE — for the root (yggdrasil) and bifrost

1. **The blocked/working/idle triad as harness-owned state.** Herdr's killer
   UX is "never hunt for the stuck one — when an agent stops and needs an
   answer, herdr says so." Our busy map is binary (busy/idle). Adopt the triad:
   `busy` → `idle` (done) / `blocked` (needs input or stuck) as distinct
   terminal states. This is exactly the `task.blocked` event in our design —
   herdr proves it's the coordination feature users feel, not plumbing.
2. **Authority layering for status: declared > detected.** Herdr's detection
   docs are explicit: PTY activity is the normal *working* authority; visible
   screen chrome is diagnostic; integrations can *report* state authoritatively
   (`pane.report_agent`). Take the layering, not the scraping: our run loop
   *declares* status (authoritative), and a cheap idle/blocked detector is the
   fallback for crashed or silent sessions. Never let a heuristic override a
   declaration.
3. **Atomic prompt+wait with refusal-on-blocked.** `agent.prompt` accepts
   `wait: {until, timeout_ms}` in one request ("avoiding a race between
   separate calls") and returns `agent_blocked` *without sending input* if the
   target is already blocked. Direct lesson for our dispatcher/relay: turn
   submission and its wait bookkeeping should be one atomic operation, and
   driving a blocked session should fail fast with a typed error — not queue
   silently into ambiguity.
4. **Identity-pinned waits.** `agent.wait` is server-owned and "pins the
   resolved pane occupant so a replacement cannot satisfy the wait." We have
   already bled on exactly this class of bug (four yggdrasil copies stealing
   dispatches; the bifrost→bifrost-live rename stranding the voice agent).
   Rule for the relay: a queued turn or completion-relay pins **session id +
   incarnation**, never name; a replaced session invalidates outstanding waits.
5. **The handoff boundary, written down.** `HandoffRuntimeState` preserves
   durable session state (PTYs, agent identity, history) and *intentionally
   drops* "transient coordination such as in-flight requests, waits,
   subscriptions, client sockets, or pane-to-pane messages; clients reconnect
   and retry." Adopt verbatim as a yggdrasil restart rule: sessions persist,
   coordination-in-flight does not, clients retry. One sentence, saves a class
   of split-brain bugs when the bridge/server-replacement work lands (v0.8).
6. **Resume plans.** `agent_resume.rs`: an agent reports its own resume command
   (kind id/path, argv, dedupe key); the harness reruns it on restore. For us:
   sub-sessions record re-entry metadata (session id, model, agent, cwd,
   artifacts path) so a root restart re-attaches instead of orphaning work —
   cheap addition to the `parent` schema change, matters at the 24h-stability
   bar and for every deploy.
7. **Schema-first surface.** `herdr api schema` prints the full JSON Schema —
   requests, responses, errors, events, subscriptions — bundled with the
   binary. yggdrasil is opencode-shaped and introspectable-ish; publishing a
   real schema (or at minimum a versioned event catalog) makes the socket API
   integrable by the PWA, future bridges, and agents without reading Rust.
8. **Three layers, one control surface.** Agent skill < CLI wrappers < raw
   socket API, explicitly documented, "the layers share the same control
   surface." Mirror it: spawn/relay/status should exist as an LLM tool, a
   REST-ish script surface, and the raw API — same semantics, documented once,
   no drift.
9. **The env-vouchered skill gate.** Herdr's skill activates only under
   `HERDR_ENV=1` ("otherwise stop and say you are not inside a herdr pane").
   Env is spoofable by a bash-capable session, so it's hygiene, not security —
   but as a marker on spawned sub-sessions (`YGG_SUB=1`, parent id) it gives
   sub-only tooling a cheap guardrail and stray sessions no pretext.
10. **PWA/deck UX: status chips.** The session list should show the herd at a
    glance — working/blocked/idle chips, blocked pulses or notifies. Directly
    actionable in the phone deck; herdr's demo video is the usability proof.
11. **(Meta) their AGENTS.md is a model for ours.** Layered scope (universal /
    maintainer / local-machine / external-contributor), *verification
    conditions* for identity ("treat as verified maintainer only when…"), and
    evidence rules ("capture the relevant state with `agent read` before
    changing detection manifests; decide from captured evidence"). This is the
    best rules-distribution doc I've seen in the wild — directly relevant to
    the fleet constitution work; steal the structure.

## 2. AVOID

1. **Screen-scraping as the primary substrate.** Herdr parses pane content
   because it must manage third-party CLIs it cannot modify — manifests,
   update machinery, even a detection eval suite (`agent_view_eval.rs`). We own
   the harness: state comes from the run loop, typed and structured. Their
   scraping is a constraint of their position, not a pattern; importing it
   means importing the whole manifest/eval apparatus.
2. **Sibling-to-sibling prompting.** Herdr lets agents prompt each other's
   panes as peers. Fine under a human watching a screen; wrong for our voice
   loop — it's the relay-loop risk our design already caps (terminal events
   only, depth ≤ 1). Coordination stays main-mediated; other agents are
   addressed through the main, like the delegate skill does today.
3. **Process/PTY ownership machinery.** Detach-persistence, PTY handoff,
   layout restore — herdr's product weight exists because terminals are
   external processes. Our sub-sessions are in-process sessions behind one
   dispatcher; we have no terminal lifecycle and should never grow one.
4. **TUI-first assumptions.** Keyboard/mouse/worktrees/panes are herdr's
   surface. Ours is a phone deck + voice. Take the state model and the API
   discipline, none of the interaction model.

## 3. Compare vs our design (`root-coordination-design.md`)

| our design | herdr's answer | verdict |
|---|---|---|
| `task.blocked` as a first-class event → phone notification | blocked/idle/working triad, notification on blocked | **validated, shipped** — adopt triad in state map |
| status events from the run loop | declared-state-over-detection authority layering | validated; add cheap detector only as fallback |
| events → queued turns via dispatcher | atomic `prompt+wait`, refusal-on-blocked | adopt atomicity + typed refusal in the relay |
| relay pins session identity | `agent.wait` pins the occupant, replacements can't satisfy | adopt: pin id + incarnation (we've had this bug class) |
| session persistence, multi-day re-entry | resume plans + handoff boundary (durable ≠ transient) | adopt boundary sentence + resume metadata |
| artifact-shaped results | n/a — herdr reads panes | ours is stronger for cross-root (they can't do it) |
| main-mediated, depth ≤ 1 | peer prompting allowed | keep our cap; their model fits supervised TUIs, not voice |
| schema/REST surface for integration | `api schema` + three-layer ladder | adopt schema-first + same-surface discipline |

Net: herdr independently converged on our core claims (status is the product,
the harness owns truth, coordination primitives stay tiny: prompt/wait/read)
and adds refinements we lacked (atomicity, pinning, handoff boundary, resume
plans). Where it differs — scraping, peer chatter, PTY ownership — its
constraints are not ours. **Our design survives contact; amend it with §1.1–6.**

## 4. FIELD-WATCH — second question: do we R&D on the field? Inventory + proposal

**What exists:**
- `[LAB] research-feed` (docs/research/research-feed.md): weekly arXiv scans,
  7 locked queries, receipts JSON, A/B grading, playbook deltas. **Papers
  only.** Working and disciplined.
- Point-in-time docs (anthropic-lock-in, tailscale, mini-agi-report): ad-hoc,
  user- or incident-triggered. This herdr study itself was a user-directed
  one-off — the proof of the gap: herdr shipped blocked-triads + atomic
  prompt+wait while we were designing coordination, and we learned of it by
  hand.
- Nothing watches repos/tools/frameworks. Worse: connectors were "demoted to
  evidence-triggered (09-28)" — with no scanner to generate the evidence.

**Proposal — `[LAB] field-watch`:**
- **Cadence: monthly** deep pass (repos move slower than arXiv; weekly is
  noise + token burn) **+ a cheap release-radar skim** in the same run (GitHub
  releases Atom feeds per pinned repo — no API cost, no auth at this rate).
- **Watchlist v1, versioned like the arXiv pool, ~12 pins, grouped:**
  *harnesses*: opencode (upstream — watch `parent`/task semantics first),
  claude-code, codex, herdr, vibe-kanban · *voice*: pipecat, livekit/
  livekit-agents, speaches, mlx-audio · *protocols/sdks*: MCP spec, OpenAI
  Agents SDK, Anthropic Agent SDK. Pin = repo + last-seen release + commit;
  the pin block is the diff base next pass.
- **Method per pass:** release/tag/commit delta since pin → CHANGELOG diff →
  classify each notable item **T** (take: a pattern/arch to steal),
  **A** (avoid: a lesson/warning), **N** (note) — each ending with
  "drives: product / lab / playbook / none." Same receipt discipline as the
  research feed: one dated PASS section in the ledger +
  `field-watch-index-<date>.json`; rules change only where an item upgrades one.
- **Output & readers:** ledger at `docs/research/field-watch.md`; the digest
  flows to the coordinator as an artifact like any other; the user reads the
  T/A lines; a T or A item becomes a candidate lab slice through the normal
  playbook — and the connector-demotion rule finally gets its evidence
  generator.
- **Cost:** one session/month, unauthenticated-rate GitHub fetches
  (no-pay-raw-API ✓), receipts like the arXiv feed.

This study becomes field-watch's seed pass: herdr is its first receipt, and
the §1 adoptions are its first "drives: product" line.
