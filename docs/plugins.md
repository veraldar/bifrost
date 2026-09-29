# Bifrost plugins — v0 (EXPERIMENTAL)

Status: **unstable draft** for early adopters. The shape may change until
connectors phase 3 lands — build prototypes, don't build products on it yet.
Stable pieces you CAN rely on today: the **skill face** (SKILL.md format,
shipped and proven — see `skills/install/SKILL.md`).

## Idea

A plugin is a folder inside your instance's `plugins/` directory (gitignored,
created by `scripts/bootstrap.sh`, survives updates). It never touches
upstream and never leaves your machine.

```
plugins/
  my-plugin/
    plugin.json        # manifest
    SKILL.md           # agent face  (optional) — same format as skills/
    cli/               # human/automation face (optional) — any executable
      my-plugin
```

## Manifest (v0)

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "one line",
  "capabilities": ["skill", "cli"]
}
```

- `skill` — your SKILL.md is exposed to the coding agent like any built-in
  skill; the agent can load and follow it
- `cli` — executables under `cli/` are runnable by the user (and by the agent
  when a skill instructs it); they speak plain stdin/stdout/exit codes

## Rules

- **Capabilities only via the core**: plugins use documented APIs (the proxy
  seam endpoints); no core internals, no direct DB/file pokes
- **Deny-by-default**: a capability not listed in the manifest doesn't exist
- **Local forever**: plugins/ is gitignored; sharing a plugin = sharing a
  folder, manually or via your own git repo

## Reserved for later (do not build against)

- `service` face (long-running plugin process / webhook routes) — post-v1,
  security review first
- plugin marketplace / discovery
- per-plugin secrets

## Why no Rust

Plugin authors never write Rust. If the core is ever ported to a Rust daemon
(`bifrostd` — an option, not a promise), plugins keep talking to the same
contract over HTTP. Your skill/cli faces survive any core rewrite.

## Recipe — a "workflow pack" (the better skill+cli+service ask)

For turning a named flow (e.g. a git workflow) into a plugin, do NOT build a
service layer or write Rust. A workflow pack is three small things:

1. `SKILL.md` — the flow as agent-readable instructions (the brain): when
   invoked, steps, guardrails, when to stop
2. `cli/` — the deterministic steps as plain executables (the hands): the
   agent calls them; they do one thing each, exit codes tell truth
3. a **trigger line** — the heartbeat, no daemon: cron/alias that starts a
   bifrost session pointed at the skill, e.g.
   `0 9 * * 1 curl -XPOST $BIFROST/api/session -d '{"title":"weekly-flow","skill":"my-flow"}'`

Worker behavior = skill + trigger. If a flow someday truly needs a
long-running process, that's the reserved `service` face (post-v1) — and it
still wouldn't be Rust.

Worked example to copy: see `templates/plugin-workflow/` (added with the
plugins loader, connectors phase 1+).
