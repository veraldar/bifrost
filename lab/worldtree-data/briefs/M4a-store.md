# M4a brief — mine the opencode store for the requirements doc

Worker for [LAB] worldtree-data. CHARTER (user, fleet-wide, 10-04): no questions to the
user — the interaction history IS the requirements doc. Your job: extract the
worldtree-relevant intentions from it.

## Input
- Store: ~/.local/share/opencode/opencode.db (SQLite; ~178 sessions, ~9.9k messages).
  FIRST copy it read-only: `cp ~/.local/share/opencode/opencode.db* /tmp/opencode/`
  (db+wal+shm) and query THE COPY — the live server writes the original; never lock it.
- Schema: `session`(id, data JSON), `message`(id, session_id, time_created, data JSON),
  `part`(message parts — check its schema). User messages vs assistant: inspect
  message.data JSON (role field). Dates are epoch integer columns; data JSON also holds
  times. Sessions span ~09-17 → 10-04.

## Find (user voice, not assistant prose — but assistant summaries of user decisions count, flagged as such)
- Everything about the veraldar.org civilization-outcomes tree: the 7 realms
  (utopia/divergence/drift/control/terminus/stagnation/transcendence), percentages,
  world-states, colors per realm, "the tree", world-tree.html, realms.json.
- What the user wants FROM the numbers: honesty, provenance, real-world data, "does the
  tree reflect the world", complaints/corrections about seed vs live numbers, wishes
  (more realms? agent votes? history/sparklines?).
- How the user consumes veraldar.org (phone? hands-free? shares it?), the lambda-user
  test mention (girlfriend on iPhone, user hands-free) and what it implies for the page
  data (load speed, staleness visibility, first-impression honesty).
- Brand constraints touching the data: what is frozen (v0.6.0 cohesive design), what the
  user said about the tree's look vs its numbers.
- Anything on: GDELT/news pulse vs structured indicators, agent votes/roots, prediction
  honesty, "world-state" storytelling.

## Method
1. Full-text sweep: dump user messages, grep case-insensitive for: veraldar, tree,
   realm, utopia, drift, terminus, stagnation, transcendence, divergence, outcome,
   percent, world-state, worldtree, roots, provenance.
2. Read surrounding context of every hit (same message + title of session).
3. Judge relevance; discard noise (e.g. yggdrasil the voice infra ≠ yggdrasil tree).

## Deliverable (write ONLY this file)
~/Work/bifrost/docs/worldtree/requirements-from-history.md
- Top: 10-line summary of what the user actually wants from the data system.
- Then requirements as numbered items, each: verbatim quote (≤2 lines) + session id/date
  + the implication for the pipeline/page. Mark each REQ: [built] (M0-M3 covers it),
  [gap] (do next), or [out-of-scope] (brand-frozen / product-code).
- End: top 5 gaps ranked, each with a one-line "how to close".

Rules: read-only everywhere except the one deliverable file. Quote accurately. If the
store contradicts the design docs (docs/worldtree/), say so loudly in the summary.
End your run with: wc -l on the file + the top-5 gaps list.
