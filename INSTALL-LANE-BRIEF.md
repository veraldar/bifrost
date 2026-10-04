# LANE INSTALL — make install/ agree with the tree door: the WHOLE stack, no docker

The veraldar.org tree door hands users a docker image; our designed installer
is DIRECT: native, systemd user units, no docker. Today `install/` packages
only the brain. Tonight's live deployment (units running on this box) proved
every piece by hand — package that exact path. The user tests TONIGHT.

## Deliverables (extend `install/` in this worktree)

1. `install.sh` grows a full-stack mode (default) alongside the brain-only
   mode it has today (`--brain-only` keeps the old behavior):
   - **brain**: what it does now (prebuilt-first, env template, unit).
   - **app**: npm install + `npm run build` for `../../pwa` (relative to this
     dir), install a `bifrost-app.service` user unit running `node server.mjs`
     (PORT/HOST env, default 8082 + the LAN address), `BIFROST_DEVICES_FILE`
     pointing at the same state dir as the bridge, `OPENCODE_URL` → the local
     brain.
   - **bridge**: keygen + `bridge.toml` (http 7890, media udp 7891 on the
     LAN address, tokens_file = the SAME devices.json) + `bifrost-bridge.service`.
   - **voice (no docker)**: install `edge/voice_server.py` + its deps
     (sherpa-onnx) into a venv, `bifrost-voice.service`, and document that
     STT/TTS models download on first start. If the Mac MLX speech server is
     detected/reachable instead, the env template may point there — write
     both, default local.
   - **livekit**: NO docker. Two supported paths, chosen by env in the
     template: `LIVEKIT_MODE=binary` (download the livekit-server binary for
     the platform, dev keys + LAN advertise, its own unit) or
     `LIVEKIT_MODE=cloud` (user provides a LiveKit cloud URL/key/secret).
     Default: binary (so pairing + voice work on a clean box with zero
     accounts).
   - Every unit idempotent, every secret 0600, the manifest written
     (`install-manifest.txt`: files, units, env key NAMES, network calls).
2. `install/README.md` rewritten for a stranger: ONE command → what starts →
   what to open (the tree door /pair) → how the phone pairs → the four
   failure modes with fixes (port taken, no systemd session, voice models,
   firewall).
3. `scripts/tts-json-test.sh` (already in this worktree) stays as the TTS
   contract receipt.

## Verification (your own, before you report done)

There is a CLEAN Arch container `ygg-sim` already running on this machine
(host network, node+npm installed via pacman, the tagged tree at
`/opt/bifrost`, NO systemd — run the services directly with nohup there and
say so in the report; the units themselves are proven live on this box).
In it: copy your updated `install/`, place the prebuilt binaries, run
`install.sh` (full-stack mode; systemd steps will fail — replace with
direct nohup runs for the container, keep them for real boxes), then:
brain 200, app 200 (+/pair renders), bridge identity endpoint 200, a
message round-trip through the app seam returns a brain reply. Print
PASS-SIM with the four receipts. If the container fights you, run the
equivalent checks against the LIVE deployment on this box (all services
already up) and label which receipts came from where.

~50 min. Territory: `install/` + `scripts/` + docs you add, in THIS
worktree. Do not touch live services. Blocked twice → stop, write
INSTALL-SIM-REPORT.md, exit.
