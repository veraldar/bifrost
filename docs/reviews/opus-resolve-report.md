# Machine resolve report — multi-instance cleanup (2026-10-06, ~21:05–21:15 CEST)

Requested by the Veraldar fleet coordinator. Executed on `omarchy`, userspace only.
`sudo -n true` → **"a password is required"**, so nothing root-level was touched.

## TL;DR
- **The real split brain:** a detached yggdrasil (PID 3744969, started 21:04 from an opencode
  shell) held :4100 with `YGG_DATA_DIR=lab/yggdrasil/data` (14 old lab sessions). The supervised
  `yggdrasil.service` had the user store (`~/.local/share/yggdrasil`, 36 sessions) but had
  **crash-looped 92×** on `bind: AddrInUse`. Clients on :4100 saw the wrong store.
- Now: **one** yggdrasil = `lk-yggdrasil.service` (repo build + repo env), serving the user store.
  36/36 session files are byte-identical to the pre-cleanup checksums. The API lists 36.
- I killed 4 detached strays (yggdrasil, the ssh launcher, the stale mesh node, a duplicate agent worker).
- Pinned per-service env files: lk-pwa → 4096, bifrost-sandbox → 4100.
- **The brief got some things wrong** (see "Corrections"). Most importantly, the "root-owned yggdrasil
  instances" are inside the `ygg-sim` **docker container**, the simulator. They aren't strays and I left them alone.

## Corrections to the brief
| Brief said | Actual |
|---|---|
| 4 host yggdrasil instances | 1 userspace detached (3744969) + 1 crash-looping unit + **2 inside docker `ygg-sim`** (3021805 `/root/.local/bin`, 3717036 `/opt/bifrost/...`, cgroup `docker-76c6a726…scope`) |
| PID 3258662 | did not exist |
| `lab/yggdrasil/yggdrasil.env` = the user session data | it pointed at `lab/yggdrasil/data` (lab/test store). User data is `~/.local/share/yggdrasil`. Fixed in the env. |
| "orphaned ssh tunnel" 2894213 | not a tunnel. `ssh -f veraldar` launched `yggdrasil-bin serve` **on veraldar** via setsid/nohup. Killing the local ssh does not stop that remote node. |
| lane2-merge = abandoned worktree | **3 live units still run from it**: `bifrost-bridge`, `lk-pwa-lan` (:8082 pairing), `lk-agent-ygg`. `~/.local/bin/yggdrasil` was also the lane2-merge build. |

## Audit — before / after
| PID | Owner | What / binary | Data / config | Port | Supervisor (cgroup) | Action | After |
|---|---|---|---|---|---|---|---|
| 3744969 | user | yggdrasil `~/.local/bin` (lane2-merge build, Oct 6 16:49) | `lab/yggdrasil/data` (14 sess) | 4100 | detached (opencode-serve) | **killed**: wrong store, blocking the unit | gone |
| — | user | `yggdrasil.service` → `~/.local/bin/yggdrasil`, `~/.config/yggdrasil/yggdrasil.env` | `~/.local/share/yggdrasil` (36) | 4100 | systemd, crash-loop ×92 | **disabled + removed** (copy in backup dir) | replaced by `lk-yggdrasil` |
| new | user | yggdrasil `bifrost/lab/yggdrasil/target/release` (repo build) | `~/.local/share/yggdrasil` (36) | 4100 | `lk-yggdrasil.service` | **created** | running, NRestarts=0 |
| 3021805 | root (container) | `/root/.local/bin/yggdrasil` + bifrost-net bridge, voice uvicorn :8010, livekit-server | container-internal | 8010, 79xx | docker `ygg-sim` | left alone (simulator) | unchanged |
| 3717036 | root (container) | `/opt/bifrost/lab/yggdrasil/install/yggdrasil` | container-internal | — | docker `ygg-sim` | left alone | unchanged |
| 3949602/05, 3955011/14, 3974866/69 | root | `<defunct>` yggdrasil/bifrost-net zombies | — | — | `ygg-sim` (parent 3710573) | can't reap without root/container restart | needs-user (harmless) |
| 2894213 | user | `ssh -f veraldar … yggdrasil-bin serve` | — | — | detached (opencode-serve) | **killed** | gone (remote node on veraldar still up, see below) |
| 2926113 | user | `bifrost-net serve -c config-omarchy.toml` (binary **deleted** on disk) | `bifrost/lab/bifrost-net` | udp 51820 | detached (opencode-serve) | **killed**: stale mesh node | gone |
| 3816637/3816663 (+forkserver children) | user | lane2-merge `agent.py start` (Oct 4) | lane2-merge/agent | 18091 | detached (opencode-serve) | **killed**: duplicate LiveKit worker that could steal dispatches | gone |
| 4008544 | user | bifrost-net bridge (lane2-merge build) | `~/.local/state/bifrost-bridge` | 7890/tcp, 7891/udp | `bifrost-bridge.service` | kept (already 1×, supervised) | running |
| 3645681 tree | user | lane2-merge agent `bifrost-ygg` → 4100 | — | 18082 | `lk-agent-ygg.service` | kept | running |
| 3742257 tree | user | bifrost agent `bifrost-live` → 4096 | — | 8081 | `lk-agent.service` | kept | running |
| 3737400 → 3757481 | user | Next PWA (bifrost/pwa) | — | 8080 | `lk-pwa.service` | restarted with pinned env | 200 |
| 3621088 → 3755414 | user | Next sandbox PWA (bifrost-sandbox/pwa) | — | 8090 | `bifrost-sandbox.service` | restarted with env file | 200 |
| 4008555 | user | lane2-merge/pwa `server.mjs` | — | 8082 | `lk-pwa-lan.service` | kept | 200 |
| 2192792 | user | opencode serve | — | 4096 | `opencode-serve.service` | kept | 200 |
| 3545684, 3718823, 1742667 | user | fleet-watchdog mock :4097, http.server :8099, `/tmp/oc-cap/capture.py` | — | — | opencode / terminal | out of scope, left alone | unchanged |

## Units / config changed
- **`~/.config/systemd/user/lk-yggdrasil.service`** (new, enabled): `ExecStart=` repo build,
  `EnvironmentFile=bifrost/lab/yggdrasil/yggdrasil.env`, `WorkingDirectory=$HOME` (matches the old
  unit's tool root; the detached copy had used the lab dir), `Restart=on-failure`, same hardening as before.
- **`bifrost/lab/yggdrasil/yggdrasil.env`** (gitignored): `YGG_DATA_DIR` changed to `~/.local/share/yggdrasil`;
  added `YGG_VOICE=1`, `YGG_VOICE_MAX_WORDS=60` from the old unit env. Original saved.
- `yggdrasil.service` → disabled, moved to backup. `~/.config/yggdrasil/yggdrasil.env` renamed `.superseded`,
  so there is exactly one env for this service.
- **`~/.config/bifrost/env/lk-pwa.env`** (`OPENCODE_URL=http://127.0.0.1:4096`) via drop-in
  `lk-pwa.service.d/env.conf`. Process env takes precedence over `pwa/.env.local` in Next, so a flipped
  `.env.local` can no longer move the live PWA.
- **`~/.config/bifrost/env/bifrost-sandbox.env`** (PORT/HOST/`OPENCODE_URL=…4100`/BIFROST_AUTH): these were
  inline `Environment=` lines in `bifrost-sandbox.service` before.
- Backups: `~/.local/state/bifrost-backup/` (store tarball, sha256 list, original env/units).

## Verification (21:14)
- `:8080` 200 (lk-pwa, `OPENCODE_URL=4096` in process env) · `:8090` 200 (sandbox, `OPENCODE_URL=4100`) ·
  `:4100/session` 200, 36 sessions · `:4096` 200 · `:8082` 200.
- Host userspace: `yggdrasil` ×1, `bifrost-net` ×1. Every agent/next process maps to exactly one unit (checked by cgroup).
- Store: `sha256sum -c` on all 36 session files: unchanged.

## Needs the human
1. **Repo build lacks voice mode.** `grep YGG_VOICE` finds nothing in `bifrost/lab/yggdrasil/src`. Only
   lane2-merge and release-v09 have it. The old unit ran the lane2-merge build with `YGG_VOICE=1`. Per the
   order, the canonical binary is now the repo build, so **voice-length limiting on the ygg lane is off**
   until that code lands on `rebuild/cohesive-opus`. Quick revert: point `ExecStart` at `~/.local/bin/yggdrasil`.
   `YGG_MAX_TOKENS` is now 16384 (repo env); the old unit used 8192.
2. **lane2-merge isn't abandoned.** `bifrost-bridge`, `lk-pwa-lan` and `lk-agent-ygg` run from it. Its bridge
   build (Oct 4 21:34) is newer than bifrost's (12:52), and `bifrost/lab/bifrost-net` has uncommitted edits
   to bridge.rs, relay.rs, tokens.rs and others. I didn't repoint them because that could break paired devices.
   Merge lane2 first, then retarget the 3 units.
3. **`ygg-sim` docker container** (root): holds 6 zombie children. Restart it when convenient
   (`docker restart ygg-sim`). That's yours to decide, since it's the simulator.
4. **veraldar:** a `yggdrasil-bin serve` probably still runs there (started 10-04 via setsid). Check with `ssh veraldar pgrep -af yggdrasil-bin`.
5. **Lab-only sessions:** 5 sessions exist only in `lab/yggdrasil/data`, and one id (`ses_d4e4…`) differs. All are from Oct 3–4
   and look like tests. I did not merge them into the user store.
6. `lk-verify.service` was already in a failed state before this work. Not investigated.
7. `lk-agent-ygg.service` keeps the LiveKit API secret in an inline `Environment=`. Consider moving it to a 0600 EnvironmentFile.
