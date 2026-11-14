# bifrost — install on your own Linux box (native, no docker)

One command installs the whole stack as **systemd user services**. It needs no root, no
docker and no accounts other than the model provider you already have. You talk to it from
your phone over your own Wi-Fi.

## One command

```sh
git clone https://github.com/veraldar/bifrost.git && cd bifrost/root/install
YGG_UPSTREAM_BASE_URL=https://api.openai.com/v1 YGG_UPSTREAM_API_KEY=sk-... ./install.sh
```

`YGG_UPSTREAM_BASE_URL` can be any OpenAI-compatible `/v1` endpoint: OpenAI, OpenRouter, a
local Ollama at `http://127.0.0.1:11434/v1`, llama.cpp, vLLM. For an Anthropic-shaped
provider, also pass `YGG_UPSTREAM_STYLE=anthropic`. Those values are written once to
`~/.config/yggdrasil/yggdrasil.env` (mode 600). You can leave them out and fill that file in
later, then re-run `./install.sh`.

**You need:** Linux (x86_64 or aarch64) with a systemd user session, Node.js ≥ 20 + npm,
python ≥ 3.10 with venv (for voice), libopus, curl, and about 3 GB of disk (the app build alone
is ~1.5 GB). On Arch:
`sudo pacman -S nodejs npm python opus`. On Debian/Ubuntu:
`sudo apt install nodejs npm python3-venv libopus0 curl`. Rust is needed only if there are
no prebuilt `yggdrasil` / `bifrost-net` binaries next to `install.sh` (a release tarball
ships them; otherwise the script runs `cargo build --release`).

## What starts

| unit | what | listens on |
|---|---|---|
| `yggdrasil` | **brain**: chat sessions, relays to your model provider | `127.0.0.1:4100` |
| `bifrost-app` | **app**: the phone UI and its `/api` seam (`node server.mjs`) | `0.0.0.0:8082` |
| `bifrost-bridge` | **bridge**: pairing identity + direct phone↔box transport | `:7890` tcp, `<LAN IP>:7891` udp |
| `bifrost-voice` | **voice**: local speech-to-text + text-to-speech (sherpa-onnx, CPU) | `127.0.0.1:8000` |
| `bifrost-livekit` | **livekit**: the realtime voice transport (`LIVEKIT_MODE=binary`) | `:7880`, `:7881` tcp, `:7882` udp |
| `bifrost-agent` | **voice agent**: speech in → brain → speech out | `:8081` (health) |

The script installs, enables and (re)starts each unit. Then it health-checks each one and
prints the result. Re-running it is safe. Your config, keys, paired phones and chats are
kept, and a unit is restarted only if something it uses changed.

## Pair your phone

1. **On the box itself**, open **http://127.0.0.1:8082/pair**. A QR code appears.
   Only the box's own console may show it.
   - Headless box? From your laptop, run `ssh -L 8082:127.0.0.1:8082 <box>` and open the
     same URL there.
2. **Scan the QR with the phone's camera.** The phone must be on the same Wi-Fi. It opens
   `http://<box LAN IP>:8082/pair`, redeems the one-time code, pins the bridge's fingerprint
   and opens bifrost: the first time, the door walks you in (it ends in your **main** session);
   after that, your sessions. There's nothing to type.
3. **Add it to the home screen** from the browser menu.

Pairing is the lock (`BIFROST_AUTH=devices`). A device that hasn't paired gets `401` on every
`/api` call. You can list or revoke phones at `/devices`.

**From anywhere, not just your Wi-Fi:** connect this box to [your own trunk](../../docs/own-trunk.md),
a small server you rent. `trunk.sh` on that server prints one line; here you run
`./install.sh --trunk '<that line>'`, then `./install.sh pair` shows the phone's QR right in the
terminal. The phone then opens `https://<your trunk>` on Wi-Fi or mobile data, and the app listens
only on `127.0.0.1`. `./install.sh pair --list` / `--revoke NAME` / `--kill` manage paired devices from
the terminal.

## Where things live

| path | what |
|---|---|
| `~/.config/bifrost/bifrost.env` (600) | **the stack config you edit**: ports, LAN IP, pairing, voice, LiveKit |
| `~/.config/yggdrasil/yggdrasil.env` (600) | the brain: upstream URL, key, model |
| `~/.config/bifrost/{app,agent,voice}.env`, `bridge.toml`, `livekit.yaml` (600) | generated from `bifrost.env` on every run. Don't edit these |
| `~/.config/bifrost/install-manifest.txt` | every file, unit, env key **name** and network call of the last run |
| `~/.config/systemd/user/{yggdrasil,bifrost-*}.service` | the units (644, no secrets inside) |
| `~/.local/state/bifrost/devices.json` | paired phones (the app and bridge share it) |
| `~/.local/state/bifrost/pair-qr.png` (600) | the last pairing QR from `install.sh pair` (one use, 5 minutes) |
| `~/.local/share/bifrost/voice/models/` | speech models (downloaded on first start) |
| `~/.local/bin/{yggdrasil,bifrost-net,livekit-server}` | the binaries |

To change something, edit `bifrost.env` and re-run `./install.sh`. You can also put a setting
on the command line, for example `BIFROST_APP_PORT=8090 ./install.sh`. It is saved to
`bifrost.env`.

**Voice choices** (in `bifrost.env`):
- `SPEACHES_URL=` empty (the default) uses the local `bifrost-voice`. Set it to a Mac MLX
  speech server on your LAN (`http://<mac-ip>:8001/v1`) and the local one isn't installed.
- `LIVEKIT_MODE=binary` (the default) downloads `livekit-server`, checks its sha256, and
  generates an API key and secret. `LIVEKIT_MODE=cloud` uses your LiveKit Cloud project: set
  `LIVEKIT_URL=wss://….livekit.cloud`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

Options: `--no-start` (install only), `--skip voice,agent` (leave components out),
`--direct` (no systemd, see failure 2), `--brain-only` (the brain alone, below),
`--trunk '<line>'` (your own trunk; `--trunk off` removes it; kept as `BIFROST_TRUNK` in `bifrost.env`).

## When it fails

**1. A port is taken.** The script stops *before installing anything* and names the port and
its owner, for example `port t/8082 (wanted by bifrost-app.service) is taken users:(("node",…))`.
Pick a free one in `~/.config/bifrost/bifrost.env` (`BIFROST_APP_PORT`, `BIFROST_BRIDGE_PORT`,
`BIFROST_MEDIA_PORT`, `BIFROST_VOICE_PORT`, `LIVEKIT_PORT` / `_TCP_PORT` / `_UDP_PORT`,
`AGENT_HTTP_PORT`; the brain's is `YGG_LISTEN` in `yggdrasil.env`). Then re-run. A port
held by this install's own running unit is fine.

**2. No systemd user session.** This happens over a bare `ssh`/`su`, in a container, or in
WSL without systemd. The script says `no systemd user session here`, writes the units and
starts nothing.
- On a normal box, log in properly once and run `sudo loginctl enable-linger $USER`, so the
  services also run while you're logged out and after a reboot. Then re-run `./install.sh`.
- Without systemd at all, run `./install.sh --direct`. It runs each unit's own command under
  `nohup`, with logs in `~/.local/state/bifrost/log/`. Re-run it after every reboot.

**3. Voice models.** `bifrost-voice` downloads its speech models (~200 MB, from the
sherpa-onnx GitHub releases) on its **first start**. Until then the health check shows it as
starting. Follow it with `journalctl --user -u bifrost-voice -f`.
- If python is missing, the script says `voice skipped — needs python ≥ 3.10`. Install it
  (`sudo pacman -S python` / `sudo apt install python3-venv`) and re-run. Everything else
  works without voice.
- On an offline box, copy `~/.local/share/bifrost/voice/models/` from a box that has it.

**4. Firewall: the phone can't reach the box.** The QR opens but the page never loads, or
pairing hangs. Allow the LAN in, then reload the page on the phone:

```sh
# ufw
sudo ufw allow from 192.168.0.0/16 to any port 8082,7890,7880,7881 proto tcp
sudo ufw allow from 192.168.0.0/16 to any port 7891,7882 proto udp
# firewalld
sudo firewall-cmd --permanent --add-port={8082,7890,7880,7881}/tcp --add-port={7891,7882}/udp && sudo firewall-cmd --reload
```

Also check that the phone is on the same Wi-Fi (not a guest network with client isolation)
and that the QR's address is the box's real LAN IP. If the box has several addresses, set
`BIFROST_LAN_IP` in `bifrost.env` and re-run.

**Known limits (v0.9):**
- **Talking from the phone needs https.** Browsers only open the microphone on a secure
  origin, and `http://<LAN IP>` isn't one. On the LAN you can type and hear replies; to talk,
  put the app behind https, for example `tailscale serve`.
- **LiveKit voice needs `BIFROST_AUTH=tailnet`.** The app's `/api/token` route still refuses
  in `devices` mode, so LiveKit voice works only with `BIFROST_AUTH=tailnet`. Use that only
  when the app is reachable solely over tailscale.

Logs: `journalctl --user -u yggdrasil -u 'bifrost-*' -f`. Status:
`systemctl --user status yggdrasil 'bifrost-*'`.

## Brain only

`./install.sh --brain-only` installs only yggdrasil, as before. That means the binary,
`~/.config/yggdrasil/yggdrasil.env`, the unit and the session store. It starts nothing unless
you add `--now`. Use it to put yggdrasil under an existing bifrost: set
`OPENCODE_URL=http://127.0.0.1:4100` for the app and the agent. **Arch package instead:**
`makepkg -si` in this directory (brain only; see `PKGBUILD`).

Brain settings (`yggdrasil.env`, documented inline): `YGG_UPSTREAM_BASE_URL` (required),
`YGG_UPSTREAM_API_KEY`, `YGG_UPSTREAM_MODEL`, `YGG_UPSTREAM_STYLE=anthropic` (for example
`https://api.z.ai/api/anthropic`), and `YGG_LISTEN` (keep it on 127.0.0.1: it has no
authentication). Check the brain alone:

```sh
curl -s http://127.0.0.1:4100/session        # 200 + a JSON list
```

## Join an existing tree

`join.sh` makes another machine (Linux, WSL2 Ubuntu or macOS) one more **root** of a tree that
already runs: the hub is up and your phone is paired with it. The new root only **dials out**,
to the hub's public access point (`wss://<hub>/rootlink`). It needs no open port, no public IP
and no certificate, and the phone doesn't have to be on the same Wi-Fi. No sudo.

```sh
git clone https://github.com/veraldar/yggdrasil.git && cd yggdrasil/root/install
./join.sh --hub https://tree.example.org --upstream-env ~/model.env
```

`~/model.env` describes this root's model, in the same format as `yggdrasil.env`:
`YGG_UPSTREAM_BASE_URL=…`, `YGG_UPSTREAM_API_KEY=…`, `YGG_UPSTREAM_MODEL=…` (plus
`YGG_UPSTREAM_STYLE=anthropic` for an Anthropic-shaped API). You can also export those variables
instead. If you run `join.sh` in a terminal without either, it asks for them, and the key is
read without echo. The key is written only to `brain.env` (mode 600) and is never printed.

What happens:
1. **Brain binary.** It uses `--brain-bin`, then `bin/yggdrasil` from an earlier run, then
   `root/target/release/yggdrasil`, then `~/.local/bin` or `PATH`. If none is there, it runs
   `cargo build --release`. With no Rust either, it prints exactly what to install
   (`build-essential pkg-config` + rustup, or `xcode-select --install` on macOS) and stops.
2. **Join request.** `POST <hub>/api/roots/join {name, os, host}`. A **QR of the approve URL**
   appears in the terminal (`qrencode -t ANSIUTF8` if it's installed, otherwise a built-in
   encoder). It's also saved as a PNG (`--qr-png`, opened with `--open-qr`). The code and the URL
   are printed below it.
3. **Approve.** Scan the QR with the paired phone, check that the code on the phone matches, and
   approve. `join.sh` polls until the request is approved, refused or expired. Ctrl-C keeps the
   request, and re-running resumes it with the same QR.
4. **Save.** It stores `root_secret`, the single-use **link tokens** (mode 600) and `rootlink_url`.
   Then it writes `brain.env`: loopback `YGG_LISTEN`, `YGG_DATA_DIR`,
   `YGG_ROOT_NAME=<root_id>`, `YGG_PEERS=<hub>=http://127.0.0.1:<peer port>/local` and
   `YGG_PEER_TOKEN`. `<hub>` is the hub brain's root name, from the approval's `hub` (`hub`
   when an older hub sends none). The joined root's reports go home to that name.
5. **Start.** It runs the brain plus
   `root-dial.py --tls --host --port --path --token-file --brain --peer-port`. Before every dial,
   and every 5 minutes, it tops up the link tokens through
   `POST <hub>/api/roots/<root_id>/tokens` when fewer than 5 are left.

| supervisor (`--supervisor auto` picks) | units |
|---|---|
| **systemd --user** (Linux, or WSL with systemd) | `yggdrasil-root-brain.service`, `yggdrasil-root-dial.service`, `yggdrasil-root-refill.timer` (+ linger, best effort) |
| **launchd** (macOS) | `~/Library/LaunchAgents/org.veraldar.yggdrasil-root.{brain,dial,refill}.plist` |
| **nohup** (no user manager: containers, WSL without systemd) | `bin/supervise` restarts all three. Logs are in `log/`. After a reboot, run `join.sh` again or `bin/start` |

Everything lives in `~/.local/share/yggdrasil-root` (`--dir`, mode 700): `root.json` (root id, root
secret, hub, the hub brain's name, rootlink URL), `link-tokens`, `brain.env`, `root.conf` (ports, name; no secrets),
`bin/` (`yggdrasil`, `root-dial.py`, `rootjoin.py`, `run-brain`, `run-dialer`, `start`, `stop`),
`data/`, `log/`.

**Re-running is safe.** With an existing join, `join.sh` (no options needed) sends no new request.
It refreshes the files and restarts only if something changed. `--rejoin` asks the hub again; the
old join stays until the new one is approved. A different `--hub` without `--rejoin` is refused.
`--stop` stops the services. Other options: `--name` (default: the hostname),
`--brain-port`/`--peer-port` (default 4180/4181, or the next free pair), `--project-dir` (default
`$HOME`), `--no-start`, `--build`. `--cacert` is only for tests against a self-signed hub.
Exit codes: `0` joined and running · `3` refused on the phone · `4` expired · `64` usage · `1` other.

**Windows:** `win/Veraldar-Setup.exe` (see `win/README.txt`). Its launcher checks for WSL2 (if it's
missing, it prints `wsl --install -d Ubuntu` and stops). It asks for the hub once, clones this
repo inside WSL (branch `BRANCH` in `launcher.bat`) and runs `join.sh`. The QR lands on the
Windows Desktop and opens there. `keepalive.vbs` keeps WSL and the root running, and starts them
at logon.

**Tests:**
- `./join-test.sh` runs locally; `./join-test.sh --docker` runs in a clean `ubuntu:24.04`. Both
  use a fake hub that speaks the contract above and a fake trunk on `/rootlink` that needs the
  real `root-dial.py` to link and earn a pong. They need `python3 openssl zbar-tools`, and `git`
  for the WSL bootstrap case.
- `win/launcher-test.sh` runs the installer, launcher and keepalive under wine with a recording
  fake `wsl.exe`.

## Upgrade / uninstall

Upgrade: `git pull`, then `./install.sh`. It rebuilds the app only if its sources changed,
and restarts only what changed.

Uninstall:

```sh
systemctl --user disable --now yggdrasil bifrost-app bifrost-bridge bifrost-voice bifrost-livekit bifrost-agent
rm ~/.config/systemd/user/{yggdrasil,bifrost-*}.service ~/.local/bin/{yggdrasil,bifrost-net,livekit-server}
systemctl --user daemon-reload
# optional, your data: rm -r ~/.config/bifrost ~/.config/yggdrasil ~/.local/share/{bifrost,yggdrasil} ~/.local/state/bifrost
```
