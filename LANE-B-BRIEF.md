# LANE B — streaming first-sound in the voice agent (agent/agent.py)

Base: this worktree's `agent/agent.py` (the livekit voice worker). The
Reviewer measured 5-7.5s brain latency, and the agent speaks only on run
completion — a human hears NOTHING for 6-8s. Fix: first sound as early as
possible.

## Scope (Python, agent/agent.py only)

1. **Sentence-streaming speech**: while the assistant reply is arriving
   (whatever the agent already receives per update — it polls/watches the
   run), speak each COMPLETED sentence via the TTS as soon as it is final,
   instead of waiting for run end. Guard: sentences shorter than N chars
   buffer until the next sentence or run end. Keep the existing
   auto-listen-on-idle semantics EXACTLY (the mic returns after the LAST
   sentence, not the first).
2. **Filler/earcon**: within the first ~600ms of a run starting, play a
   short non-verbal earcon (or one-word filler, config `AGENT_FILLER`,
   default empty=earcon tone) so the user knows they were heard. Must be
   cancelable the moment the first real sentence is ready.
3. **Config**: `AGENT_STREAM_TTS=1` default on; `0` restores the old
   wait-for-completion behavior verbatim.

Do NOT touch: PWA, yggdrasil, deploy. The agent's transcript/diag contract
stays byte-compatible (the PWA watchdog regexes agent traffic).

## Verification

`cd agent && uv run python -c "import agent"` compiles. Write
`agent/scripts/stream-replay.py` (or extend the existing repro harness
pattern): a fake run that emits a 3-sentence reply over 6s and asserts —
first TTS request lands <1.5s after run start (the earcon/filler or first
sentence), sentences speak in order, mic-restore happens only after the
last. Run it; print PASS.

~45 min. Territory: agent/ only. Blocked twice → stop, write the blocker
into LANE-B-REPORT.md, exit.
