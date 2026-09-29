# Open Questions

Unresolved decisions land here the moment they appear, and move to `journal.md` once decided. Nothing is dropped silently. If this table is empty, nothing is pending.

| # | Question | Impact | Raised |
|---|----------|--------|--------|
| 2 | Dreaming spec (`spec-dream.md`) open decisions: memory storage location (`~/Work/memory/` vs per-repo), dreamer runtime (non-interactive `opencode run` vs standalone script), clustering method (LLM judgment vs embeddings vs both — decided via strategy experiments at D1, not upfront), and what "importance" actually means. Defaults chosen 09-28: memory in `~/Work/memory/` (global — bifrost is a multi-repo remote), dreamer = non-interactive `opencode run`, importance = LLM judgment, clustering via strategy experiments at D1. Build post-v1; only the experiments themselves are open | Defines the first implementable increment | 09-26 |

> 09-27 plan review: onboarding auth (spec-onboard OQ1, cookie vs passkeys) PROMOTED — it is the only unresolved decision gating the consumer release (v1.0) and carries security weight. Decide before onboarding phase 2 starts.

> 09-28 sweep — answered, moved to journal (veto window: just say so):
> **Tool permissions** → deny-by-default via opencode's own permission config, mapped by a bifrost voice profile: safe reads auto-allowed (read/grep/glob/ls), write/edit/bash denied in voice mode unless confirmed in a text session first; whitelist lives in agent/.env (BIFROST_TOOL_POLICY). **Committed-turn chip** → solved by the hands-free phase line ("sending…" state + cancel); re-open only if the hands-free pass shows real confusion.
