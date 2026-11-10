# LANE INSTALL — report (2026-10-04)

The full-stack, no-docker installer is in `lab/yggdrasil/install/`. Running `./install.sh`
installs the brain, app, bridge, voice, LiveKit (binary or cloud) and the voice agent as
systemd user units. `--brain-only` keeps the old behavior exactly.

It is verified in the clean `ygg-sim` container: **PASS-SIM**, 9/9 receipts, on a
from-scratch install of the final files. **Nothing is committed** (AGENTS.md: no commits
unless asked). **Live services were not touched.**

## Receipts (`scripts/install-sim.sh --fresh`, then `--receipts`)

All of these came from the ygg-sim container (host network, no systemd), curling from
inside it. Services ran through `install.sh --direct`, which runs each generated unit's own
`ExecStartPre`/`ExecStart` under nohup with that unit's `EnvironmentFile`. The units
themselves are what real boxes run.

```
PASS  brain   GET 127.0.0.1:4110/session → 200
PASS  app     GET 127.0.0.1:8092/ → 200 · /pair → 200
PASS  app     /pair console mint (loopback = box console): QR svg + bridge fp pinned
PASS  bridge  GET 127.0.0.1:7990/identity → 200 fp=sha-256 41:A9:B2:C4:98:…
PASS  seam    POST /api/session/<id>/messages → {"text":"PONG"}   (app → brain → z.ai → back)
PASS  devices a LAN peer without a device token: GET 192.168.1.89:8092/api/session → 401
PASS  livekit GET 127.0.0.1:7980/ → OK   (downloaded v1.13.7, sha256-checked, generated keys)
PASS  voice   GET 127.0.0.1:8010/healthz → 200 (models fetched on first start, ~48 s)
PASS  tts     app seam /api/tts/stream → local voice: 496220 bytes, audio=True  (scripts/tts-json-test.sh)
PASS-SIM
```

The sim uses ports that the live services don't use (brain 4110, app 8092, bridge
7990/7991, livekit 7980-7982, voice 8010). The real defaults are 4100, 8082, 7890/7891,
7880-7882 and 8000.

Two more checks ran in the container but are not in the sim script:
- **Agent install path.** `install.sh --no-start` with the agent included installed
  livekit-agents 1.8.4 into its venv, ran `agent.py download-files`, and wrote `agent.env`
  (600) plus `bifrost-agent.service`.
- **Agent registration.** Run against the sim LiveKit with the generated keys, the agent
  logged `registered worker agent_name=bifrost url=ws://127.0.0.1:7980`. The live
  lk-agent's :8081 still answered 200 afterwards.

## What the sim caught (fixed in the installer)

1. **The bridge binary needs `libopus.so.0`, which a clean Arch doesn't have.** The installer
   now checks `ldd` before installing and stops with
   `Arch: sudo pacman -S opus · Debian/Ubuntu: sudo apt install libopus0 · …`.
   The sim applies that exact printed fix and continues.
2. **python is missing on a clean Arch.** Voice and the agent are skipped *softly*: the core
   stack still installs and starts, and the installer prints the `pacman -S python` fix. A
   pip failure is also soft now, so voice can never block the brain, app or bridge.
3. **`cmp` and `hostname` are missing on a minimal Arch.** The installer uses `sha256sum` and
   `uname -n` instead.
4. **A missing first-run `bridge.toml` killed the run silently** (pipefail). Fixed, and an
   ERR trap now names the line on any failure.

## Decisions (deviations from the brief, with reasons)

- **App `HOST` defaults to `0.0.0.0`, not the LAN IP.** It also needs to listen on
  127.0.0.1, because in `devices` mode only the box's loopback console may mint the pairing
  QR. With the LAN IP alone, nobody could pair. `BIFROST_PUBLIC_URL=http://<LAN>:8082` makes
  the QR point phones at the LAN address. Set `BIFROST_APP_HOST` to change it.
- **`BIFROST_AUTH=devices` by default.** The live LAN listener runs `tailnet`, which on a
  stranger's LAN means anyone on the Wi-Fi can drive the brain and mint pairings. `devices`
  is the v0.9 design that the ladder gate tested; the receipt above shows the 401.
  Switching is one line in `bifrost.env`.
- **The `install/` dir is `lab/yggdrasil/install/`.** The repo is three levels up, not two,
  so the script walks up to find `pwa/package.json`. `BIFROST_ROOT` overrides it.
- **The voice agent is a sixth unit, `bifrost-agent`.** It wasn't in the brief's list, but
  without it LiveKit rooms have no agent and voice can't work.
- **The models download on first start, as asked.** The unit's `ExecStartPre` is
  `edge/get_models.sh`, which skips models that are already present, and
  `TimeoutStartSec=20min`.
- **Secrets stay out of units.** Units are 644 and hold no secrets. Every secret lives in a
  600 env/toml/yaml under `~/.config/bifrost/`, regenerated from `bifrost.env` on each run.

## Open findings (outside this lane's territory)

1. **LiveKit voice is broken in `devices` mode.** `pwa/app/api/token/route.ts:30` throws
   "THIS API ROUTE IS INSECURE" unless `BIFROST_AUTH=tailnet`; the sim answered 500. The
   middleware already gates `/api/token` with device tokens in `devices` mode, so the route
   check could accept `devices` too. That's a one-line product fix with its own gate, and
   the README lists it as a known limit.
2. **Talking from the phone needs https.** Browsers expose the mic only on secure origins,
   so on `http://<LAN>` the phone can type and hear replies but not talk. The README
   documents this.
3. **The live `yggdrasil.service` is crash-looping** (`status=101`, "Address already in use"
   on 127.0.0.1:4100). A hand-started yggdrasil (`~/.local/bin/yggdrasil`) holds the port.
   It is harmless until that process dies, but the unit restarts every 2 s and spams the
   journal. Not touched.
4. **`AGENT_HTTP_PORT` only takes effect with the uncommitted `agent/agent.py` change in
   this worktree.** The tagged v0.9.0 agent always binds :8081, which is fine on a clean box.
5. **Without `uv`, the agent's deps come from pip ranges** (`livekit-agents~=1.2` resolved to
   1.8.4), not `uv.lock`. With `uv` installed, the installer runs `uv sync --frozen`.

## Files (this lane; uncommitted)

`lab/yggdrasil/install/{install.sh,README.md,.gitignore,bifrost.env.example,bifrost-app.service,bifrost-bridge.service,bifrost-voice.service,bifrost-livekit.service,bifrost-agent.service}`,
`scripts/install-sim.sh` (new) and `scripts/tts-json-test.sh` (mode +x only), plus this
report. These were not mine: `agent/agent.py`, `pwa/package*.json`, `INSTALL-RUN.log`,
`LANE2-RUN.log`.

The sim is still up in ygg-sim on the ports above. To stop it:
`docker exec ygg-sim bash -c 'for f in /root/.local/state/bifrost/run/*.pid; do kill -- -$(cat $f); done'`.
To re-verify: `scripts/install-sim.sh --fresh` (about 5 min, including the app build).
