# STABLE — what is live, how it changes, and the ladder to v0.9

Written 10-06 (the multi-instance night) on the user's order: *"stop the madness —
define the plan, restart with gate, bridge — I need a stable version of bifrost to work."*

## What is live (the one answer to "what is latest stable?")

`v0.6-stable.1` — the stack used daily (tailscale + LiveKit voice agent + opencode),
frozen exactly as it ran on 10-06 evening:

| piece | where | notes |
|---|---|---|
| PWA :8080 (`lk-pwa`) | `~/.local/share/bifrost/live/pwa` | tailnet `https://omarchy.tail5435b1.ts.net/` |
| voice worker (`lk-agent`) | `~/.local/share/bifrost/live/agent` | registers `bifrost-live` |
| brain | opencode `:4096` (`opencode-serve`) | |
| speech | Mac Studio MLX `:8001`, speaches `:8000` fallback | |
| env | `~/.config/bifrost/env/live-pwa.env`, `live-agent.env` (0600) | the ONLY env of the live units |

`live` is a symlink to `releases/<id>`; each release holds `RELEASE.json` (base
commit, WIP overlay hash, build id, source manifest). `v0.6-stable.1` =
`c6a1b2d` + the uncommitted pwa WIP that was running (`OVERLAY.patch` in the
release) — committing it is the first step of v0.6.1.

Runtime state stays where it was (`~/Work/bifrost/pwa/.diag`, `.push-subs.json`,
`.oc-*.json`, `.devices.json` are symlinked; artifacts via `ARTIFACTS_DIR`).

## The boundary (the rules that stop the madness)

1. **Nothing is served from a worktree.** `~/Work/bifrost` and every other checkout
   are for building. Editing, `npm run build`, or `systemctl --user restart lk-pwa`
   there changes nothing live — the units run the frozen release.
2. **One way in:** `scripts/promote.sh <commit>` — builds a release, switches,
   runs the gate, rolls back on RED. `--rollback` returns to the previous release.
   (`--snapshot` = HEAD + WIP, bootstrap/emergency only.)
3. **The gate decides "stable", not a session's opinion:** `scripts/gate.py`
   (receipts in `~/.local/state/bifrost/gate/`). RED = not live.
4. **No session restarts, kills, or edits units/env of the live stack by hand.**
   No `kill -9`, no detached `setsid nohup` servers, no edits under
   `~/.config/systemd/user/lk-*` or `~/.config/bifrost/env/`. Broken live → run
   the gate, report, `promote.sh --rollback` if needed. That's all.
5. **Labs are labs:** a lab never uses the live ports (8080, 4096), the live agent
   name (`bifrost-live`), the live env files, or the live LiveKit dispatch name;
   anything listening beyond loopback requires device tokens (`BIFROST_AUTH=devices`).
6. **One brain per store, one supervised instance per service** (systemd units only).
7. **Autonomy is opt-in:** `fleet-watchdog.timer` and `scripts/ygg-driver.sh` were
   stopped 10-06 21:17. They come back only with the user's go and a registry that
   never includes the MAIN session.

## The gate (what `scripts/gate.py` checks)

| check | why (the 10-06 failure it prevents) |
|---|---|
| release frozen / build served / units run from the release | production ran uncommitted code from the dev tree; rebuilds raced the server |
| one listener per live port, one worker per agent name | four yggdrasil copies; duplicate workers stealing dispatches |
| PWA dispatch name = worker name; PWA + agent on the same brain | `bifrost` → `bifrost-live` rename left voice with no agent; `.env.local` split brain |
| health: page + CSS chunk, brain, speech | ChunkLoadError class; Mac speech down |
| no unauthenticated `/api/session` on any LAN address | `:8082`/`:8090` served a bash-capable brain to the home LAN (closed 10-06) |
| no unsupervised bifrost processes | detached spawns from agent shells |
| voice dispatch probe (agent joins a throwaway room) | 20:59–21:13: dispatches nobody answered |
| `--full`: Playwright e2e against :8080 | regressions in the app itself |

## The ladder — one big change per version, each gated, previous = rollback

Each version is promoted only when its gate passes, and lives on your daily use
before the next step starts. The previous release stays one command away.

| version | the one change | gate to promote (on top of `gate.py` GREEN) |
|---|---|---|
| **v0.6.1 stable** | none structural — commit the frozen source + fix the known v0.6 bugs (below) | e2e `--full` green · 48h of your daily use with zero hand fixes |
| **v0.7 tree** | yggdrasil becomes the brain (`OPENCODE_URL` → `:4100`); same phone UI, same tailscale/LiveKit | every turn ends (reply or explicit error, never a silent hang) · voice mode on · tool use works · one supervised store, backed up · a week on the sandbox (`:8443`) first · rollback = one env line |
| **v0.8 bridge** | bifrost-net bridge added as a second transport, device tokens on; tailscale + LiveKit stay as fallback | your phone pairs by QR · text + voice round trip over the bridge with tailscale off on the phone · revoke kills access on the next request · no unauthenticated listener |
| **v0.9 goal** | bridge-first, tailscale optional — bifrost + yggdrasil | v0.8 gates on a second phone (iPhone) · clean-box install · a week of use |

Why not jump straight to v0.9: it would swap the branch (lane2/merge, 57 commits
behind live), the brain and the transport at once, with no phone ever paired to
the bridge and a live yggdrasil hang — when it breaks nobody can say which part
did, and there is nothing stable underneath.

### Known v0.6 bugs (v0.6.1 scope)
- **Two clients on one session break voice** — the LiveKit identity is fixed per
  room (`user_<slug>`, `pwa/app/api/token/route.ts`), so a second tab/phone kicks
  the first, and every token mint dispatches another agent (the "duplicate agent"
  fixes of 10-02/10-06 patch the symptom). Workaround: one device per session.
- Agent-name defaults disagree in code (`token` route `bifrost`, `dispatch` route
  `bifrost-live`, `agent.py` `bifrost`) — only the env keeps them aligned.
- 5 stale `bifrost` dispatches parked in room `test-audi` (no worker answers that
  name any more; harmless, cleared when the room closes).
- Agent worker HTTP on `0.0.0.0` (8081 live, 18082 lab) — health only, should be loopback.
- `lk-verify.service` (daily e2e + auto-push) has been failing; it also auto-commits
  and pushes `docs/environments.md` — review before re-enabling.

## Not live, by design (labs)
`bifrost-sandbox` :8090 (loopback; tailnet :8443) → `lk-yggdrasil` :4100 →
`lk-agent-ygg` (`bifrost-ygg`) — the v0.7 staging. `bifrost-bridge` :7890 (lane2-merge
build, token-gated, 0 devices) — v0.8 material. `lk-pwa-lan` :8082 — disabled 10-06
(unauthenticated). `ygg-sim` docker — simulator, device-token gated.
