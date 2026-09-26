# Spec — dreaming (memory consolidation) — POST-V1, NOT IMPLEMENTED

Status: **specification only**. Explicitly out of v1 scope (`spec.md` non-goals).
Nothing here is built; this doc exists so the design survives until then.
Raised 09-26 in conversation about opencode sessions, memory, and self-organizing agents.

## Idea

opencode records sessions but nothing ever reads them back as a whole — memory is
write-only. Bifrost dreams: a nightly job (the **dreamer**) replays the day's sessions
and consolidates them into a memory graph, the way sleep consolidates episodic memory
into semantic structure. The taxonomy of work (projects, roles) **emerges** from that
graph instead of being hand-maintained by the user.

Goals, in order:

1. Morning surface is the distilled graph, not the raw session pile ("fewer sessions
   in the morning" — they've been absorbed, categorized, and linked).
2. Durable facts survive: decisions, preferences, open questions, project state.
3. Agents per project/role (bifrost, veraldaar frontend/backend/deploy/marketing,
   game-with-son, PCB hardware…) crystallize from usage patterns, not user config.

## Pipeline

**Triage** — first pass, before extraction. The dreamer classifies every unprocessed
session: **noise** (tests, accidental sends, few words, no content), **meaningful**
(something to absorb), or **mixed** (both — needs a split). Decisions land in the
ledger with the reason. Noise → graveyard (hidden from session lists, hard-deleted
after ~7 days grace — undoable until then). Meaningful → queued for extract, then
archived once absorbed (hidden from the default list, kept on disk so node
attribution stays auditable). Mixed → split, see below.

**Split** — a session that mixed topics (bifrost debug + veraldaar talk in one
transcript) contributes to multiple clusters. The dreamer records a *logical
segmentation* (`session id → [message ranges → topic/nodes]`), NOT a physical
rewrite: opencode owns its session store (spec rule 3 — source of truth), and an
unattended dreamer mutating raw transcripts is the autonomy class we fenced off.
Physical splitting only if opencode ever ships an API for it.

**Extract** — dreamer reads queued meaningful sessions (per segmentation where one
exists), extracts concept nodes and relations. Every node/edge carries source session
ids (attribution). Processed session ids land in the ledger, so runs are idempotent.

**Cluster** — dense subgraphs of the node/backlink graph = projects (bifrost,
veraldaar…). Recurring themes inside a cluster = emerging roles (frontend / backend /
deploy / marketing split out of the veraldaar cluster, e.g.). The dreamer writes
*observations*, not structure: "cluster X, N sessions, themes Y, proposes agent Z."

**Crystallize** — a cluster becomes a declared opencode agent only above thresholds
(see Governance). The dreamer writes the agent config (markdown: prompt + scoped dir
+ memory slice) and reports it in the morning digest. Veto = delete the config; the
ledger remembers and does not re-propose unmodified.

**Prune** — clusters dormant for ~a month demote back to graph notes. Sleep doesn't
only consolidate; it prunes. Agent explosion (100 agents after two months) is the
primary failure mode — pruning is not optional.

**Morning routing** — new sessions route to the crystallized agent whose memory slice
fits; topics that route nowhere seed a new node, which either joins a cluster overnight
or starts one.

## Running dreams

A dream run is itself an opencode session (`dream-<date>`) run by the dreamer agent
config — visible in the session list, watchable live, and its transcript is the audit
trail. Trigger modes: the nightly timer, and on demand (voice: "dream now"; later a
PWA button). Single-flight: a lock event in the ledger; a manual trigger while the
nightly run is active is refused, and vice versa.

## Strategy experiments

Consolidation quality is unknown upfront, so the dreamer starts as **three completely
different methods** — different in where structure comes from, not prompt variations:

- **S1 — Interpretation (LLM judgment).** The dreamer reads transcripts like a
  biographer: extraction, nodes, clustering and backlinks are all decided by LLM
  reasoning. Rich, context-aware; opaque and expensive; the hallucination risk lives
  here.
- **S2 — Geometry (embeddings + math).** Transcripts are chunked and embedded;
  similarity and clustering are computed (agglomerative / HDBSCAN); the LLM only
  writes labels *after* the math fixed the structure. Reproducible, independent of
  the model's opinion; blind to meaning the embeddings can't see.
- **S3 — Frequency (lexical statistics).** No embeddings, no LLM structure decisions:
  term frequency, recency weighting, co-occurrence — a deterministic old-school NLP
  baseline. Cheap, fully reproducible; the calibration yardstick — if S1/S2 don't
  beat it, they aren't earning their cost.

Common rules:

- All three run on the **same frozen snapshot** of unprocessed sessions and write
  their own sandbox tree (`memory/experiments/<strategy>/`) — never the live
  `memory/` tree. Same output schema, so results are comparable row by row.
- The morning digest presents them side by side: what each extracted from the same
  night.
- **The user is the metric**: votes (S1 / S2 / S3 / all wrong) land in the ledger per
  comparison. A strategy graduates to the default pipeline when its votes dominate
  over weeks — and the harness stays for regression-testing future changes.
- No automatic quality metric until votes accumulate into one.

## Data model

- `memory/nodes/<id>.md` — one node per concept: type (topic/decision/question/
  preference/project/role), immutable `id`, display label (mutable), importance,
  created/last-touched, source session ids.
- `memory/edges.jsonl` — backlink edges (from, to, kind, source).
- `memory/ledger.jsonl` — append-only events: session processed, triage verdict
  (noise/meaningful/mixed + reason), graveyard + restore + hard-delete events, node
  merged, cluster crystallized/demoted, agent proposed/vetoed. Merges and renames are
  events, never silent rewrites.
- `memory/segments.jsonl` — logical session splits: session id → message ranges →
  topic/node ids.
- `memory/mornings/YYYY-MM-DD.md` — digest: what consolidated overnight, what was
  triaged (incl. deletion candidates), top open questions, proposals, anomalies.
- Node ids are immutable; names are labels. A rename/merge must preserve id and be a
  ledger event, or memory orphans.

## Governance (thresholds — starting values, to be tuned)

- Crystallize only if: ≥ 8 sessions, spanning ≥ 2 weeks, ≥ 3 recurring themes.
- Prune after ~30 days dormant; importance decays with age but decisions/preferences
  decay slowest.
- Dreamer writes ONLY `memory/**` and agent markdown configs. Never code, never git
  state, never systemd. Unattended autonomy ends at config.
- Deletion is the single allowed destructive op, and it is bounded: noise-classified
  sessions only, reason + evidence in the ledger, 7-day grace before hard delete,
  restore is always possible within grace. Meaningful sessions are archived, never
  deleted — attribution must stay auditable.
- Append-with-attribution; no destructive rewrites of memory (at least until the
  dreamer has earned trust over months).

## Failure modes (known, by design)

- **Hallucinated consolidation** — the dreamer misreads intent and reinforces a wrong
  memory nightly. Mitigation: attribution, veto, non-destructive writes.
- **Misclassified deletion** — a meaningful session read as noise and hard-deleted.
  Mitigation: 7-day grace + restore, every verdict reasoned in the ledger, and the
  morning digest lists deletion candidates so wrong patterns are caught by breakfast.
- **Agent explosion** — thresholds + pruning.
- **Taxonomy drift** — stable ids + merge events.

## Roadmap (when picked up)

- **D1** triage (classify + graveyard/archive flags; deletion candidates listed,
  grace period enforced) + extractor + graph + morning digest (no agent creation).
  Human observes the graph and the triage verdicts for ~2 weeks. All three strategies
  (S1 interpretation / S2 geometry / S3 frequency) run on frozen snapshots throughout
  the window, side-by-side digests, user votes in the ledger.
- **D2** enable hard-delete after grace; tune thresholds; cluster observations only
  (proposals in digest).
- **D3** automated crystallization + veto flow.
- **D4** morning routing into per-agent sessions.

D1 is the whole first release of the feature; D3+ only after D1 proves the dreamer
reads intent correctly.

## Open questions

Tracked in `open-questions.md` (#4): storage location (`~/Work/memory/` vs per-repo),
dreamer runtime (opencode non-interactive run vs separate script), clustering method
(LLM judgment vs embedding math vs both), and what "importance" actually is.
