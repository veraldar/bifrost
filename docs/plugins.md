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
