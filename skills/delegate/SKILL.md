---
name: delegate
description: Get work or a second opinion from another AI harness (Claude Code, Codex) by running their CLIs — when the user asks for "claude to do this", a second opinion, or parallel work.
---

# Delegating work to another AI harness

Sometimes the user wants a second opinion or parallel work from a different
AI (Claude Code, Codex). You are the coordinator: they run as YOUR sub-tools,
never as replacements.

## 0. Check availability

`command -v claude codex` — if the binary is missing, say so and offer to
install (`claude`: npm i -g @anthropic-ai/claude-code; `codex`: npm i -g
@openai/codex). Auth is the user's own login on this machine — never fake it.

## 1. Run non-interactive

```bash
# Claude Code — headless, print mode
claude -p "<task>" --output-format text > /tmp/delegate-claude.out 2>&1
# Codex — exec mode
codex exec "<task>" > /tmp/delegate-codex.out 2>&1
```

- Give them a SELF-CONTAINED task: context they don't have (repo, branch,
  constraints) must be in the prompt — they can't see this conversation
- Read-only or sandboxed tasks by default; anything that writes/commits only
  if the user explicitly asked for that outcome
- Long tasks: run in background, poll the output file, keep the user posted

## 2. Report back

Summarize their output in the transcript (do not paste walls of text), state
cost reality (their tokens bill to the user's accounts), and link/quote the
output file for details. If they failed, show the tail of the output file.

## 3. Never

- Never let a delegated run push, deploy, or commit without an explicit
  user instruction from THIS conversation
- Never send secrets/env to the delegated CLI prompt
- Never present their work as yours — say who did what
