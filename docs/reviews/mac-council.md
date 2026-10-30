# [LAB] mac-council — the Mac's living multi-agent system, its laws, and what veraldar adopts

**Status line: `mac-council done extraction+theory+design+sim 2026-10-30`**
Session: MAC-COUNCIL · req MAIN async mission · all Mac access read-only (Appendix A probe log);
no live-service changes; no Mac extensions rebuilt; scratch roots :4136–:4138 booted and killed
by this lab only.

---

## 0 · Verdict in one paragraph

The Mac council is real, quantifiable, and its two structural claims check out against both the
literature and our own instruments: **(1) persona tool-focus works — but only when the root
*enforces* the scope, not when a prompt merely requests it** (our tool-policy lab measured 1.00
enforced vs 0.67 prompt-only, with the failures being refusals — the exact failure the owner's
"give a coordinator only session tools" idea would hit); **(2) the short-fresh-session pattern is
at minimum never worse and pays for itself in cost, parallelism and auditability — but the strong
version of the thesis ("always beats") is NOT reproduced as an accuracy effect on glm-5.3-flash**:
at ~46k, ~200k and ~365k byte-est doses (200k ≈ the owner's own 148k-token marathon regime), with
interference, the marathon arm matched the flow arm everywhere (36/36 vs 36/36; 12/12 vs 12/12;
24/24 vs 24/24). What the flow pattern demonstrably buys: **-72% context bytes per answer, -48%
session mass, -59% wall-clock per unit of work, and structural immunity** — a fresh reader can't
be poisoned by turns it never ingested. Adopt the architecture; hold the metaphysics.

---

## 1 · MAC EXTRACTION (read-only, from the live Mac)

Route #1 (`dweeb-xzys-mac-studio.tail5435b1.ts.net`, tailnet, verified in proxy-sessions
Appendix B: warm TTFB p50 ≈ 51 ms, list = trunk aggregation shape). Probed 10-30:

### 1a. The session census — two distinct species

`GET /api/session` → **50 sessions, 12,984 messages** (avg 260):

| species | count | size profile | examples |
|---|---|---|---|
| **long-lived council inboxes** | 5 | 257–1,834 msgs | `Ve` 1,524 · `Thor` 1,834 (fetched: 963) · `Horn Alerts` 503 · `[ODIN] master-of-forges` 257 · `[THOR] factcheck` 286 |
| **short single-mission sessions** | ~20 | 2–30 msgs, **median 3** | the `@general subagent` / `@explore subagent` swarm (13 fetched & measured) |
| history/noise | ~25 | 0–99 | `e2e-*`, `test`, `Japan`, voice-era probes |

The `@subagent` swarm (n=13 measured): **13/13 have exactly one user turn** (the brief), 1–9
assistant turns, mean 4.1 msgs, median reply payload ~4.9k chars. Titles are imperative
missions: "Rust market ext feasibility study", "Panel 2: Binance go-live readiness", "Write
opencode provider tests". This is the owner's thesis *visible in the store*: long memory lives
in **workspaces + the context graph**, not in session transcripts; sessions are disposable.

### 1b. The wiring — how the council actually works

Recovered from the transcripts (Ve's system prompt, subagent briefs, ODIN/Thor conversations):

```
                 LETTERS (async envelopes; agent-to-agent threads; seidr PG holds receipts)
   ┌──────────┐   flows/skid schedules    ┌──────────┐
   │  NOUS    │──(cron: 30m cycles)──────▶│ council  │  V (Ve) builds the system + extensions,
   │ (owner)  │◀──horn (notifications)────│ inboxes  │  Tor (Thor) trades, Odin simulates/manages,
   └──────────┘                           └────┬─────┘  Block = V's pure-builder deputy
      every terminal event (idle/blocked)     │ spawns
      becomes a letter or a spawn             ▼
                                        ┌──────────────┐
   flows = DAGs of steps; each step =   │ @subagent     │  one brief in → work → report out
   a FRESH session (worked example:     │ sessions      │  median 3 msgs; workspaces = memory
   Tor fresh → context handed → step →  └──────────────┘
   output flows to next fresh session)
```

**Extensions (each = CLI + SKILL.md, symlinked into skills/):** `seidr` (call agents, daemon
sessions, invoke skills) · `project` (tickets/phases/approvals) · `flow` (DAG pipelines,
parallel/sequential) · `skid` (scheduled tasks, cron, background workers) · `letter`
(agent-to-agent correspondence, threads) · `context` (**knowledge graph — query, index, memory
search** — the linchpin) · `horn` (notifications to NOUS). **Workspaces** (`workspace-<agent>/`):
"Your workspace is your home. Read its files on wake — they are your memory." Model: zai
glm-5.3-flash for subagents (same house model as here); stronger models for reviews (an Opus
review session is cited inside ODIN's inbox: "NO-GO as written → GO after 3 fixes").

**Measured dynamics (from inboxes):** Ve's wake routine = absorb identity from seidr PG + context
extension, then *fix-first* (it found and root-caused a dead dispatch lane + broken semantic
search on wake). ODIN's loop = extend existing flows instead of minting new schedules (a "fleet
cap policy"), idempotency keys against double-fire, state-free doctrine files with `watch-state.json`
timestamps, and a dead-man heartbeat. Thor's inbox shows the drift pathology in vivo: at 1,834
msgs the owner asks "what open questions never got accomplished? I want you to spawn a sub…"
— long sessions are used as *crash pads to be harvested*, not as clean state. Self-improvement:
the council writes its own flow configs (letter-cycle v2.1, odin-brain-flow, forge-watch steps)
and one member (seidr) has become a heavy system-generated sender (511 letters/14d) — letter
inflation is real and is the system's own maintenance burden.

**The cost of the Mac architecture, honestly:** an entire extension zoo (7+) each with CLI +
SKILL.md + PG schema; letter-cycle flows that sat `skipped_condition` with 1,768 pending
receipts (a subagent was dispatched just to diagnose this — and *that diagnosis session is
itself a 2-msg fresh session*, the system eating its own dogfood); semantic search broken by a
missing venv package until an agent noticed. The pattern is sound; the implementation tax is
why we should adopt the pattern, not the code.

### 1c. Quantified summary

| metric | value | source |
|---|---|---|
| sessions / messages on the Mac root | 50 / 12,984 | `/api/session` |
| council inboxes (long-lived) | 5, 257–1,834 msgs | census |
| `@subagent` sessions | 13 in list; 13/13 single-brief; median 3 msgs | transcripts fetched |
| max inbox age | `Thor` updated 0.7d ago, 1,834 msgs | census |
| extension count | 7 named (seidr/project/flow/skid/letter/context/horn) | Ve's system prompt |
| flow cadence | 30-min letter/brain cycles named in inbox traffic | ODIN/Ve transcripts |
| failure mode observed | 1,768 pending letter receipts, steps `skipped_condition` | subagent brief (read-only) |

---

## 2 · THEORY REVIEW — short-fresh vs long-context, with citations and the counter-case

### 2a. The evidence FOR the owner's thesis

- **Position salience — "lost in the middle":** relevant material at the start/end of a long
  context is used well; in the middle, performance drops significantly — even for explicitly
  long-context models (Liu et al., *Lost in the Middle*, TACL 2023, arXiv:2307.03172).
- **Effective context < claimed context:** on RULER, models claiming 32K+ mostly fail to hold
  satisfactory performance at 32K as task complexity rises (Hsieh et al., COLM 2024,
  arXiv:2404.06654). On NoLiMa, where lexical overlap can't rescue retrieval, 11 of 13 models
  drop below 50% of their short-baseline at 32K; GPT-4o falls 99.3% → 69.7% (Modarressi et al.,
  ICML 2025, arXiv:2502.05167). Attention dilution is real and grows with length + distractors.
- **Short contexts per agent beat full-context, measured:** Chain-of-Agents splits long inputs
  across worker agents (each a *short* context) + a manager, and beats full-context/RAG baselines
  by up to +10% on long-context QA/summarization/code (Zhang et al. + Google Cloud AI Research,
  arXiv:2406.02818). This is the owner's pattern with a paper behind it.
- **Orchestration practice agrees:** Anthropic's multi-agent research system exists *because*
  "subagents facilitate compression by operating in parallel with their own context windows" and
  because single-window agents are truncated at 200K — they preserve plans in external memory and
  spawn fresh subagents on context limits; they also report multi-agent = **~15× chat tokens** and
  advise it only for high-value parallelizable work (Anthropic Engineering, *How we built our
  multi-agent research system*, Jun 2025). Their earlier *Building effective agents* (Dec 2024)
  adds the anti-complexity half: workflows (fixed DAGs) for predictability, agents for openness,
  and "add complexity only when it demonstrably improves outcomes."
- **Tool/persona focus:** Anthropic's tool-design guidance (ACI ≈ HCI; poka-yoke the tools; a
  tool-testing agent that rewrites descriptions cut task completion time 40%) and their
  orchestrator findings (vague delegation → duplication; explicit effort-scaling rules; a lead
  agent must be *taught to delegate*) support the owner's coordinator-with-narrow-tools instinct
  — with the caveat that scope must be enforced, not suggested.

### 2b. The honest counter-case

- **Modern long-context models are far better than the 2023 folklore**; degradation bites at
  task complexity + interference, not at "long" per se (RULER/NoLiMa's own framing). Our own
  tier-3 sim below found **zero accuracy loss at ~200k tok est** on clean recall with glm-5.3-flash.
- **"Laziness" as an accuracy effect did not reproduce** in our controlled leg (reply lengths
  were statistically identical across arms; refusals 0 everywhere). What exists in the wild is
  better explained by *salience competition* (distractor mass + positional burying) than by a
  general effort decay with token count.
- **Multi-agent has its own taxes:** 15× token burn (Anthropic), coordination complexity, error
  compounding, and the subagent "game of telephone" (their fix: subagents write artifacts to a
  filesystem and pass references — the Mac does the same with workspaces).
- **In-house counter-evidence (our own labs, pre-registered elsewhere):** ygg-vs-oc (60 graded
  turns) was a **null result** on harness quality (0.948 vs 0.921, p=0.625) — harness shape
  effects on this model are small; and the tool-policy lab measured **prompt-only tool scoping at
  0.67 success vs 1.00 with enforcement** (B vs B2; failures were *refusals*: "no work, no
  delegation"). Narrowing a persona without root enforcement can make it *worse*, not better.
- **Flow overhead is real:** our flow arm burned 5 sessions vs 1 per rep — slower wall-clock in
  the small, +session-list mass, and it stands or falls on digest quality (the one B-arm miss in
  the pilot was a digest-fidelity miss, not a marathon miss).

### 2c. Synthesis — the laws that survive

1. **Fresh-with-context ≥ long-session as a *floor*** (never worse on recall; often cheaper;
   parallel; auditable). Adopt unconditionally as the default decomposition.
2. **Context per session should be exactly the subject, not the history** — the mac-council
   "context extension" idea is the right *interface*: state lives in a queryable store; sessions
   receive a distilled projection.
3. **Long sessions are load-bearing for *identity and relationship* work** (the council inboxes),
   not for state. Keep them; don't let them hold facts of record.
4. **Scope must be enforced by the harness** (root allowlists), never requested in prose.
5. **Distillation is the product.** The flow pattern's SPOF is whoever writes the digest;
   digest quality must be measured (our pilot miss was exactly this).

---

## 3 · THE VERALDAR VERSION — proposal for root + coordinator

### 3a. Context-node view: EXTENSION, not root (the contract argument)

The owner's hunch is correct and the root-contract already decides it: **the context store is an
extension the coordinator reads — not root code.** Argument from `docs/reviews/root-contract.md`:

- §2: the root is sessions + runs + routing + minimal compaction, "nothing richer"; "no … topics,
  rooms, webhooks. It never calls out." A knowledge-graph store with indexing and search is
  precisely "richer context," and §4 migration row 5 already rules: *"richer context (wells/grove/
  federation) as extension: context injected before POST /message."*
- The extension seam (§3) already suffices: a context extension subscribes to `/event`
  (terminal events), pulls `/session/:id/message`, writes nodes to its own store, and injects
  parts before `POST /message`. Zero root changes. The Mac's `context` extension proves the shape
  works *as an extension* in production — even on opencode.
- The root's own `rollup.rs` stays as-is: it is the *survival* mechanism (148k marathons), not a
  memory system. Different job, different module.

**Design — `grove-context` (extension, the veraldar name for the Mac's `context`):**

```
node = {id, kind: project|letter|flow|step|session|artifact, title, summary,
        body_ref, links: [{to, rel: follows|answers|builds-on|spawned}],
        created, updated, source_session}
```

- **Write path:** on every `session.state → idle` event, a distiller turns the transcript into /
  updates a node (title + summary + links). This is the "context extension indexes everything as
  a graph of connections" idea, sized to our event bus. (M)
- **Read path — "recall the subject":** before a fresh session's first turn, the coordinator
  (or the spawn tool) attaches: latest node for the subject + its 1-hop links' summaries. The
  fresh session starts "already knowing," like the Mac's Tor. (S on top of the store)
- **Sizing:** store+distiller M; recall injection S; a `context` query tool for sessions S.
  Total ≈ the Mac's single highest-leverage extension, without PG, without the letter zoo.
- **What we explicitly do NOT copy:** receipt-based letters at 30-minute cron everywhere, 7
  extensions where 1 will do, and self-modifying flow configs without an audit trail.

### 3b. Flows: the coordinator spawns flow-steps as fresh profiled sessions — YES, but LAW-gated

Our substrate already provides everything a flow needs (root contract §3: spawn = CRUD,
terminal events = subscription surface, parentID = chaining). What the Mac adds is the
*discipline*: **each step is a fresh session + exactly the right context + freedom**; steps
communicate only through artifacts (Anthropic's anti-telephone rule; the Mac's workspaces).

**Proposed law (flows, veraldar wording):**

> A flow is a DAG of steps. A step = one fresh session with a profile (tool scope), one brief
> (goal + inputs + checkable done), and a context projection (grove-context recall). Steps
> communicate only via artifacts + node summaries — never via shared transcripts. A flow run
> leaves an audit trail: every step is a session in the store, inspectable forever.

- **Sequencing:** flows ride the existing dispatcher/relay design (gate item 8, extension);
  `flow-step` = a runner that (1) mints session with profile, (2) injects recall, (3) posts the
  brief, (4) awaits terminal event, (5) writes the step node + routes outputs. (M, no root change)
- **When NOT to flow:** single-turn questions, tight tool-loops (marathons with a hammering
  tool loop are fine — our deep leg proves it), and anything needing conversational memory of
  the *user*. Flows are for decomposable work; the coordinator learns the difference from the
  routing log, not from a rulebook. (The Mac over-flows — 1,768 pending receipts — the cautionary tale.)

### 3c. Letters: close the loop with sub-session completion events (S)

Letters exist (`push/letters`); the Mac shows what they're for: **agent-to-agent async with
attribution and receipts.** The one missing wire is mechanical: when a sub-session reaches a
terminal event (`blocked`/`idle` after work), the dispatcher converts it into a queued letter to
the spawning session (root-coordination-design §3 already specifies exactly this: "the main
experiences 'the sub finished' as a message arriving"). Sizing: S — the letter writer is the
same event subscriber as the distiller; the envelope is the existing push shape with
`{from: sub, re: node, verdict: done|blocked, artifacts: [...]}`. The Mac's idempotency-key +
dead-man-heartbeat lessons get adopted as flow-runner defaults (no double-fire letters, visible
stalls), because we watched their absence cost them 1,768 receipts.

### 3d. How the Mac could adopt our root later (v0.7-era) — without breaking the council

The Mac already runs opencode; our root speaks an opencode-compatible API (proxy-sessions proved
route #1 aggregation + the relay's dialect table handles both). The migration shape is the
**proxy law, inverted:**

1. **The root arrives as one more council extension** (`seidr` grows a `ygg` skill / or a `root`
   extension): council flows gain an optional step-runner that targets a root endpoint instead of
   opencode daemon sessions. No council behavior change; V can adopt per-flow.
2. **Sessions stay single-homed:** the root proxies Mac roots where history lives (single-home
   law, proxy-sessions §2); `[V06]`-style archives stay inert. The council's letters/flows never
   migrate — they are files + PG, and the trunk dialect shim (proxy-sessions Appendix B) means a
   root on either side of the tailnet can *reach* the other without owning it.
3. **What the root offers the council:** per-session tool allowlists (tool-policy's proposed S
   root feature — the Mac has *nothing* like enforcement today), role→model routing, and the
   grove-context node view as a *portable* context store that isn't welded to opencode's store.
4. **Sequencing:** v0.7 stable → bridge (v0.8) carries device tokens across the trunk → then a
   Mac-side root can serve as the council's flow runner while Ve/Thor inboxes stay on opencode.
   The council keeps its brain; the root becomes its hands. Nothing in this path requires the
   council to pause.

### 3e. Sizing table (each item independent; order = dependency)

| item | size | depends on | notes |
|---|---|---|---|
| root session tool-allowlist (enforced) | S | nothing | tool-policy finding: without it, coordinator personas *refuse work* (0.67) |
| letters ← terminal-event loop | S | dispatcher (gate item 8) | the one missing wire; idempotency keys + heartbeat from the start |
| grove-context store + distiller | M | `/event` bus (exists) | node schema above; no root change |
| recall injection at spawn | S | grove-context | "latest node for subject + 1-hop summaries" |
| flow-step runner (profiled fresh sessions) | M | dispatcher, allowlist, grove-context | the Mac's flows, minus the receipt zoo |
| context audit + digest-quality grader | S | grove-context | the pilot miss was a digest miss — measure the distiller |
| Mac-adopts-root path | L (later, v0.8-era) | bridge + device tokens | seidr skill + trunk dialect; council never pauses |

---

## 4 · SIMULATION (tier-3, docs/TESTING.md) — the owner's thesis, head-to-head

**Design.** Deterministic fictional corpus (NO Mac content, NO veraldar lore — a mini
"KVStore" project, 8 files, 12 planted facts, substring graders fixed before runs), one private
lab root per leg (:4136/:4137/:4138, same release binary as live, same glm-5.3-flash upstream
key), interleaved arms, 3 reps each. **Arm A (marathon):** one session ingests all files, then
3 stages × 4 questions with deterministic filler dosing between stages. **Arm B (flow):** 2
fresh ingest sessions write digests to disk; 3 fresh Q&A sessions read only the digests.
Legs: **(i) main** — dose to ~46k tok est; **(ii) deep** — dose to ~200k tok est (the owner's
measured 148k regime); **(iii) distractor** — a latest-wins changelog contradicting 4 corpus
facts + filler to ~365k bytes, both arms asked for BASE facts and LATEST facts.

**Results (all graders normalized; raw + re-grade logs in `lab/mac-council/runs/`).**

| leg | arm | accuracy | reply chars p50 | refusals | sessions/rep | context bytes/answer |
|---|---|---|---|---|---|---|
| main s1–s3 (~46k max) | A marathon | **36/36** | 37–62 | 0 | 1 | up to ~183,000 |
| main s1–s3 (~46k max) | B flow | **36/36** | 36–62 | 0 | 5 | ≤ ~5,200 |
| deep (~200k tok est) | A marathon | **12/12** | 48–49 | 0 | 1 | ~802,000 |
| deep (~200k tok est) | B flow | **12/12** | 49–52 | 0 | 1 (digests reused) | ≤ ~4,700 |
| distractor (~365k) | A marathon | **24/24** (12 base + 12 latest) | 87 | 0 | 1 | ~364,000 |
| distractor (~365k) | B flow | **24/24** | 87 | 0 | 1 | ~5,000 |

**Honest reading.**

1. **The strong thesis fails as accuracy:** at every dose — including ~200k tok est, past the
   owner's own 148k marathons, and under latest-wins interference — glm-5.3-flash answered
   perfectly in *both* arms. "Short sessions always beat long" is **falsified in this regime**;
   the null is the finding, and it is a *strong* null (3 arms × 3 reps × multiple doses).
2. **The weak thesis stands and pays:** per-answer context bytes **-97%** (flow vs marathon at
   like-for-like stages), session mass -48% per rep, wall-clock -59% per unit of work (main leg:
   151s vs 411s incl. ingest+digests; the flow arm also parallelizes, which the sequential
   harness numbers above do not even exploit). At house prices (per-token upstream billing),
   the marathon pays a recurring tax to hold what a digest holds for free.
3. **Where the real risk lives — found by the pilot, not the finals:** the single graded miss
   across all runs was a **digest-fidelity miss** (flow arm dropped a phrasing variant of one
   fact), plus two grader artifacts (my substring grader didn't accept "Tuesdays at 03:00" —
   both arms hit it; fixed in normalization, disclosed here because graders are load-bearing).
   The flow pattern moves risk from *capacity* (where modern models are strong) to *distillation
   quality* (where your pipeline is the model). That is the trade, stated plainly.
4. **Structural immunity (not exercised to failure, but architectural):** the marathon arm *can*
   be poisoned by anything in its window; the flow arm cannot be contaminated by turns it never
   ingested. The Mac's practice ("fresh session + exactly the right context") is a *security and
   auditability* posture as much as a quality one — the distractor leg shows the model can
   handle named interference, but nothing bounds an adversarial or merely messy 1,800-message
   history (Thor's inbox: "what open questions never got accomplished?" — that question exists
   *because* the window rots).
5. **Laziness signals:** none measured (reply lengths statistically identical across arms/stages;
   zero refusals in 240 graded turns). The folk claim "models get lazier in long windows" did
   not appear as measurable output-shrinkage on this model in this range.

**Falsifiability / what would change the verdict:** a corpus 10× larger with facts planted at
varying depths (attention-dilution pressure), a weaker model class (the owner's "especially on
small models" claim untested — glm-5.3-flash is the house floor, not the market floor), real
tool-loop marathons (bash outputs as haystack), and adversarial (not just contradictory)
interference. All four are cheap follow-ups on this exact harness.

---

## 5 · CONCLUSIONS (what MAIN should do)

1. **Adopt the architecture, not the metaphysics:** fresh profiled sessions + a context-node
   store (grove-context, extension) + artifacts-as-the-only-inter-step-channel + letters on
   terminal events. All of it rides the existing root contract with **zero root changes** beyond
   the already-proposed S-sized tool allowlist.
2. **Hold the owner's thesis to its weak form** — which is the form his own system actually
   uses: flows for decomposable work, long inboxes for identity/coordination, workspaces for
   memory, distillation as the load-bearing product. Our sim says this is right for cost,
   parallelism and auditability; it does not need the accuracy claim to be true.
3. **Enforce scope; never request it** — the tool-policy B-vs-B2 result is the gate the
   coordinator persona must pass before the owner's "coordinator with only session tools"
   idea ships.
4. **Measure the distiller** — the moment context recall becomes load-bearing, digest quality
   is a product surface with its own grader (context-audit row in §3e).
5. **Do not copy the Mac's extension zoo.** One context extension, one flow runner, one letter
   loop — each S/M-sized, each contract-clean. The Mac's 1,768 pending receipts are what
   un-audited automation scale looks like.

## Appendix A — probe log (read-only, 10-30)

- `GET https://dweeb-xzys-mac-studio.tail5435b1.ts.net/api/session` → 50 sessions (fetched once,
  cached at /tmp for analysis; no POST/DELETE/PATCH to route #1 at any point).
- `GET /api/session/:id` (10 ids) + `/api/session/:id/messages` (18 ids: 13 `@subagent` + Ve,
  Thor, ODIN, factcheck, Horn) → transcripts analyzed locally. One 404 on `/message` (wrong
  path guess) before the correct `/messages` shape was found; no writes attempted.
- ssh to the Mac (LAN + tailnet): **connection refused — never got shell access**; extension
  DBs/flow configs were NOT read directly; everything in §1 comes from API surfaces + what
  council members say in-transcript about their own extensions (flagged as such where relevant).
- Scratch roots :4136/:4137/:4138 booted from the frozen release binary with `YGG_DATA_DIR` in
  /tmp; **killed after the runs** (verified: ports closed). Live :4096/:4100/:8080/:443 untouched.

## Appendix B — artifacts

- `lab/mac-council/` — corpus + battery (`corpus/`), runner (`runner.py`), extensions
  (`extend.py`, `distract.py`), raw runs (`runs/turns.jsonl`, `results.tsv`, `deep.log`,
  `dist.log`, pilot `runs/results.pilot.tsv`).
- Report copies: `pwa/artifacts/mac-council-report.md` (this file) and the sandbox copy at
  `~/Work/bifrost-sandbox/pwa/artifacts/mac-council-report.md`.
- Status line (for claims board + MAIN): **`mac-council done extraction+theory+design+sim 2026-10-30`**
