# The LIFE of opencode — reconstructed from this box's real data (2026-10-03)

Source: ~/.local/share/opencode/opencode.db (sqlite, 422 MB) — 178 sessions,
9,892 messages, 36,150 parts, 127,008 events. This file is the usage model
slice 6+ builds against. Rule 10-02: rebuild the life, not the surface.

## Measured usage patterns

1. **Marathons are the norm.** Median session = 22 msgs, but p90 = 130, and
   20 sessions exceed 100 msgs. Max: 817 msgs over 11,905 minutes (8.3 days
   of wall-clock) — the session this lab runs inside. Its history is ~0.6 MB
   of text+tool-output ≈ 148k tokens. No provider takes 148k tokens raw
   every turn: **silent compaction is load-bearing.** opencode marks the
   post-compaction restart message as role=user with `"summary":{"diffs":[]}`.
2. **The life is an agent loop, not chat.** 8,749 tool parts vs 5,151 text
   parts. Tools: bash 5,244 (60%) · edit 1,756 · read 1,003 · write 387 ·
   webfetch 146 · grep 115 · todowrite 39 (84 todo rows) · glob 20 · skill 14
   · question 13 · task 10 · MCP 2. A server that only relays text does not
   rebuild opencode; it rebuilds a chatbot.
3. **Voice-first, short-prompt/long-run.** 1,346 user vs 8,546 assistant
   messages (~8.7 user turns/session): short human prompts (often via voice)
   trigger long autonomous runs. Abort (built) and liveness events
   `session.status` busy/idle (built) are load-bearing — bifrost's mic and
   wedge logic key on them.
4. **Delegation exists but is rare.** 10 child sessions via `task` (parent_id
   set); the PWA renders sub-sessions. Stretch scope, skip-able with reason.
5. **Reasoning is part of the stream.** 5,356 reasoning parts — thinking
   models are the default here (glm-5.3-flash variants). Pass-through needed.
6. **Multi-day persistence.** Sessions live for days and get re-entered —
   disk-backed sessions (built) + history replay on GET (built) matter more
   than any single-call latency.

## What slices 1-4 already cover vs what the life demands

| life demand | state |
|---|---|
| sessions/messages/SSE/abort/events/persistence/installer | built (slices 1-4) |
| tool execution (bash/read/write/edit/glob/grep/todowrite/webfetch) | MISSING — 95% of the life |
| context roll-up for marathons | MISSING — required by pattern 1 |
| reasoning passthrough | MISSING — pattern 5 |
| task/child-session tool | MISSING — rare (pattern 4), stretch |

## Judgment calls (driver-reviewed on the user's behalf)

- Slice 6a first: tools + agent loop — without it nothing else in the life
  is reachable. bash is scoped to a configured project dir; no interactive
  permission prompts (opencode asks; yggdrasil documents instead —
  single-user box, voice-first user, 13 `question` uses in 9 months of data
  doesn't justify a permission UI this slice).
- Slice 6b: roll-up, opencode-shaped (`summary` marker), threshold env.
- Slice 6c (stretch): reasoning passthrough; task tool last, skip allowed.
- The e2e referee never exercises tools/roll-up — that is exactly why the
  life-study was needed; verification for 6a/6b is life-derived
  (tool round-trips, marathon simulation), not surface-derived.
