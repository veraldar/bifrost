# REPO-MAP (10-29, repo-reshape) — where the construct lives in git

Owner's construct, now enforced by repo layout:

```
veraldar                      (GitHub org — the world)
├── yggdrasil                 THE WORLD-TREE SYSTEM — the root brain
│   └── master = the brain deployed on :4100
│       yggdrasil/v0.7.0-rc1 = 412a9c4 (bifrost) · previous live
│       yggdrasil/v0.7.0-rc2 = 885122c (bifrost) · live since 11:00 10-29
└── bifrost                   THE BRIDGE — trunk (pwa/ agent/ deploy/) + labs
    ├── main                  product line; release/* + promote.sh/next-slot.sh flow
    ├── lab/yggdrasil/        brain dev home (root commits land here first)
    └── 24 lab trees          worktrees stay where they are — see migration list
```

## Why trunk stays in bifrost

The glossary names two different things: **yggdrasil = the system = the tree**
(its root is the brain service); **bifrost = the bridge** (phone → agent →
brain). The bridge's trunk services — `pwa/`, `agent/`, `deploy/` — are how the
world is reached, not the tree itself; they share release tooling, e2e suites,
and one production boundary with the rest of bifrost (promote.sh, gate.py,
docs/STABLE.md). Splitting them would fork the release pipeline for zero
boundary benefit. They stay. The brain, by contrast, is a self-contained Rust
crate with its own verify suites — it gets its own repo, tags, and history.

## Publishing (the rot-proof)

- `scripts/publish-all.sh` — THE one-shot publish. Run once after `gh auth
  login --web` fixes auth: re-derives the yggdrasil split from the current
  brain tip, syncs ~/Work/yggdrasil, creates veraldar/yggdrasil (private),
  pushes BOTH repos (all branches, all missing tags — never force), sets
  defaults, verifies. `DRY=1` rehearses offline.
- `scripts/push-all.sh` — push every branch with a remote counterpart + report
  stragglers. `-c` also creates missing remotes. `--all-repos` walks
  `scripts/push-repos.txt` too.
- `scripts/push-audit.sh` + `push-audit.timer` — nightly 04:17 JSONL row per
  repo into `~/.local/share/bifrost/bench/push-audit.jsonl` (unpushed commits
  and branches). Works offline (counts against remote-tracking refs).
- Lane law: `scripts/agi-run.sh` now pushes a landed lane's branch automatically
  (`AGI_AUTO_PUSH=0` to opt out). A landed mission that never pushed did not publish.

## Tagging law

- bifrost: bridge releases, `vX.Y.Z` (existing scheme, unchanged).
- yggdrasil: brain releases, `yggdrasil/vX.Y.Z*` — one per deployed binary,
  created at promote time against the bifrost commit the release was built from
  (mapped through the deterministic subtree split).
- CI: noted for later (issue-tracked separately), intentionally not built here.
