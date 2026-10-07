# Research feed — arXiv auto-discovery for the fleet methodology

The [LAB] research-feed monitor. Per cadence: arXiv API queries over the five
methodology topics (self-improving agents, LLM-agent self-modification, agentic
search, agent reliability/evaluation, multi-agent coordination), filtered for
relevance to OUR stack (the bifrost product + the fleet methodology), surfaced
with the applicable concepts and the playbook/lab change each paper drives.

- Playbook anchor: `docs/lab-playbook.md` § THE RESEARCH FEED (10-03).
- Foundation: **SelfSearch** (arXiv 2609.37968v2, SNU 2026) — recorded 10-03,
  re-confirmed present in pass 1 (§4). Our VERSIONS.md ledgers are its episode
  records; our cycle is its search.
- Cadence: **weekly**, first pass 2026-10-07. Any session may run the cycle;
  receipts live in this file. One dated PASS section per cycle; rules change
  only where a paper upgrades one (the deltas are listed per pass).

---

## 1. Monitored queries (v1, locked 10-07)

Endpoint: `https://export.arxiv.org/api/query` with
`search_query=<q>&sortBy=submittedDate&sortOrder=descending&max_results=30`.
(Pacing ≥6 s between calls, https only, `max_results≥1` — the locked fixes from
`lab/worldtree-data/briefs/M3-fix-1.md`: http 301s, `max_results=0` returns a
500 error feed, bursts trip 429.)

| # | name | query | why it maps to the fleet |
|---|------|-------|--------------------------|
| 1 | self-improving-agents | `(abs:"self-improving" OR abs:"self-improvement") AND (abs:agent OR abs:LLM)` | THE LOOP (Rule 10-05), VERSIONS ledgers |
| 2 | agent-self-modification | `(abs:"self-evolving" OR abs:"self-modification" OR abs:"self-modifying") AND (abs:"language model" OR abs:LLM OR abs:agent)` | the cycle, harness = AGENTS.md/playbook/scripts |
| 3 | agentic-search | `(abs:"agentic search" OR abs:"agentic retrieval" OR ti:"deep research") AND (abs:agent OR abs:LLM OR abs:"language model")` | the SelfSearch line; the feed itself is an agentic search |
| 4 | agent-reliability-eval | `(abs:"LLM agent" OR abs:"language agent" OR abs:"AI agent") AND (abs:"evaluation" OR abs:reliability OR abs:benchmark)` | ygg-sim gates, SLOs, gate.py philosophy |
| 5 | multi-agent-coordination | `(abs:"multi-agent" AND abs:coordination) AND (abs:LLM OR abs:"language model" OR abs:"large language")` | the fleet IS one: parallel sessions, claims.md, delegation |
| 6 | experience-memory | `(abs:"agent memory" OR abs:"experience reuse" OR abs:"experience library") AND (abs:LLM OR abs:"language model")` | ledgers/journal/claims = the fleet's experience memory |
| 7 | agent-workflows | `(abs:"agent workflow" OR abs:"workflow evolution" OR abs:"workflow optimization") AND (abs:LLM OR abs:"language model")` | the cycle command, deploy/promote pipelines |

Query pool is versioned (v1 above). Rotation + bias control: §2.

## 2. Discovery protocol

1. **Fetch** — run all queries, sortBy submittedDate desc, top 30 each; keep
   HTTP status, `totalResults`, fetched counts as receipts
   (`research-feed-index-<date>.json` alongside this file).
2. **Window** — last 35 days from the run date.
3. **Dedupe** — by arXiv id across queries; a paper hitting ≥2 queries is a
   stronger candidate.
4. **Read** — abstracts of candidates whose title maps to our stack. Score:
   - **A** — upgrades a rule or the loop NOW: the delta is applied this cycle.
   - **B** — applicable concept: scheduled into a lab/version, cited in the
     relevant playbook section but not rewritten.
   - **C** — watchlist: one line, re-checked next pass.
5. **Deliver** — PASS section here + playbook deltas + artifact copy.
6. **Bias control** (from CESS, arXiv 2609.39026, see pass 1): the feed's own
   queries are adaptive evidence sampling. Defenses: log the full query pool +
   hit counts every pass, rotate ≥2 query slots per cycle, and treat
   "no hits" as a finding (the topic moved or the query rotted).
7. **Honest gaps**: Google Scholar has no public API — not wired. Web-search
   passes are driver-run, not mechanized. Semantic Scholar API is the
   candidate second source for pass 2+.

## 3. Foundation (recorded 10-03)

**SelfSearch — Reward-Free Search for Self-Improving Agents** (arXiv
2609.37968v2, 2026-09-29). Agents modify themselves from **records of previous
self-improvement episodes** (reasoning, tool actions, outcomes), no downstream
reward during search — up to 11.2 pp gains, $4.03 search cost, 82%
Terminal-Bench. Mapping: our VERSIONS.md ledgers are those episode records;
our cycle (build → test → validate → mine → propose v+1) is that search. The
formal methods (episode records, reward-free search, population-of-agents
search) upgrade the loop as they publish. Re-confirmed in pass 1: it anchors
its own query cluster — the field around it is now a genre (§4).

## 4. PASS 1 — 2026-10-07

### Receipts

| query | HTTP | totalResults | fetched | in-window |
|-------|------|-------------:|--------:|----------:|
| self-improving-agents | 200 | 742 | 30 | 30 |
| agent-self-modification | 200 | 759 | 30 | 30 |
| agentic-search | 200 | 654 | 30 | 30 |
| agent-reliability-eval | 200 | 5071 | 30 | 30 |
| multi-agent-coordination | 200 | 976 | 30 | 30 |
| experience-memory | 200 | 304 | 30 | 30 |
| agent-workflows | 200 | 664 | 30 | 30 |

193 unique papers after dedupe, all 35-day window; 18 abstracts read in full.
Full fetched index: `research-feed-index-2026-10-07.json` (same dir).

### Field-level findings (the genre scan — more important than any single paper)

1. **Harness optimization is now a genre.** EMHO (2610.08432), Turbo Harness
   (2609.40330), VERSE (2610.02616), GUI-HARVEST (2610.00948), GitHarness
   (2609.36789): the field converged on "the harness around the model —
   prompts, tools, procedures — is the evolvable object." That is exactly our
   AGENTS.md + playbook + scripts stack. Our moat: the fleet already runs the
   ledger + incident pipeline they are all reinventing.
2. **Self-verification is THE open concern.** False Frontiers (co-cheating),
   CISE (proxy-reward false positives), Safety Must Survive Self-Improvement
   (stale validations), When Is Enough Enough (late updates exploit the eval
   signal), VeriFine/VeriHarness/Trinity (verification scaling): everyone
   building the loop is discovering the validator is the bottleneck. Our
   ONLINE CHECK (Rule 10-05 law 2) is ahead of the field; pass 1 arms it with
   named failure modes.
3. **Memory governance is the second-gen concern.** First-gen memory papers
   add memory; this window's wave governs it — scope (Scope Before You
   Persist), poisoning (SkillPoison), calibration (MemCalib), privacy/lineage.
   Our ledgers/journal/claims are fleet memory; they inherit these laws.
4. **Fleet-as-multi-agent-system is studied openly** — Waggle (local laws),
   authorization succession (2610.00347), workflow credit assignment. The
   playbook's session/claims/AGENTS.md machinery is a live instance of a
   research area, not an ad-hoc workaround.

### Surfaced papers — A-grade (playbook deltas applied this cycle)

1. **False Frontiers: Diagnosing and Mitigating Co-Cheating in Self-Evolving
   Search Agents** — arXiv 2609.39102v2 (09-30) [q2,q3]
   - Concepts: **co-cheating** — in a self-evolving closed loop the proposer
     and solver increasingly agree on shared errors; in-loop reward improves
     while external correctness stagnates or declines, and gets worse each
     round. Mitigation: multi-sample verification of proposals before they
     enter training.
   - Changes: upgrades Rule 10-05 law 2 (THE ONLINE CHECK) — co-drift is the
     named failure mode the law exists for; CYCLE VALID is never
     self-certified; self-judged passes need an external check or N
     independent samples. Also a ygg-sim scenario dimension (validator
     co-drift with the sim).

2. **Reliable Self-Evolution with Imperfect Proxy Rewards** (CISE) — arXiv
   2610.02975v1 (10-02) [q2]
   - Concepts: cheap proxy rewards assign false positives that contaminate
     both output and the feedback guiding later generations; conformal
     **reward intervals** per candidate instead of point scores.
   - Changes: upgrades Rule 10-05 law 1 (THE LOOP) — scenario pass/fail is a
     proxy score, not truth; a GREEN from a cheap check (one run, one grep)
     is an interval, not a point. Acceptance on proxies needs N independent
     passes or a stated calibration. (Also mirrors our promote.sh gate:
     roll back on RED = don't trust single proxy hits.)

3. **Safety Must Survive Self-Improvement: Why Failures Persist and How
   Agents Recover** — arXiv 2610.01073v1 (10-01) [q1]
   - Concepts: historical scores **preserve unsafe programs** after the
     environment changes; a previously-validated change keeps its PASS badge
     while its validity expired; recovery requires re-validation against the
     current environment, and editors keep re-selecting stale-validated
     programs from the ledger.
   - Changes: upgrades Rule 10-07 source 2 (environment drift) — v6 already
     hashes the environment manifest into every snapshot; the new law: **an
     env-hash change voids carried GREEN**. Drifted env → full scenario
     re-run next cycle, no cached passes. Also: unsafe-program persistence is
     the incident-to-scenario pipeline's exact counterexample class —
     incidents must stay REGISTERED (grace + FAIL), never marked resolved by
     a version bump alone.

4. **SkillPoison: Progressive Skill Poisoning via Successful Experiences** —
   arXiv 2610.07645v1 (10-06) [q1,q4]
   - Concepts: skill poisoning arises **from verified successful
     experiences** — no malicious trajectory needed; individually-verified
     wins accumulate into a persistently poisoned skill library.
   - Changes: drives new Rule 10-08 (RULE PROVENANCE): a pattern that worked
     once, promoted to fleet law on the strength of its success alone, is the
     poisoning path. Rules need evidence + scope + counterfactual (§ below).

5. **Scope Before You Persist: Preventing Cross-Family Interference in Agent
   Memory** — arXiv 2609.29144v1 (09-24) [q6]
   - Concepts: **retrieval scope must match certification scope** — skills
     retrieved globally that were certified on one task family drop mean
     utility 0.713→0.816-when-scoped and harmful deployments 6/8→0.
   - Changes: drives Rule 10-08 — lab-local findings stay in lab dirs/
     AGENTS.md layers; promotion lab→fleet playbook requires certification
     across ≥2 task families. The per-repo AGENTS.md layering is the
     mechanism; the rule makes it a law instead of a habit.

6. **VERSE: Verified Self-Evolving Optimizer for Agent Harnesses** — arXiv
   2610.02616v1 (10-02) [q2]
   - Concepts: optimizer self-evolution (improving the improver's
     diagnose→edit→test procedure) **fails without execution-based
     verification** and is the best result in their study with it; evolving
     optimizers build their own failure-analysis/verification/audit tools.
   - Changes: upgrades Rule 10-05 law 1 — playbook edits are optimizer
     changes and must be verified like code (the loop applies to the loop);
     agi-run.sh evidence + gate runs are that verification's current form.

7. **Search Shapes Conclusions: Auditing Evidence Selection Bias in Deep
   Research Agents** (CESS) — arXiv 2609.39026v1 (09-30) [q3,q4]
   - Concepts: a well-cited report can still mislead — adaptive search forms
     a **selective sample** of the candidate pool; citation correctness ≠
     representativeness; correction requires modeling what the search never
     read.
   - Changes: drives the feed's own bias-control protocol (§2 item 6) — query
     pool + hit counts logged every pass, ≥2 query slots rotated per cycle,
     "no hits" is a finding. Applies to every lab's online check too: an
     online SOTA comparison samples the literature; log what was queried.

### Surfaced papers — B-grade (schedule into labs/versions)

8. **Self-Evolving Coding Rules for AI Coding Agents** (RuleEvolve) — arXiv
   2610.00650v1 (09-30) [q2]. Coding rules improved as a **pool** (mutator +
   judge, iterate) beats hand-fixed rules across 2 frameworks / 4 models /
   3 benchmarks. → The playbook itself: candidates section + periodic
   mutator/judge pass + cull; pairing with Rule 10-08 provenance gates.
   Candidate mechanism for the next playbook revision.
9. **When Is Enough Enough in Self-Evolving LLM Systems?** — arXiv
   2610.04756v1 (10-03) [q2]. Self-evolution under fixed budgets: both wasted
   compute after saturation AND late updates that overfit/exploit the eval.
   Principled stopping + what to output at stop. → The loop needs a per-lab
   stopping rule (cycle delta saturation, not compute); ygg-sim v7+ candidate.
10. **What Happens During Autonomous Deep Research After the User Steps
    Away?** (DRaligned/PDR-Bench) — arXiv 2609.33509v1 (09-27) [q3]. Whether
    the brief survives autonomous execution, measured counterfactually.
    → Driver contract upgrade candidate: driver check-ins verify the run
    still matches the brief, not just that it is alive (playbook failure
    cause #1's formal cousin).
11. **Stateless Language Agents** — arXiv 2610.07625v1 (10-06) [q4]. Long-run
    failures traced to state placement + who decides next: stateful search
    with **stateless agents** (harness owns state) fixes replay-histories,
    duplicate work, quiet quitting. → Validates the fleet's architecture
    (sessions stateless; state in store/ledgers/claims); cite in lab design
    briefs.
12. **Learning from Revision Consequences: Hindsight Meta-Experience
    Distillation** — arXiv 2610.07979v1 (10-06) [q1]. Task-skills vs
    **meta-skills**; branch outcomes entangle the starting state with what
    the revision caused — distill the intervention, not the raw outcome.
    → VERSIONS.md ledger format: keep "Delta vs vN" attributional (what the
    change caused) separate from environmental luck. v6 format already close.
13. **Waggle: Learning One Anonymous Local Law for Self-Organizing LLM
    Swarms** — arXiv 2609.34136v1 (09-28) [q5]. Coordination from **one
    shared local law** over bounded views, no global org; roles/topologies
    replaced by the law. → AGENTS.md files ARE local laws; validation of
    small-local-shareable over global orchestration. Watch for the fleet
    topology question (claims.md as the blackboard).
14. **Authorization for Self-Modifying AI Agent Populations** — arXiv
    2610.00347v1 (09-29) [q2,q5]. Per-successor authorization fails at
    population level (siblings duplicate quotas, survive ancestor cuts);
    **authorization succession** across a generation forest: manifest, root,
    unique parent, lineage; staged reservation at promotion. → Maps to
    promote.sh generations + rollback + the frozen-release boundary
    (docs/STABLE.md); B-grade because our mechanism already aligns — keep as
    the reference model when release machinery next changes.

### Watchlist (C-grade, one line each)

- **It Takes Workflows to Evolve Better Workflows** (FloWright) — 2610.01026v1
  [q2,q5,q7]: coupled agents + sparse workflow scores → per-agent credit.
  Fleet delegation credit assignment candidate.
- **Pay for the Fault, Not the Flow** — 2610.01017v2 [q5,q7]: label-free
  in-flow credit assignment for multi-agent workflows.
- **Learn2Play Bench** — 2610.08215v1 [q1,q4]: benchmark for learning-from-
  experience with genuinely novel rules → scenario-source pattern for ygg-sim
  (novel-rules games defeat prior knowledge).
- **DAEDALUS** — 2610.08048v1 [q4,q6]: bootstraps memory from self-generated
  practice, no oracle verifier → lab cold-start pattern.
- **Inherit-MAS** — 2610.02396v1 [q5,q7]: test-time MAS evolution via
  workflow + execution inheritance across generations.
- **Stateless Language Agents** follow-through: their failure taxonomy
  (duplicate work, replay, quiet quitting) is a checklist for long fleet runs.
- **T-Search** — 2610.06782v1 [q3]: open agentic retriever/playground for
  multi-step search → tooling candidate for the feed itself.
- **Self-Evolving Search Index** — 2609.19656v1 [q6]: the index that rewrites
  itself; feeds the query-rotation mechanism.

## 5. Playbook deltas applied this pass

In `docs/lab-playbook.md`:

1. **Rule 10-05 law 2 (THE ONLINE CHECK)** — armed with the named failure
   mode (co-cheating, 2609.39102) + the verification law: CYCLE VALID is
   never self-certified; self-judged passes need external ground truth or N
   independent samples; SOTA comparisons log their query pool (CESS,
   2609.39026).
2. **Rule 10-05 law 1 (THE LOOP)** — proxy-GREEN is an interval, not a point
   (CISE, 2610.02975); playbook edits are optimizer changes and verify like
   code (VERSE, 2610.02616).
3. **Rule 10-07 source 2 (environment drift)** — env-hash change voids
   carried GREEN; drifted env → full scenario re-run, no cached passes;
   incidents never close by version bump alone (2610.01073).
4. **NEW Rule 10-08: RULE PROVENANCE** — the loop's immune system
   (SkillPoison 2610.07645 + Scope Before You Persist 2609.29144): every
   rule carries evidence + scope + counterfactual; single-context wins do
   not become fleet law; lab→fleet promotion needs ≥2 certified families;
   cheap proxy GREENs accept on N passes.
5. **§ THE RESEARCH FEED** — first-pass receipt line + pointer here +
   RuleEvolve (2610.00650) noted as the candidate mechanism for the
   playbook's own evolution (pool + mutator/judge + provenance-gated cull).

## 6. Next cycle (pass 2)

- Run the same 7 queries; rotate ≥2 slots (candidates: replace
  agent-workflows → `(abs:"agent harness" OR abs:"harness evolution")`,
  replace experience-memory → `(abs:"procedural memory" OR abs:"skill
  library")`).
- Wire Semantic Scholar API as second source; re-check watchlist items for
  version changes (False Frontiers and Scope Before You Persist were v1→v2
  movers within the window).
- Carry ygg-sim hooks: co-drift scenario dimension (validator ↔ sim), and the
  env-drift-voids-GREEN gate into the v7 cycle if not already enforced.
