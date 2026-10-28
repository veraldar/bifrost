# Locations audit — where every piece of the bifrost fleet actually runs from

2026-10-28, ~21:00–21:30 CET, omarchy. PROVIDER-WAVE item 3. **Read-only audit**: no unit, file, tree or
process was changed; every command in §5 is for a human to run later. Evidence = a path, a PID cwd/exe,
a git line, or a unit file line (gathering commands: §6).

## §0 Verdict (one glance)

| piece | the one true location today | evidence |
|---|---|---|
| trunk code (the root, scripts, docs, labs) | `~/Work/bifrost` @ `rebuild/cohesive-opus` (42d1263 at 21:29) | `git worktree list` |
| PWA + agent release line | `release/v0.7` → `~/Work/release-v07` (live rc2 = c4b1908, next rc1 = ca990ca are on it, **not on trunk**; trunk's `agent/agent.py` = the v0.6.1 copy) | `git branch --contains c4b1908` = release/v0.7, wave/provider-banner |
| live PWA :8080 + agent `bifrost-live` | `~/.local/share/bifrost/live` → `releases/20261027-1735-c4b1908` (v0.7.0-rc2), env inside the release | PID 199385 / 199161 cwd |
| the root binary (:4100) | `~/.local/share/bifrost/brain/yggdrasil-412a9c4` (frozen.conf); sha256 13c47292… = `.sha256` = `/proc/1861609/exe` | readlink + sha256sum |
| **the root's env** | **`~/Work/bifrost/lab/yggdrasil/yggdrasil.env` — inside the trunk worktree (gitignored, 0600)** — the one unfrozen piece | unit `EnvironmentFile=` |
| the root's store | `~/.local/share/yggdrasil/session` (356 entries); tool cwd `YGG_PROJECT_DIR=~/Work` | PID 1861609 environ (names/paths only) |
| next slot PWA :8090 (→ :8443) | `~/.local/share/bifrost/next/current` → `20261027-1730-ca990ca` (v0.7.0-rc1); its state files symlink into `~/Work/bifrost-sandbox/pwa` | PID 2208224 cwd; `find -type l` |
| next slot agent `bifrost-ygg` | `next/current/agent` (same clone) — **not** `~/Work/lane2-merge` any more (memory note is stale) | PID 2205970 cwd |
| labs | `~/Work/bifrost/lab/*` (worldtree-fetch runs here nightly); the v0.8 bridge still runs **from `~/Work/lane2-merge`** with a binary deleted from disk | PID 4008544 exe `(deleted)` |

Three things still run from, or write into, a mutable worktree: the root's **env** (U1), the **bridge** (U4), and
two **timers** that commit to the trunk tree (U5, U6). The live PWA's runtime state + artifacts also live in the
trunk tree by design (STABLE.md) — `git clean -x` there would wipe them (§3.6).

## §1 Services → actual paths

`WT?` = runs from (or reads at runtime from) a git worktree.

| unit | port | WorkingDirectory (effective) | exe / script (effective) | EnvironmentFile | running PID: cwd / exe (since) | WT? | verdict |
|---|---|---|---|---|---|---|---|
| lk-pwa | 127.0.0.1:8080 ← tailnet :443 | `%h/.local/share/bifrost/live/pwa` (live.conf over base `~/Work/bifrost/pwa`) | node 26.8.1 `next start -p 8080` | `live/env/live-pwa.env` (0400, in release) | 199385: `releases/20261027-1735-c4b1908/pwa` / node 26.8.1 (10-27 19:29) | state + `ARTIFACTS_DIR=~/Work/bifrost/artifacts` + `YGG_ENV_FILE=~/Work/bifrost/lab/yggdrasil/yggdrasil.env` | OK (code frozen); residual WT coupling §3.6 |
| lk-agent | LiveKit worker `bifrost-live` | `%h/.local/share/bifrost/live/agent` (base `~/Work/bifrost/agent`) | `uv run agent.py start`, `UV_FROZEN=1` | `live/env/live-agent.env` | 199153: `releases/…c4b1908/agent` / uv 0.12.13; child python `.venv` of the release | no | OK |
| opencode-legacy | 127.0.0.1:4096 (rollback brain for v0.6.x) | none → `$HOME` | `mise/shims/opencode` → resolves `installs/opencode/latest` → **1.18.30** | none | 1350425: `/home/dweeb_xyz` / `installs/opencode/1.18.30/opencode` (10-19 10:26) | no | OK; version unpinned (U7); stray child :4097 (§3.8) |
| opencode-serve | (:4096) | `~/Work` | `installs/opencode/latest/opencode serve --port 4096` | none | inactive, disabled | — | dead duplicate of legacy (U8) |
| lk-yggdrasil (the root) | 127.0.0.1:4100 | `/home/dweeb_xyz` | `%h/.local/share/bifrost/brain/yggdrasil-412a9c4` (frozen.conf over base `~/Work/bifrost/lab/yggdrasil/target/release/yggdrasil`) | **`~/Work/bifrost/lab/yggdrasil/yggdrasil.env`** | 1861609: `/home/dweeb_xyz` / `brain/yggdrasil-412a9c4` (10-28 16:35) | **env only** | FIX U1 |
| bifrost-sandbox (next slot) | 127.0.0.1:8090 ← tailnet :8443 | `%h/.local/share/bifrost/next/current/pwa` (next-slot.conf over base `~/Work/bifrost-sandbox/pwa`) | node 26.8.1 `next start -p 8090 -H 127.0.0.1` (loopback.conf) | `~/.config/bifrost/env/bifrost-sandbox.env` (+ `.env.local` symlink → sandbox tree) | 2208224: `next/20261027-1730-ca990ca/pwa` / node 26.8.1 (10-28 20:36) | state (sandbox tree) | OK; U3 notes |
| lk-agent-ygg (next slot) | 127.0.0.1:18082 health; worker `bifrost-ygg` | `%h/.local/share/bifrost/next/current/agent` (next-slot.conf over base **`~/Work/lane2-merge/agent`**) | `uv run agent.py start`, `UV_FROZEN=1` | none — inline `Environment=` incl. LIVEKIT_API_KEY / LIVEKIT_API_SECRET in a 0644 unit file | 2205963: `next/20261027-1730-ca990ca/agent` / uv; child python of the clone's `.venv` (10-28 20:34) | fallback only | FIX U2 (fallback + perms) |
| bifrost-bridge | 0.0.0.0:7890, media 192.168.1.89:7891 | **`~/Work/lane2-merge`** | **`~/Work/lane2-merge/lab/bifrost-net/target/release/bifrost-net`** `bridge -c ~/.local/state/bifrost-bridge/bridge.toml` | none (`BIFROST_DEVICES_FILE` inline) | 4008544: `~/Work/lane2-merge` / same path **`(deleted)`** (10-04 20:24). Running sha256 104b03b4…; on-disk file now 2737de4a… (built 10-04 21:34) | **yes** | FIX U4 |
| lk-pwa-lan | 192.168.1.89:8082 (LAN, unauthenticated) | `~/Work/lane2-merge/pwa` | node `server.mjs` | inline | disabled, inactive | yes | DON'T enable (U9) |
| lk-verify.timer → .service | daily 12:00 | `~/Work/bifrost` | `npm run verify --prefix ~/Work/bifrost/pwa`; ExecStartPost `git add docs/environments.md && git commit && git push` in `~/Work/bifrost` | — | failed 10-28 12:56 (`Authentication failed` on push) after committing **31757f6 on trunk** (6 such commits since 10-23) | **yes, writes commits** | FIX U5 |
| worldtree-fetch.timer → .service | daily 14:30 | `%h/Work/bifrost/lab/worldtree-data` | `bash scripts/nightly.sh` (`wt run --commit` → `git commit -- .` when a tracked file changed) | — | last run 10-28 14:30 OK (where.sh: health 1, published) | **yes, writes data + commits** | note U6 |
| fleet-watchdog.timer → .service | every 5 min | none | `python3 %h/Work/bifrost/scripts/fleet-watchdog.py` | — | disabled (stopped 10-06, STABLE rule 7) | yes | DON'T enable (U10) |
| lk-livekit-rekick | boot oneshot | none | `docker restart deploy-livekit-1` | — | inactive (boot only) | no | OK |
| sim-pwa (transient) | 127.0.0.1:8096 | `/tmp/uxcalm-sim/pwa` | node `next start` (node_modules → `/tmp/uxcalm/pwa/node_modules` → `~/Work/bifrost-sandbox/pwa/node_modules`) | inline | 247527 (10-27 19:56) | yes (tmp + sandbox) | leftover 10-27 (U11) |
| sim-ygg (transient) | 127.0.0.1:4111 | `/tmp/uxcalm-sim/proj` | `~/Work/bifrost/lab/yggdrasil/target/release/yggdrasil` | inline (upstream = mock :18190, data `/tmp/uxcalm-sim/ygg`) | 247509, exe **`(deleted)`** — target rebuilt 10-28 21:18 | yes | leftover (U11) |
| sim-mock (transient) | 127.0.0.1:18190 | `$HOME` | `python3 ~/Work/bifrost/lab/yggdrasil/mock/mock_upstream.py 18190` | — | 247507 (10-27 19:56) | yes | leftover (U11) |
| agi-lane-PROVIDER-WAVE-2208536 (transient) | — | `~/Work/bifrost` | `scripts/agi-run.sh -s PROVIDER-WAVE` | — | 2208543 (10-28 20:36) — this audit's parent lane | yes (by design) | ACTIVE |

Tailscale serve (`tailscale serve status`): `https://omarchy.tail5435b1.ts.net` `/` → 127.0.0.1:8080, `/livekit` →
127.0.0.1:7880; `:8443` `/` → 127.0.0.1:8090. Both tailnet-only. Confirms :443→:8080 and :8443→:8090.
Two-roots law holds right now: :443 serves rc2 build `2-tWDJZQP2Pr6PIGTVDsF`, :8443 serves rc1 build `x98pDYwf55Jd18mFD3SJY`.
`NeedDaemonReload=no` on every fleet unit at audit time (no pending on-disk unit edits).

## §2 Working trees

Size = `du -sh` (btrfs; reflinked copies are counted in full). "trunk-only/branch-only" = `git rev-list --left-right --count rebuild/cohesive-opus...<branch>`.

| path | branch / HEAD | last commit | dirty | size | used by | verdict |
|---|---|---|---|---|---|---|
| `~/Work/bifrost` | rebuild/cohesive-opus 42d1263 (35 ahead of origin; pushes failing) | 10-28 | 61 (docs/prompts/labs untracked + package.json stamp) | 13G (node_modules 906M, .next 791M, `lab/bifrost-net/target` 3.5G, `lab/ygg-sim/target` 2.2G, `lab/yggdrasil/target` 1.8G) | the root's EnvironmentFile; live PWA state symlinks + artifacts (both slots); lk-verify; worldtree-fetch; sim-ygg/sim-mock; PROVIDER-WAVE lane cwd | **ACTIVE** (trunk + runtime state store) |
| `~/Work/bifrost-sandbox` | lab/sandbox 48cc64e (298 / 87) | 10-27 | 10 | 2.2G | next slot's `.diag`, `.push-subs.json`, `.oc-live.json`, `.oc-queue.json`, `.devices.json`, `.env.local` (symlinks from `next/*/pwa`); node_modules for `/tmp/uxcalm` → sim-pwa; base WD of bifrost-sandbox (overridden) | **ACTIVE** (lab line + next-slot state) |
| `~/Work/release-v07` | release/v0.7 1597e43 (298 / 69) | 10-27 | 0 | 484M (`pwa/node_modules` → `next/20261027-1735-c4b1908/pwa/node_modules`) | source of live rc2 + next rc1; node_modules target of `bifrost-provider-wave` | **RELEASE-LINE** |
| `~/Work/lane2-merge` | lane2/merge 2f3006d (172 / 42) | 10-06 | 9 (incl. `lab/yggdrasil/src/main.rs`, two pwa routes) | 3.9G (`lab/bifrost-net/target` 638M, `lab/yggdrasil/target` 1.2G) | **bifrost-bridge** (cwd + exe); base WD of lk-agent-ygg (overridden); lk-pwa-lan (disabled) | **ACTIVE-by-service / STALE code** |
| `~/Work/bifrost-provider-wave` | wave/provider-banner 5e6b1e7 (made today) | 10-28 | 0 | 643M (node_modules → release-v07's) | PROVIDER-WAVE lane | **ACTIVE** |
| `~/Work/bifrost-tool-scope` | lab/tool-scope c73bf47 (3 / 7) | 10-28 | 0 | 1.7G (`lab/yggdrasil/target` 1.2G) | none running; c73bf47 is an ancestor of wave/root-provider-toolscope 885122c (= `brain/yggdrasil-885122c`) | **ACTIVE** (lab done today; keep until 885122c ships) |
| `/tmp/pw-merge` | wave/root-provider-toolscope 885122c | 10-28 | — | — (was tmpfs) | **removed by its owner lane during this audit** (gone at 21:29; branch remains) | gone |
| `~/Work/release-v09` | release/v0.9.0 1b2058e (186 / 20) | 10-04 | 4 (package stamp + brief/log) | 3.1G (targets 466M + 1.1G) | none | **MERGED** into lane2/merge (ancestor) |
| `~/Work/wave-merge` | wave/rebuild 9c74edd (186 / 15) | 10-04 | 5 (package stamp + brief/log + e2e fixtures) | 1.9G | none | **MERGED** into lane2/merge (ancestor) |
| `~/Work/lane3-runbook` | lane3/runbook f0909b8 (186 / 22) | 10-04 | 0 | 48M | none | **STALE** (doc commits, unmerged) |
| `~/Work/bifrost-rebuild` | detached ab00e73 | 10-01 | 8 (WIP: `layout.tsx`, `settings/page.tsx`, 3 css, log) | 1.5G | none (ab00e73 = fork point of lab/sandbox) | **MERGED** (ancestor of trunk + release/v0.7) — WIP inside |
| `~/Work/bifrost-fix-hf` | fix/hf-persistence ab104ff (282 / 1) | 10-02 | 0 | 1.5G | none | **STALE** (1 commit on no other line) |
| `~/Work/bifrost-fix-stutter` | fix/voice-stutter 66611d2 | 10-03 | 2 (package stamp) | 1.5G | none | **MERGED** into wave/rebuild → lane2/merge (not trunk) |
| `~/Work/bifrost-fix-telemetry` | fix/telemetry-mode-awareness 80be87f | 10-04 | 0 | 2.0G | none | **MERGED** into lane2 except 1 docs commit |
| `~/Work/bifrost-fix-voice` | fix/voice-switch 5e75f89 | 10-03 | 0 | 6.1M | none | **MERGED** into wave/rebuild → lane2/merge |
| `~/Work/bifrost-ops-flip` | ops/flip-automation 4b3743f (272 / 3) | 10-03 | 4 (WIP `scripts/flip-ygg.sh` + 2 untracked) | 2.5G (`lab/yggdrasil/target` 1018M) | none | **STALE** (superseded by promote.sh / next-slot.sh) |
| `~/Work/bifrost-diag-ux` | diag/session-ux 65906dc (257 / 0) | 10-03 | 1 (untracked `docs/reviews/`) | 4.7M | none | **MERGED** (ancestor of trunk) |
| `~/.cache/ygg-vs-oc/wt-A..D` | detached 753b322 (on trunk) | 10-27 | 0 each | 8.4M each (+ `ygg-src` copy 2.0G, not a worktree) | none | **SCRATCH** (ygg-vs-oc lab, no open claim) |
| `/tmp/uxcalm` | detached ee81118 (on lab/sandbox) | 10-27 | 2 (package stamp) | 640M on **tmpfs** (RAM) | sim-pwa :8096 via node_modules chain | **SCRATCH** (in use by U11 leftovers) |

Non-worktree repos / stray dirs under `~/Work` (`find ~/Work ~ -maxdepth 3 -name .git`):

| path | kind | HEAD / date | size | used by | verdict |
|---|---|---|---|---|---|
| `~/Work/lab/yggdrasil` | standalone clone, no origin | master c5831c9 10-02 ("slice 2 GREEN") | 765M | none — the pre-import prototype of `bifrost/lab/yggdrasil` | **ORPHAN** |
| `~/Work/lab/yggdrasil-git-history.bak` | bare `.git` copy | 10-02 | 264K | none | **ORPHAN** (backup) |
| `~/Work/voice-lab` | repo, unborn branch (no commits), 11 untracked | — | 3.3G | voice-lab registry row ("dormant, hand-fed") | dormant lab — outside git history |
| `~/Work/veraldar-site` (+ worktree `veraldar-site-rebuild` @ rebuild/cohesive-opus ff25505 10-02, 1 dirty) | separate product | main 999c0ad 10-27 | 8.2M / 444K | veraldar.org deploy source | ACTIVE / the worktree STALE |
| `~/Work/veraldar-theme` | separate product | main 8741962 09-28 | 4.2M | glossary source of truth | ACTIVE reference |
| `~/Work/veraldar-hw` | PCB lab | master 9718fd4 10-04, 15 dirty | 1M | none | dormant |
| `~/Work/{dbzcraft,monster3d,yggdrasil-flow,yggdrasil-skid}` | unrelated, pre-bifrost | 09-22..09-29 | — | none | out of scope |
| `~/Work/livekit-opencode` | dir owned by uid 0, only `deploy/` | 09-24 | — | none | **ORPHAN** (sudo needed) |
| `~/Work/~/Work` (a dir literally named `~`) | empty, 10-28 11:40 | — | 0 | — | **SCRATCH** — a tool call with an unexpanded tilde |
| `~/Work/{fizz,parens,wc}.py`, `~/Work/__pycache__/` | 10-28 11:39–19:01 | — | KB | harness-bench tasks (`lab/harness-bench/tests/code-fizzbuzz`, `code-parentheses`) ran in the root's `YGG_PROJECT_DIR=~/Work` | **SCRATCH** (harness-bench-v1 claim still open) |

## §3 Duplicates / stale copies

1. **Five `agent.py` copies, three versions** (`sha256sum | cut -c1-12`):
   `9755c1879f88` (770 lines) = live release, next clone (both), `bifrost-sandbox`, `release-v07`, `bifrost-provider-wave` ·
   `29ae193b3468` (631) = trunk `~/Work/bifrost/agent` = previous release v0.6.1 ·
   `9af65620a11f` (629, 10-06) = **`~/Work/lane2-merge/agent`** — the lk-agent-ygg base WD ·
   `f4cbd1d92613` (546) = release-v09. The memory "sandbox tree's agent.py is stale" is now inverted: the sandbox copy
   equals live; the lane2-merge copy is the stale one, and it is what lk-agent-ygg falls back to on `next-slot.sh off`.
2. **Two divergent product lines.** lab/sandbox was cut from ab00e73 (10-01); release/v0.7 is built from it
   (ca990ca: "rc1 source = lab/sandbox@4028224 …"; c4b1908: "port two v0.6.1 fixes the fork never had").
   trunk vs release/v0.7 = 298 / 69 commits apart. STABLE.md still says "Trunk = rebuild/cohesive-opus (live's line)" —
   true for the root, false for the PWA/agent since v0.7.
3. **yggdrasil source copies**: trunk `lab/yggdrasil` (canonical; 412a9c4, 8bfd54f), `lab/tool-scope` (3/7), wave/root-provider-toolscope
   885122c, `lane2-merge/lab/yggdrasil` (dirty `src/main.rs`), `release-v09/lab/yggdrasil` (voice mode), standalone `~/Work/lab/yggdrasil`
   (10-02 prototype), `~/.cache/ygg-vs-oc/ygg-src` (2.0G). Only the trunk copy feeds a frozen binary.
4. **Built binaries vs running**: three frozen roots in `brain/` (412a9c4 running; 885122c + 8bfd54f staged 10-28 21:19, `sha256sum -c` OK;
   `brain/yggdrasil-8bfd54f` = trunk's `target/release/yggdrasil` 952c46a9…). sim-ygg and the bridge both run binaries **deleted from disk**
   (their target/ was rebuilt after they started) — a crash-restart would silently run different code.
5. **target/ build dirs**: 13.1G total across trees (trunk 7.5G; lane2 1.8G, release-v09 1.6G, tool-scope 1.2G, ops-flip 1.0G). 844G free on /home — size is not a problem; only lane2's `bifrost-net` target matters (bridge).
6. **Live runtime state lives in the trunk worktree** (by design, STABLE.md "Runtime state stays where it was"):
   `live/pwa/{.diag,.push-subs.json,.oc-live.json,.oc-queue.json,.devices.json}` → `~/Work/bifrost/pwa/…`; `live/artifacts` and
   `next/*/artifacts` → `~/Work/bifrost/artifacts` (643 files, 375M); `.diag` 141M. All gitignored → a `git clean -fdx` in `~/Work/bifrost`
   deletes the live push subscriptions, queue and diag. Same for the next slot vs `~/Work/bifrost-sandbox/pwa`.
7. **Root env readers** (all read the worktree file `~/Work/bifrost/lab/yggdrasil/yggdrasil.env`): lk-yggdrasil `EnvironmentFile` (at start);
   live PWA `YGG_ENV_FILE` (frozen `live-pwa.env`, read per `/api/onboard` request, only `YGG_UPSTREAM_BASE_URL`); bifrost-sandbox
   `YGG_ENV_FILE` (`bifrost-sandbox.env`); `scripts/next-slot.sh:106` (rc-pwa matrix serve); `lab/yggdrasil/verify-real-upstream.sh` (`./yggdrasil.env`);
   `scripts/test-stack.sh:14`. The new provider CLI (`provider.rs:1210`) reads `YGG_ENV_FILE` and writes only `~/.config/yggdrasil/providers.json`.
   No byte-identical copy exists elsewhere (older variants: `~/.config/yggdrasil/yggdrasil.env.superseded` 10-06,
   `~/.local/state/yggdrasil.env.pre-ogctx.bak` 10-06, `~/.local/state/bifrost-backup/yggdrasil.env.repo.orig` 10-04 — all differ in size).
8. **Unsupervised processes**: `opencode serve --port 4097` (PID 1393178, cwd `~/Work`, since 10-19 10:55, inside opencode-legacy's cgroup, 0 connections, no script references) ·
   `python3 /tmp/oc-cap/capture.py` on :4199 (PID 1742667, since 10-05, its directory no longer exists). where.sh still lists a
   RULER-V07 lane "RUNNING 28 h" whose PID 4128983 is gone.
9. **World-readable secrets** (mode 0644): `lk-agent-ygg.service` (inline LIVEKIT_API_KEY, LIVEKIT_API_SECRET); `.env.local` in
   `bifrost-sandbox/pwa` (the next slot's live env via symlink), `bifrost-rebuild`, `bifrost-fix-hf`, `bifrost-fix-telemetry`,
   `/tmp/uxcalm`, `/tmp/uxcalm-sim`, `/tmp/bifrost-sim`, `/tmp/bifrost-sim-rc2` (names: VAPID_PRIVATE_KEY, LIVEKIT_API_SECRET, …).
10. **Stale config**: `~/.config/bifrost/env/lk-pwa.env` (OPENCODE_URL only, no reader), `env/v0.6.1-draft/`, `~/.config/bifrost/bifrost.env`
    (v0.9 installer output from `lane2-merge/lab/yggdrasil/install/install.sh`, no running reader). `~/.config/bifrost/env/live-*.env` = byte-identical to `live/env/` (drafts in sync).
11. **Doc / tool drift**: STABLE.md "brain | opencode :4096 (opencode-serve)" (live brain is :4100 since rc2, `OPENCODE_URL=http://127.0.0.1:4100` in
    the live PWA env) and "Today the next slot still runs from a worktree" (frozen clone since 10-27). `bifrost-sandbox/AGENTS.md` "Sandbox layer"
    says :8090 serves this tree and "restart = rebuild visible" — now :8090 serves the clone, so where.sh's hint
    "MISMATCH: restart bifrost-sandbox (or rebuild)" cannot be fixed by a restart. Memory `sandbox-agent-runs-from-lane2.md` is stale (§3.1).
12. **next/ clones**: `next/current` → rc1 (switched 10-28 20:34, journal: both units restarted 20:34/20:36). The rc2 clone `next/20261027-1735-c4b1908`
    is not current but **is load-bearing**: `release-v07/pwa/node_modules` → it, and `bifrost-provider-wave/pwa/node_modules` → release-v07's.

## §4 One-true-location map (target state)

| piece | target | change from today |
|---|---|---|
| trunk code | `~/Work/bifrost` @ rebuild/cohesive-opus | — (build-only; no service reads it) |
| PWA/agent release line | release/v0.7 → `~/Work/release-v07` until merged into trunk | merge plan, not a location fix |
| live PWA + agent | `~/.local/share/bifrost/live` (release, env inside) | state → `~/.local/state/bifrost/live/` (later, promote.sh) |
| next slot PWA + agent | `~/.local/share/bifrost/next/current` | state → `~/.local/state/bifrost/next/` (later, next-slot.sh) |
| the root binary | `~/.local/share/bifrost/brain/yggdrasil-<sha>` | — |
| **the root's env** | **`~/.config/yggdrasil/yggdrasil.env` (0600)** — the install layout (`lab/yggdrasil/install/README.md`, PKGBUILD), the PWA's built-in fallback for `YGG_ENV_FILE`, sibling of the provider system's `providers.json` | U1 |
| the root's store | `~/.local/share/yggdrasil/session`; tool project dir `~/Work` | consider a scratch project dir for bench runs |
| bridge binary | `~/.local/share/bifrost/bridge/bifrost-net-<sha12>`, cwd `~/.local/state/bifrost-bridge` | U4 |
| lk-agent-ygg fallback (`next-slot.sh off`) | `~/Work/bifrost-sandbox/agent` (= live's agent.py) | U2 |
| timers | run from their own checkout, never commit into the trunk tree a human/lane is using | U5, U6 |
| artifacts | `~/Work/bifrost/artifacts` (the documented delivery path) | — |

## §5 Migration / cleanup list

Every command below is **for a human to run later**; none was executed. "SAFE-NOW" = changes no running process (the drop-in
takes effect only on the next deliberate restart and points to byte-identical bytes) — each one says so. Before any `daemon-reload`:
`systemctl --user show -p NeedDaemonReload --value lk-pwa lk-agent lk-yggdrasil bifrost-sandbox lk-agent-ygg bifrost-bridge opencode-legacy`
must print only `no` (so the reload loads nothing but the new drop-in). Coordinate with any lane holding a claim on the unit (PROVIDER-WAVE holds
the root until it reports).

### Unit fixes

**U1 (a) — the root's EnvironmentFile lives in the trunk worktree.**
Why: a `git clean -fdx`, a lane editing `lab/yggdrasil/yggdrasil.env` for a test, or a checkout that drops it changes or kills the root on its next
(crash-)restart (`Restart=on-failure`, `RestartSec=2`); frozen.conf froze the binary but not the env.

- U1.1 **SAFE-NOW, deferred to the user's root deploy window** (docs/reviews/provider-wave.md §5 step 2b: it is the live root's unit) — byte-identical copy + drop-in. Changes no running process: PID 1861609 keeps its environment; the next restart reads identical bytes.
  ```bash
  install -m 600 ~/Work/bifrost/lab/yggdrasil/yggdrasil.env ~/.config/yggdrasil/yggdrasil.env
  cmp ~/Work/bifrost/lab/yggdrasil/yggdrasil.env ~/.config/yggdrasil/yggdrasil.env && echo identical
  cat > ~/.config/systemd/user/lk-yggdrasil.service.d/env.conf <<'EOF'
  # locations-audit U1 (10-28): the root's env lives outside every git tree (install layout, sibling of providers.json).
  # Takes effect on the next restart only. Revert: rm this file && systemctl --user daemon-reload
  [Service]
  EnvironmentFile=
  EnvironmentFile=%h/.config/yggdrasil/yggdrasil.env
  EOF
  systemctl --user daemon-reload
  systemctl --user show -p EnvironmentFiles lk-yggdrasil     # expect only ~/.config/yggdrasil/yggdrasil.env
  systemctl --user show -p MainPID --value lk-yggdrasil      # expect the same PID as before (1861609)
  ```
- U1.2 **SAFE-NOW** (after U1.1) — make the worktree path a symlink to the config copy, atomically (rename over the file, no missing-file
  window). Every other reader (§3.7) keeps reading the same bytes; `git clean -x` would then remove only the link. Edits through the old path
  still reach the root (same as today) — U1.3 removes that.
  ```bash
  cd ~/Work/bifrost/lab/yggdrasil
  cp -p yggdrasil.env ~/.local/state/bifrost-backup/yggdrasil.env.worktree-20261028
  ln -s ~/.config/yggdrasil/yggdrasil.env yggdrasil.env.new && mv -T yggdrasil.env.new yggdrasil.env
  cmp ~/.local/state/bifrost-backup/yggdrasil.env.worktree-20261028 yggdrasil.env && echo same-bytes
  ```
- U1.3 **NEEDS-USER-GO** — point every reader at the config path: edit `YGG_ENV_FILE` in `~/.config/bifrost/env/bifrost-sandbox.env` (takes
  effect on the next bifrost-sandbox restart = the user's daily :8443); edit the draft `~/.config/bifrost/env/live-pwa.env` then
  `scripts/promote.sh --env-only --label v0.7.0-rc2-env1` (a gated live switch); change `scripts/next-slot.sh:106`, `scripts/test-stack.sh:14`,
  `lab/yggdrasil/verify-real-upstream.sh` (commit). Then `rm ~/Work/bifrost/lab/yggdrasil/yggdrasil.env` (the link).
- Rejected option: a frozen 0400 copy beside the binary in `brain/`. Key/model/provider changes are config, not binary; the provider system already keeps its file in `~/.config/yggdrasil/`.
- Note: `~/.config/yggdrasil/yggdrasil.env.superseded` (10-06, old values) sits in that dir — leave it; no unit references `~/.config/yggdrasil` today (`grep -r config/yggdrasil ~/.config/systemd/user` = empty).

**U2 (b) — lk-agent-ygg's base WorkingDirectory is `~/Work/lane2-merge/agent`.**
Today it runs from the next clone (next-slot.conf), so the memory note is stale. The risk is the fallback: `next-slot.sh off` (or deleting
next-slot.conf) silently runs lane2-merge's 629-line 10-06 agent (§3.1) with the lab pin `AGENT_LOAD_THRESHOLD=0.99`.
- U2.1 **SAFE-NOW** — fallback drop-in sorted *before* next-slot.conf (`00-` < `next-slot`), so the effective WorkingDirectory stays
  `next/current/agent` while the next slot is on. Nothing running changes, and the effective config doesn't change either.
  ```bash
  cat > ~/.config/systemd/user/lk-agent-ygg.service.d/00-fallback.conf <<'EOF'
  # locations-audit U2 (10-28): with next-slot off, run the sandbox tree's agent (= live's agent.py), never lane2-merge's 10-06 copy.
  # next-slot.conf (sorted later) still wins while the next slot is on. Revert: rm this file && systemctl --user daemon-reload
  [Service]
  WorkingDirectory=%h/Work/bifrost-sandbox/agent
  EOF
  systemctl --user daemon-reload
  systemctl --user show -p WorkingDirectory lk-agent-ygg      # expect …/.local/share/bifrost/next/current/agent (unchanged)
  ```
- U2.2 **APPLIED 10-28 (PROVIDER-WAVE)** — `chmod 600 ~/.config/systemd/user/lk-agent-ygg.service` (inline LIVEKIT secrets; systemd reads it as the same user; no reload needed).
- U2.3 **NEEDS-USER-GO** — move the LIVEKIT_* lines into a 0600 `EnvironmentFile` (needs a restart of the next-slot agent to prove it).

**U3 (c) — bifrost-sandbox's cwd.** Code already runs from the frozen clone (PID 2208224 cwd `next/20261027-1730-ca990ca/pwa`); base WD
`~/Work/bifrost-sandbox/pwa` is the intended dev fallback of `next-slot.sh off`. **DON'T** edit next-slot.conf by hand (owned by `scripts/next-slot.sh`).
- U3.1 **APPLIED 10-28 (PROVIDER-WAVE)** — `chmod 600 ~/Work/bifrost-sandbox/pwa/.env.local` (the next slot reads it at start as the same user; no process changes).
- U3.2 **NEEDS-USER-GO** — move next-slot state (`.diag`, `.push-subs.json`, `.oc-*.json`, `.devices.json`, `.env.local`) out of the sandbox tree into
  `~/.local/state/bifrost/next/` (a `next-slot.sh clone()` change + a next-slot restart).

**U4 (d) — bifrost-bridge runs a deleted binary from `~/Work/lane2-merge`.**
- U4.1 **APPLIED 10-28 21:45 (PROVIDER-WAVE)**: sha verified 104b03b4…, `bifrost-bridge.service.d/frozen.conf` written, daemon-reload, PID 4008544 unchanged. Freeze the exact running bytes (read back from the live process) and point ExecStart at them. No process changes; the next restart runs
  identical code instead of the different 10-04 21:34 build now on disk. Re-check the PID right before running.
  ```bash
  P=$(systemctl --user show -p MainPID --value bifrost-bridge)          # 4008544 at audit time
  mkdir -p ~/.local/share/bifrost/bridge
  cp /proc/$P/exe ~/.local/share/bifrost/bridge/bifrost-net-104b03b4a489 && chmod 555 ~/.local/share/bifrost/bridge/bifrost-net-104b03b4a489
  sha256sum ~/.local/share/bifrost/bridge/bifrost-net-104b03b4a489   # expect 104b03b4a489ef6bf65e841e9cdba7097d2fa7e954d10373fae7228ed3e95be6
  mkdir -p ~/.config/systemd/user/bifrost-bridge.service.d
  cat > ~/.config/systemd/user/bifrost-bridge.service.d/frozen.conf <<'EOF'
  # locations-audit U4 (10-28): the bytes running since 10-04, frozen — never lane2-merge's target/. Revert: rm && daemon-reload
  [Service]
  ExecStart=
  ExecStart=%h/.local/share/bifrost/bridge/bifrost-net-104b03b4a489 bridge -c %h/.local/state/bifrost-bridge/bridge.toml
  EOF
  systemctl --user daemon-reload && systemctl --user show -p ExecStart bifrost-bridge
  ```
- U4.2 **NEEDS-USER-GO** — `WorkingDirectory=%h/.local/state/bifrost-bridge` in the same drop-in. The bridge holds no files under lane2-merge
  (`ls -l /proc/4008544/fd` = sockets + /dev/null), but cwd-relative reads aren't verified → apply it on a deliberate restart, then check `curl :7890`.

**U5 (d) — lk-verify commits and pushes from the trunk tree.** Its ExecStartPost commits `docs/environments.md` onto whatever branch
`~/Work/bifrost` has checked out (31757f6 on trunk today) while lanes work in that tree; push fails on auth. STABLE.md: "review before re-enabling".
- **NEEDS-USER-GO** — `systemctl --user disable --now lk-verify.timer` (the timer only — no service is running), then rehome it to its own detached worktree (`WorkingDirectory=` + no auto-push).

**U6 (d) — worldtree-fetch runs from `~/Work/bifrost/lab/worldtree-data`** (702M data; `wt run --commit` → `git commit -- .` on the trunk tree
when a tracked file changed). Live data loop publishing veraldar.org. **DON'T** move it now; target = its own checkout (NEEDS-USER-GO, outside the 14:30 window).

**U7 — opencode-legacy resolves `latest` through the mise shim.** A `mise` upgrade would change the rollback brain on its next restart.
- **SAFE-NOW, deferred to the user's window** (the rollback brain's unit; provider-wave.md §5 step 2c) — pin to the exact running exe (`readlink /proc/1350425/exe` = `installs/opencode/1.18.30/opencode`). No process changes.
  ```bash
  mkdir -p ~/.config/systemd/user/opencode-legacy.service.d
  printf '[Service]\nExecStart=\nExecStart=%%h/.local/share/mise/installs/opencode/1.18.30/opencode serve --port 4096 --hostname 127.0.0.1\n' \
    > ~/.config/systemd/user/opencode-legacy.service.d/pin.conf
  systemctl --user daemon-reload && systemctl --user show -p ExecStart opencode-legacy
  ```

**U8 — opencode-serve** (disabled, same :4096): **NEEDS-USER-GO** to archive the unit file (`mv ~/.config/systemd/user/opencode-serve.service ~/.local/state/bifrost-backup/` + daemon-reload; where.sh lists it). **DON'T** start it (port clash with legacy).
**U9 — lk-pwa-lan** (disabled; lane2-merge/pwa; unauthenticated LAN :8082): **DON'T** enable. Archiving the unit file = NEEDS-USER-GO (gate.py lists it in `LAB_UNITS`).
**U10 — fleet-watchdog.timer**: **DON'T** enable (STABLE rule 7).
**U11 — sim-pwa / sim-ygg / sim-mock** (10-27 ux-calm leftovers; sim-ygg exe deleted; /tmp data; holds `/tmp/uxcalm` + sandbox node_modules): **NEEDS-USER-GO**
`systemctl --user stop sim-pwa sim-ygg sim-mock` (not live, but running processes, and memory says churn runs use this sim stack).
**U12 — stray `opencode serve :4097` and `capture.py :4199`** (§3.8): **NEEDS-USER-GO** `kill 1393178` / `kill 1742667`. **DON'T** restart opencode-legacy to clear :4097.

### Trees and files

| id | what | why | risk | mark | command (later) |
|---|---|---|---|---|---|
| C1 | remove clean, merged/stale, unused worktrees: `bifrost-fix-voice`, `bifrost-fix-telemetry`, `bifrost-fix-hf`, `lane3-runbook`, `~/.cache/ygg-vs-oc/wt-A..D` | 0 dirty, no process, no inbound symlink; branch refs keep every commit (`git worktree add` restores) | low; deletes their ignored `.env.local` copies too (good) | SAFE-NOW | `git -C ~/Work/bifrost worktree remove ~/Work/bifrost-fix-voice` (repeat per path; never `--force`) |
| C2 | remove dirty merged/stale trees: `bifrost-rebuild` (WIP css/settings), `bifrost-ops-flip` (WIP flip-ygg.sh), `release-v09`, `wave-merge`, `bifrost-fix-stutter`, `bifrost-diag-ux` | 1–8 dirty files each would be lost | medium (WIP) | NEEDS-USER-GO | review `git -C <tree> status --short`, commit WIP to its branch, then `git worktree remove <tree>` |
| C3 | `~/.cache/ygg-vs-oc/ygg-src` (2.0G) | lab copy, no claim | rebuildable | NEEDS-USER-GO | `rm -rf ~/.cache/ygg-vs-oc/ygg-src` |
| C4 | `/tmp/uxcalm` worktree + `/tmp/uxcalm-sim`, `/tmp/bifrost-sim`, `/tmp/bifrost-sim-rc2` | RAM-backed tmpfs; 644 env copies | breaks U11 sim stack | NEEDS-USER-GO (after U11) | `git -C ~/Work/bifrost worktree remove /tmp/uxcalm` (2 dirty → review) ; `rm -rf /tmp/uxcalm-sim /tmp/bifrost-sim /tmp/bifrost-sim-rc2` |
| C5 | `~/Work/~` (literal), `~/Work/{fizz,parens,wc}.py`, `~/Work/__pycache__` | harness-bench output in the root's project dir | HARNESS-BENCH claim still open | NEEDS-USER-GO | `rmdir ~/Work/'~'/Work ~/Work/'~'` ; `rm ~/Work/{fizz,parens,wc}.py; rm -r ~/Work/__pycache__` |
| C6 | `~/Work/lab/yggdrasil` + `yggdrasil-git-history.bak` | pre-import prototype, no origin | unique history | NEEDS-USER-GO | `tar czf ~/.local/state/bifrost-backup/work-lab-yggdrasil-20261028.tgz -C ~/Work lab && rm -rf ~/Work/lab` |
| C7 | `~/Work/livekit-opencode` (uid 0) | empty deploy remnant | needs sudo | NEEDS-USER-GO | `sudo rm -rf ~/Work/livekit-opencode` |
| C8 | `chmod 600` world-readable env files | §3.9 secrets | none (same-user reads) | **APPLIED 10-28 (PROVIDER-WAVE), all 9 → 600** | `chmod 600 ~/Work/bifrost-sandbox/pwa/.env.local ~/Work/bifrost-rebuild/pwa/.env.local ~/Work/bifrost-fix-hf/pwa/.env.local ~/Work/bifrost-fix-telemetry/pwa/.env.local /tmp/uxcalm/pwa/.env.local /tmp/uxcalm-sim/pwa/.env.local /tmp/bifrost-sim/pwa/.env.local /tmp/bifrost-sim-rc2/pwa/.env.local ~/.config/systemd/user/lk-agent-ygg.service` |
| C9 | stale config: `~/.config/bifrost/env/lk-pwa.env`, `env/v0.6.1-draft/` | no reader | none | NEEDS-USER-GO | `mv … ~/.local/state/bifrost-backup/` |
| C10 | doc drift §3.11 (STABLE.md brain row + trunk line + next-slot sentence; sandbox AGENTS.md "Sandbox layer"; where.sh MISMATCH hint + stale lane row; memory `sandbox-agent-runs-from-lane2.md`) | wrong advice ("restart bifrost-sandbox") | none (docs) | SAFE-NOW | doc edits + commit |
| C11 | target/ dirs (13.1G) | disk 844G free | lane2's is the bridge until U4 | DON'T (no value now) | — |
| — | **DON'T touch**: `~/Work/bifrost` (trunk + live state + the root's env until U1), `~/Work/bifrost-sandbox` (next-slot state, sim node_modules), `~/Work/release-v07` (release line, node_modules chain), `~/Work/lane2-merge` (bridge until U4), `~/Work/bifrost-provider-wave` + `~/Work/bifrost-tool-scope` (active today), `~/.local/share/bifrost/releases/*` (rollback contract: keep all), `next/20261027-1735-c4b1908` (node_modules of release-v07 + provider-wave), `brain/*`, `~/.local/share/yggdrasil`, `~/.local/share/opencode` (578M, :4096 store), `~/.local/state/bifrost-bridge` | live or load-bearing | high | DON'T | never `git clean -x`, `git worktree prune`, or `rm` here |

## §6 How this was gathered (2026-10-28, 21:00–21:30 CET)

Read-only commands only (no unit, file or tree was changed; `git status` may refresh a tree's index stat cache, nothing else):

```bash
git -C ~/Work/bifrost worktree list [--porcelain]
git -C <tree> branch --show-current | rev-parse --short HEAD | log -1 --format='%cs %s' | status --short
git rev-list --left-right --count rebuild/cohesive-opus...<branch>; git merge-base --is-ancestor <a> <b>; git cherry <up> <branch>
git branch -a --contains <sha>; git check-ignore -v <path>; git ls-files artifacts
find ~/Work ~ -maxdepth 3 -name .git -not -path '*/node_modules/*'
du -sh <tree> <tree>/pwa/node_modules <tree>/pwa/.next <tree>/lab/*/target
systemctl --user list-units --all --type=service,timer; list-unit-files; list-timers --all
systemctl --user cat <unit>          # Environment lines with KEY|SECRET|TOKEN|PASS filtered out of the output
systemctl --user show -p MainPID -p ExecStart -p WorkingDirectory -p ActiveEnterTimestamp -p DropInPaths -p NeedDaemonReload <unit>
readlink /proc/<pid>/cwd /proc/<pid>/exe; tr '\0' ' ' </proc/<pid>/cmdline; ls -l /proc/<pid>/fd
tr '\0' '\n' </proc/<pid>/environ | cut -d= -f1      # names; values printed only for paths/URLs/ports (YGG_ENV_FILE, YGG_DATA_DIR, OPENCODE_URL, …)
for p in /proc/[0-9]*; do readlink $p/cwd; done      # every process whose cwd is in a fleet tree
sha256sum ~/.local/share/bifrost/brain/* /proc/1861609/exe /proc/4008544/exe <target binaries>; sha256sum -c brain/*.sha256
cut -d= -f1 <env file>               # key names only; cmp for byte identity
ss -ltnp; ss -tnp; tailscale serve status; findmnt /tmp; df -h /home
journalctl --user -u bifrost-sandbox -u lk-agent-ygg -u lk-verify --since <today>
~/Work/bifrost/scripts/where.sh
```

Context read: `AGENTS.md`, `docs/STABLE.md`, `bifrost-sandbox/AGENTS.md` (Sandbox layer), `scripts/next-slot.sh` (incl. 42d1263 two-roots guard),
`scripts/where.sh`, `docs/claims.md`, `live/pwa/app/api/onboard/route.ts`, `lab/yggdrasil/src/provider.rs`, `lab/worldtree-data/wt/gitops.py`.
Drift during the audit: trunk moved 8bfd54f → 42d1263, wave/provider-banner 6e4ee9c → 5e6b1e7, `/tmp/pw-merge` was removed by its owner lane, two
staged brain binaries appeared at 21:19. No injected instructions were found in the files read.
