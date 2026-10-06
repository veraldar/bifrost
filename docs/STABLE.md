# STABLE — what is live, how it changes, and the ladder to v0.9

Written 10-06 (the multi-instance night) on the user's order: *"stop the madness —
define the plan, restart with gate, bridge — I need a stable version of bifrost to work."*
Revised 10-06 late (MAIN session) with the user's decisions: rollback/switching must be
easy, versions may run side by side, speech-to-text moves in-process, light prompts,
sim evolution + an Android app as the accelerator.

## What is live (the one answer to "what is latest stable?")

`scripts/promote.sh --list` answers it — `LIVE` marks the release serving the phone,
`PREVIOUS` the one `--rollback` returns to.

| piece | where | notes |
|---|---|---|
| PWA :8080 (`lk-pwa`) | `~/.local/share/bifrost/live/pwa` | tailnet URL in `docs/local.md` |
| voice worker (`lk-agent`) | `~/.local/share/bifrost/live/agent` | registers `bifrost-live` |
| env | `~/.local/share/bifrost/live/env/live-{pwa,agent}.env` (0400) | **inside the release** since v0.6.1 |
| brain | opencode `:4096` (`opencode-serve`) | the release's env says which brain |
| speech | Mac Studio MLX `:8001` (Qwen3-ASR STT + Qwen3-TTS), speaches `:8000` fallback | on the LAN — not cloud |

Releases: `v0.6-stable.1` (10-06 21:39 — c6a1b2d + the WIP overlay that ran, now
committed as a0b12b8) and `v0.6.1` (232b25c: the frozen source + the fixes below).
**Live since 10-06 23:17: `v0.6.1`** — gate `--full` GREEN (22 pass, 2 warn: lab worker
:18082 on 0.0.0.0, bridge lab spec skipped), e2e 46/46 on the release's own suite.
`v0.6.1` becomes **stable** after 48h of daily use with zero hand fixes (10-08 23:17).

Runtime state stays where it was (`~/Work/bifrost/pwa/.diag`, `.push-subs.json`,
`.oc-*.json`, `.devices.json` are symlinked into every release; artifacts via `ARTIFACTS_DIR`).

## Switching between versions (the rollback contract)

A release = code + build + deps + **env**, frozen in `~/.local/share/bifrost/releases/<id>`
(~2 GB each, keep them all — 860 GB free). `live` and `previous` are symlinks.

| you want | command | time | rebuild? |
|---|---|---|---|
| see every version | `scripts/promote.sh --list` | instant | — |
| undo the last change | `scripts/promote.sh --rollback` (again = redo) | ~1 min | no |
| any older/newer version | `scripts/promote.sh --switch v0.6-stable.1` | ~1 min | no |
| ship a commit | `scripts/promote.sh <commit> --label v0.6.2` | ~2 min | yes |
| change only settings (brain, STT model, voice) | edit the draft `~/.config/bifrost/env/live-*.env`, then `scripts/promote.sh --env-only --label …` | ~1 min | no (clone) |

Every switch runs the gate and goes straight back on RED. Env lives inside the release,
so rolling back v0.7 (an env-level brain flip) also rolls the brain back — no hand edits.
`~/.config/bifrost/env/` is only the draft the next release copies.

### Side by side (two slots)
Two versions can run at once, each a frozen release:
- **stable** — the tailnet URL on :443 → :8080 (`lk-pwa` + `lk-agent`, agent `bifrost-live`).
- **next** — the same host on **:8443** → :8090 (`bifrost-sandbox` + `lk-agent-ygg`, agent `bifrost-ygg`).

A different port is a different origin: install it as a second app ("bifrost next");
it has its own mic permission, notifications and storage, and talks to its own brain.
HTTPS with the tailnet certificate on :8443 is a secure context — the mic works there.
Verified on desktop Chrome and on **Android Chrome 133** (sim cycle 6, `app.chrome-mic-origin`:
:443 and :8443 both get a live mic track; the prompt names `<host>:8443`). What kills the
mic is **plain http on a LAN address** (`navigator.mediaDevices` undefined, no prompt —
same as diag 10-04). Permission is per origin, port included: a saved "Never allow" on
:8443 blocks it there only. Not provable on an emulator: your phone's Chrome version,
One UI battery rules, Android's mic privacy toggle — one probe run on the S22 closes it.
Today the next slot still runs from a worktree (`~/Work/bifrost-sandbox`) — making it a
frozen release (`promote.sh --slot next`) is the first step of v0.7.

## The boundary (the rules that stop the madness)

1. **Nothing is served from a worktree.** `~/Work/bifrost` and every other checkout
   are for building. Editing, `npm run build`, or `systemctl --user restart lk-pwa`
   there changes nothing live — the units run the frozen release.
2. **One way in:** `scripts/promote.sh` (above). `--snapshot` = HEAD + WIP, bootstrap/emergency only.
3. **The gate decides "stable", not a session's opinion:** `scripts/gate.py`
   (receipts in `~/.local/state/bifrost/gate/`). RED = not live.
4. **No session restarts, kills, or edits units/env of the live stack by hand.**
   No `kill -9`, no detached `setsid nohup` servers, no edits under
   `~/.config/systemd/user/lk-*` or inside a release. Broken live → run
   the gate, report, `promote.sh --rollback` if needed. That's all.
5. **Labs are labs:** a lab never uses the live ports (8080, 4096), the live agent
   name (`bifrost-live`), the live env files, or the live LiveKit dispatch name;
   anything listening beyond loopback requires device tokens (`BIFROST_AUTH=devices`).
6. **One brain per store, one supervised instance per service** (systemd units only).
7. **Autonomy is opt-in:** `fleet-watchdog.timer` and `scripts/ygg-driver.sh` were
   stopped 10-06 21:17. They come back only with the user's go and a registry that
   never includes the MAIN session.
8. **Freedom inside, walls outside.** Models get light prompts and their own judgment;
   safety lives in the harness (frozen releases, the gate, ports, tokens), never in
   long rule prose. Every rule above is enforced by a script, not by a prompt.

## The gate (what `scripts/gate.py` checks)

| check | why (the 10-06 failure it prevents) |
|---|---|
| release frozen / build served / units run from the release | production ran uncommitted code from the dev tree; rebuilds raced the server |
| units run the release's own env (`release.env`) | env edited by hand, half the stack on a different brain |
| one listener per live port, one worker per agent name | four yggdrasil copies; duplicate workers stealing dispatches |
| PWA dispatch name = worker name; PWA + agent on the release's brain | `bifrost` → `bifrost-live` rename left voice with no agent; `.env.local` split brain |
| health: page + CSS chunk, brain, speech | ChunkLoadError class; Mac speech down |
| no unauthenticated `/api/session` on any LAN address | `:8082`/`:8090` served a bash-capable brain to the home LAN (closed 10-06) |
| no unsupervised bifrost processes | detached spawns from agent shells |
| voice dispatch probe (agent joins a throwaway room) | 20:59–21:13: dispatches nobody answered |
| `--full`: Playwright e2e against :8080 | regressions in the app itself |

## The ladder — one structural change per version, each gated, previous = rollback

Each version lives on your daily use before the next one is promoted. The previous
release stays one `--rollback` away; any older one is one `--switch` away.

| version | the one change | gate to promote (on top of `gate.py` GREEN) |
|---|---|---|
| **v0.6.1** | none structural — frozen source committed, agent-name defaults unified, agent HTTP on loopback, releases carry their env + `--list/--switch/--env-only` | e2e `--full` green · 48h of daily use with zero hand fixes |
| **v0.6.2 speech** | speech-to-text **in-process** in bifrost's voice agent (no STT service); TTS stays a service (Mac MLX, speaches fallback) | WER ≤ today's on the lab fixtures, English **and French** · transcript ≤ 2 s after you stop talking on a 10 s utterance (Mac path today ≈ 0.6 s; Parakeet fp32 on this CPU ≈ 2.2 s — needs int8 or a smaller model) · the model is a path in the release env (a better model = `--env-only`) |
| **v0.7 tree** | yggdrasil becomes the brain (release env `OPENCODE_URL` → `:4100`); same phone UI, tailnet, LiveKit | first: next slot frozen + one yggdrasil line merged on trunk · every turn ends (reply or explicit error, never a silent hang) · voice mode · tool use · one supervised, backed-up store · a week in the next slot · rollback = `--rollback` (opencode keeps running all week) |
| **v0.8 bridge + app** | bifrost-net bridge as a second transport, device tokens on; first client = the **Android app** (WebView shell landed in `pwa/android`, sim cycle 6; needs a foreground-service mic — Android silences the app's mic ~1 s after screen-off while the page still sees a live track — then a native bifrost-net client; the bridge's 2 blocking workers must go async first: two tool runs push ping 151 ms → 4.3 s); tailnet + LiveKit stay as fallback | your phone pairs by QR · text + voice over the bridge with tailscale off · screen-off voice works · revoke kills access on the next request · no unauthenticated listener · sim `bridge.*` + `app.*` green |
| **v0.9 goal** | bridge-first, tailscale optional — bifrost + yggdrasil | valid HTTPS without tailscale (or the mic dies — see above) · v0.8 gates on a second phone (iPhone) · clean-box install · a week of use |

Why not jump to v0.9: it would swap the branch, the brain and the transport at once —
when it breaks nobody can say which part did, and nothing stable sits underneath.

### Decisions locked 10-06 (user) and why
- **STT in-process, in bifrost — not in yggdrasil.** The brain stays text-in/text-out,
  so swapping or rolling back the brain (v0.7) never takes speech with it, and the same
  STT moves into the bridge for v0.9. Measured (sim cycle 6, `voice.stt-inprocess`, this
  CPU-only box): **English passes** — WER parity, ~0.5 s per utterance vs ~5 s for the
  speaches fallback, 10 s utterance → 1.3 s (gate ≤ 2 s). **French does not yet** — 37%
  WER in-process vs 18% (multilingual Parakeet v3 int8: 31%); the Mac's Qwen3-ASR is best
  at French. v0.6.2 waits on a French model that passes (≥10 real human FR fixtures,
  more candidates); a better model later is an `--env-only` release.
- **TTS** stays a separate service (Mac MLX now); it may move into yggdrasil later.
- **Light prompts.** yggdrasil already sends no system prompt and 8 one-line tools — it
  is light. The weight is opencode's own system prompt + these AGENTS.md files. v0.7 gives
  yggdrasil a short context (where it runs, how files reach the phone, the boundary) and
  leaves judgment to the model (rule 8).
- **The simulator is the accelerator** (`lab/ygg-sim`, cycle per version, evolution rule
  in its ledger): it proves plumbing — transport, aborts, network chaos, roll-ups — fast
  and repeatably. It cannot prove model judgment or a real phone (screen-off, Doze, OEM
  audio); the Android emulator lane narrows that gap, your phone closes it.

### One line per piece (coherence)
Trunk = `rebuild/cohesive-opus` (live's line; GitHub `main` follows it). Labs merge into
trunk before their rung is promoted:
- v0.7 needs the three yggdrasil copies unified on trunk (`lab/yggdrasil` here,
  `release/v0.9.0` voice mode, `lane2/merge`), and `lk-agent-ygg` + `lk-yggdrasil` built
  from trunk (today: `~/Work/lane2-merge` and the worktree build).
- v0.8 needs `lane2/merge` bifrost-net (bridge) merged on trunk; `bifrost-bridge`
  runs from `~/Work/lane2-merge` today.
- The local tag `v0.9.0` (10-04, lane2 voice-mode merge, never pushed) is not the v0.9 of
  this ladder; release labels come from `--label`.

### Known bugs carried (v0.6.2 scope unless noted)
- **Two clients on one session break voice** — LiveKit identity is fixed per room
  (`user_<slug>`), so a second tab/phone kicks the first, and the agent's duplicate-yield
  relies on that identity. Needs per-device identity + agent changes + the sim's
  `bridge.multi-device` as referee. Workaround: one device per session.
- 5 stale `bifrost` dispatches parked in room `test-audi` (harmless, clear when the room closes).
- Lab worker HTTP `18082` on 0.0.0.0 (lane2-merge build; fixed on trunk via `AGENT_HTTP_HOST`).
- `lk-verify.service` (daily e2e + auto-push) has been failing; it also auto-commits
  and pushes `docs/environments.md` — review before re-enabling.

## Not live, by design (labs)
`bifrost-sandbox` :8090 (loopback; tailnet :8443) → `lk-yggdrasil` :4100 →
`lk-agent-ygg` (`bifrost-ygg`) — the v0.7 next slot. `bifrost-bridge` :7890 (lane2-merge
build, token-gated, 0 devices) — v0.8 material. `lk-pwa-lan` :8082 — disabled 10-06
(unauthenticated). `ygg-sim` docker — simulator, device-token gated.
