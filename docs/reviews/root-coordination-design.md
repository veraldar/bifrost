# Root coordination design — proposal (10-22, third pass; no prior design assumed)

Every claim below traces to the repo. Evidence base:
- `lab/yggdrasil/LIFE.md` — **the usage audit already exists**: 178 sessions,
  9,892 messages, 36k parts measured from the opencode DB (10-03).
- `skills/delegate/SKILL.md` — the coordination contract in production prose.
- `main.rs` (1,139 ln) — global SSE bus, busy map, per-session run serialization,
  model/agent catalog + per-session switches, artifacts dir; no `parent`, no spawn.
- `rollup.rs` — 148k-token marathons are real; compaction is load-bearing.
- `docs/plan.md` — v0.7 gate (items 5–8: session lifecycle, dispatcher with queued
  turns); memory federation decided 10-06 (per-root wells + small grove layer);
  connectors demoted to evidence-triggered; dreaming spec'd, starts post-v1.0.

## 1. "Has anyone checked how and when we use what?" — yes. Here is what it says

LIFE.md's measured patterns, and what each does to a coordination design:

1. **Delegation exists but is rare**: 10 child sessions via `task` in 178 sessions
   (~6%). Coordination is the exception path, not the norm. Consequence: machinery
   must be **one tool call away with zero ceremony**, and must cost nothing
   (context, latency, tokens) when unused. An always-on supervisor optimizes the 6%
   and taxes the 94%.
2. **The life is an agent loop, not chat** (8,749 tool parts vs 5,151 text; bash 60%).
   Sub-sessions will be *workers*, not chat partners → briefs must carry repo,
   branch, constraints; results come back as artifacts and reports.
3. **Voice-first, short-prompt/long-run** (~8.7 user turns/session; latency target
   < 2 s). The main's side of every spawn must be instant — the user is standing
   there with a phone.
4. **Marathons are the norm** (p90 = 130 msgs, max 8.3 days). A single session
   mixing talk + deep work is what roll-up exists to survive; splitting work into
   sub-sessions attacks the cause, not the symptom — each sub starts fresh, and the
   main's context stays small enough that roll-up almost never fires for talk.
5. **Thinking/flash models are already the default here** (5,356 reasoning parts,
   glm-5.3-flash variants). The "fast low-temp main" is not a proposal — it is the
   current house reality, to be preserved and named in config.
6. **Multi-day persistence**: sub-sessions must be disk-backed sessions like any
   other (they already would be — same store), re-enterable days later.

And the second half of the audit: **how do WE coordinate today, in practice?**
`skills/delegate/SKILL.md` — claude/codex CLIs as sub-tools of the main. Its rules
are a working contract, earned in use: self-contained briefs (the sub can't see the
conversation), background runs with file-polling for long tasks, report who did
what, never send secrets, never let a sub push/commit/deploy without an explicit
user instruction. Any new machinery must preserve these properties or explain why
it improves on them. Note what the skill's "poll the output file" already is: the
**pull** pattern, done by hand. The design's job is to mechanize the parts that
burn main turns (polling, relaying) and keep the parts that work (briefs,
attribution).

## 2. Survey — one main session elsewhere, and when each pattern wins

| Harness | Choose | Follow | Model placement | Wins when |
|---|---|---|---|---|
| Claude Code (Task) | main LLM picks named agent | blocking; result = tool result; SubagentStop/Stop hooks | per-agent `model:` field | unattended coding; short strict tasks; one voice |
| OpenAI Swarm/Agents | handoff() function | control transfers, no return path | per-agent client | "start a fresh conversation" is genuinely wanted |
| LangGraph supervisor | supervisor node routes | shared state + checkpointer (pull) | per-node config | workflows are graphs; determinism and resume matter |
| AutoGen | speaker-selection LLM | everyone sees everything | per-agent | small debates; terrible for delegation trees |
| opencode (our ancestor) | the human routes | human reads sessions/todos | per-session switch | human present and willing |
| our own delegate skill | main LLM, prose contract | background + poll output file | whatever the CLI's user-auth is | one-off second opinions; already proven here |

Extraction: **blocking** wins when nobody waits on the main; **handoff** wins when
context must not return; **pull** wins when a supervisor (human or loop) drives;
**events** win only for processes that can listen — which an LLM mid-conversation
is not. Claude Code is the closest match to our shape (one main, one voice, spawn
on demand) and its lesson is precise: the main never watches streams; results
arrive as if they were tool output. Our voice loop makes the blocking part
unacceptable, so: **spawn like Claude Code, return like its tool result — but
async.**

## 3. The proposal — choose, follow, spawn, AGI, other roots

**Choose.** The main LLM classifies intent implicitly (a good model with a tiny
tool surface routes better than a code classifier and keeps the light prompt).
The *policy* around the choice is config + code, never prompt: role→model map in
`yggdrasil.env`, depth cap, registry, and the spawn tool's signature carrying
`role`. Routing = model's judgment inside harness-enforced rails.

**Follow — the answer to events/hooks/pull.** All three, each in its lane:
- **Hooks (harness-side, from the existing bus):** deterministic code subscribes to
  `session.status idle` / terminal events from sub-sessions. The LLM never
  subscribes — it can only think when given a turn (run serialization already
  guarantees one run per session).
- **Events → queued turns (the relay):** the harness converts a sub-session's
  terminal event into a **queued turn for the main** via the dispatcher that gate
  item 8 is already building for phone turns. Same mechanism, second producer.
  The main experiences "the sub finished" as a message arriving — the same UX as
  Claude Code's tool result, without blocking the voice.
- **Pull (main-side, on demand):** "how's it going?" → the main fetches the sub's
  stored todo list + artifacts. No new protocol: todos and artifacts exist; subs
  just keep todos current. The delegate skill's "keep the user posted" becomes a
  fetch instead of a poll loop.

**Spawn.** `spawn_session(topic, brief, role?) → {session_id, artifacts_path}`:
sets `parent` on the new session (the one schema change everything needs), sets
model by role config unless an explicit model was given, posts the brief as the
opening queued turn (dispatcher drives it — no client needed), returns
immediately. Brief discipline inherited from the delegate skill: self-contained,
no secrets, state the "checkable done". Depth capped at 1 (subs don't spawn) until
usage proves grandchildren exist outside speculation — same bar that demoted
connectors.

**AGI calls (escalation).** Already practiced in prose (AGENTS.md: escalate to a
stronger model with a written brief). Mechanize as-is: `role: "strong"` +
the existing brief contract (source-of-truth, locked decisions, referee,
territory). No new concept; the escalation log line is free telemetry.

**Other roots.** Today: the delegate skill already treats other harnesses as
sub-tools (claude/codex on this box). Design the seam, don't build the road: make
all sub-session results **artifact-shaped** (files + short report), because
artifacts are location-transparent — when the bridge lands (v0.8), cross-root
delegation moves files over the same interface, and the grove layer (decided
10-06) carries presence: which root exists, what it can do, how to reach it. The
tv test ("put it on the tv" and another machine acts) is literally cross-root
delegation — it arrives last on purpose, on top of artifacts + bridge + grove.
Until then: one root, one tree; no LLM-to-LLM chatter across roots ever — only
artifact exchange with attribution ("say who did what", per the skill).

**Hard line (STABLE rule 7):** MAIN is never a sub-session and never enters any
auto-coordination registry.

## 4. Model strategy — resolving "fast main + topic models" vs "choices under the main", with user choice above all

Three resolution rules, in priority order:

1. **User choice is law at every level.** The catalog only holds user-keyed
   providers; per-session switches exist today; an explicit "use X" from the user
   routes verbatim to whatever session they mean. Code contains no model names —
   GLM 5.3 fast is the current *config answer*, not a code assumption. The
   session records what served each message; reports name the model (attribution
   law).
2. **Fast main, because the evidence already chose it.** Latency war (< 2 s
   round-trip), voice-first usage, and the fact that the house default is already
   a flash-class thinking model (LIFE pattern 5). The main is the user's fast
   model, low temp, tiny context — routing and relay only. If it catches itself
   working, it spawns.
3. **Choices live under the main in the sub-sessions — but by role with a strong
   default, not per-topic specialists.** The specialist zoo (coder model, research
   model, vision model, each topic its own) adds routing-failure modes before
   usage justifies them; in-house evidence runs the other way: weak models loop,
   which is why the escalation rule exists, and connectors were demoted until
   demand was demonstrated. So: default every work sub-session to the strongest
   available model; define roles (`research` → long-context, `vision` → vision,
   `strong` → escalation) as **opt-in config entries created when the data shows
   the need** — the digest tells us when a role has earned its model.

Net: "fast low-temp main + differentiated subs" is correct, but the
differentiation starts at one bit (talk vs strong) and grows only on evidence.
no-pay-raw-API holds: sub-sessions spend through the same user-keyed upstreams,
same plan, no new spend path.

## 5. Auto-evolution — yes, staged; it graduates into "dreaming"

The user already owns the destination concept: `docs/spec-dream.md` (nightly
memory consolidation + self-organizing behavior, scheduled post-v1.0 at D1).
Coordination self-improvement should be built as its first customer, not as a
parallel mechanism:

- **v0.7.x — log.** One JSON line per spawn: intent, role, model, duration,
  outcome (done/blocked/user-corrected), escalation rate. Zero behavior change.
- **v0.8 — shadow.** Nightly job replays the log under *alternative* role→model
  mappings, writes `docs/lab/routing-shadow.md`. A falsifiable record: do better
  mappings even exist? No behavior change.
- **v0.8→v1.0 — propose.** If shadow shows a stable win, it emits a proposed
  `yggdrasil.env` diff. **A human applies it.** Rationale is the 10-06 incident
  class (two brains deciding = split-brain) and STABLE rule 8 (safety in harness,
  not prose): routing *config* is where evolution lives; routing *code* and
  *prompts* are not self-editable.
- **post-v1.0 — apply, inside dreaming.** Auto-apply only for the role→model
  class, flag-gated, canary on one role, never MAIN, rollback = revert one env
  line — gated exactly like the watchdog's return (user go + receipts), and only
  if shadow data showed weeks-stable mappings. If the mappings keep changing,
  auto-apply would automate churn, not improvement.

## 6. The v0.7 reflection audit — how much of this exists today

| design element | in v0.7 today? | evidence |
|---|---|---|
| single-session agent loop with tools | ✅ built | slices 1–7; the 95%-of-life tool loop |
| marathon survival (roll-up + prune) | ✅ built | slice 6b; verify green |
| fast thinking main w/ reasoning passthrough | ✅ built | slice 5; glm-5.3-flash default |
| per-session model switch (override primitive) | ✅ built | `/session/:id/model` + v2 agent switch |
| liveness events the relay needs | ✅ built | `session.status` busy/idle; the wedge keys on them |
| session lifecycle + artifacts (subs' substrate) | 🟡 in gate | gate items 5, 7 |
| dispatcher (queued turns without a client) | 🟡 in flight | gate item 8, "proven queued, end-to-end pending" |
| real-upstream proof (the actual GLM key) | 🔴 pending | verify-real-upstream: FAIL-AUTH, never run against zai |
| `parent` field, spawn tool, role config, relay | 🔴 absent | nothing in main.rs |
| cross-root anything | 🔴 absent (by design, until bridge+grove) | bridge is v0.8 |

Verdict: **v0.7's refusal to build coordination yet is correct** — gate items 5–8
are the substrate coordination consumes, and opencode's own history (a `task`
tool that users almost never used, 10 in 178) warns against shipping machinery
ahead of proof. The reflection should improve in exactly one place: after the
gate is green, v0.7.x lands the seed behind a flag. Also flag honestly: the
biggest coordination-adjacent risk in v0.7 isn't missing machinery — it's the
unproven real upstream (FAIL-AUTH). Coordination multiplies whatever model
quality it's given.

## 7. Sequencing

- **v0.7.x** (after the gate is green; rides items 5+8, adds no gate items):
  `parent` field; `spawn_session` tool; harness relay (terminal sub-events →
  queued main turns); role→model config with talk/strong defaults; brief template
  from the delegate skill; routing log; depth cap 1. Behind `YGG_SUBSESSIONS=1`
  (off in v0.7.0; on after a 24h-stability receipt includes a sub-session).
  Concierge prompt stays ≤ a dozen lines: route, spawn, relay, escalate.
- **v0.8** (bridge + device tokens + Android): `task.blocked` → phone
  notification (escalation becomes product); role/override config surfaced in the
  PWA (the v1.0 rule: user's key surfaces at v0.7, visible and tweakable by
  v0.8); vision role wired to phone attachments; shadow telemetry begins.
- **v1.0** (grove directory → memory → tv test): cross-root delegation over the
  bridge via the artifact seam + grove presence — the inflection test *is* this
  feature; auto-apply decision on shadow evidence, folded into dreaming.

## 8. Risks

1. **Relay loops** — subs and main ping-ponging. Bound: relay only terminal
   events (done/blocked), never idle; depth cap 1.
2. **Specialist sprawl** — roles invented ahead of data. Bound: a role exists only
   when the digest shows the need (the connectors precedent).
3. **Blocking spawn creep** — someone "temporarily" awaits the sub in the tool.
   Bound: the tool returns an id, period; waiting is the dispatcher's job.
4. **Escalation laundering** — routine work dressed as escalation. Bound: the log
   makes the rate visible per role; digest line.
5. **Unproven upstream** — coordination amplifies a brain that has never run
   against the real provider. Bound: FAIL-AUTH is the first thing to clear.

**Laws check:** light prompt ✓ (concierge prompt shrinks; routing lives in
config) · your-LLM-your-key ✓ (user choice is resolution rule #1 at every level;
no silent swaps; attribution required) · no-pay-raw-API ✓ (no new spend path; the
delegate skill's cost-honesty rule carries over) · MAIN outside every registry ✓.
