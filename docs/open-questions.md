# Open Questions

Unresolved decisions land here the moment they appear, and move to `journal.md` once decided. Nothing is dropped silently. If this table is empty, nothing is pending.

| # | Question | Impact | Raised |
|---|----------|--------|--------|
| 1 | Agent tool-permission policy (deny-by-default, voice confirm for safe tools) — needs a concrete whitelist + confirmation UX | Blocks unattended voice-driven code changes | 09-17 |
| 3 | Hands-free has no visual feedback for "turn committed / sending" — user can't tell when a pause was long enough and the message went to opencode (they only learn via the spoken reply). Should the UI show a committed-turn chip (like text-mode "● queued") driven by agent events? | UX clarity for hands-free mode | 09-25 |
| 4 | Dreaming spec (`spec-dream.md`) open decisions: memory storage location (`~/Work/memory/` vs per-repo), dreamer runtime (non-interactive `opencode run` vs standalone script), clustering method (LLM judgment vs embeddings vs both — decided via strategy experiments at D1, not upfront), and what "importance" actually means. All post-v1, decide at roadmap D1 | Defines the first implementable increment | 09-26 |
