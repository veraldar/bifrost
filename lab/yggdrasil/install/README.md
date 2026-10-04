# bifrost — install on your own Linux box (native, no docker)

One command installs the whole stack as **systemd user services**. It needs no root, no
docker and no accounts other than the model provider you already have. You talk to it from
your phone over your own Wi-Fi.

## One command

```sh
git clone https://github.com/veraldar/bifrost.git && cd bifrost/lab/yggdrasil/install
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
   and lands on your **main** session. There's nothing to type.
3. **Add it to the home screen** from the browser menu.

Pairing is the lock (`BIFROST_AUTH=devices`). A device that hasn't paired gets `401` on every
`/api` call. You can list or revoke phones at `/devices`.

## Where things live

| path | what |
|---|---|
| `~/.config/bifrost/bifrost.env` (600) | **the stack config you edit**: ports, LAN IP, pairing, voice, LiveKit |
| `~/.config/yggdrasil/yggdrasil.env` (600) | the brain: upstream URL, key, model |
| `~/.config/bifrost/{app,agent,voice}.env`, `bridge.toml`, `livekit.yaml` (600) | generated from `bifrost.env` on every run. Don't edit these |
| `~/.config/bifrost/install-manifest.txt` | every file, unit, env key **name** and network call of the last run |
| `~/.config/systemd/user/{yggdrasil,bifrost-*}.service` | the units (644, no secrets inside) |
| `~/.local/state/bifrost/devices.json` | paired phones (the app and bridge share it) |
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
`--direct` (no systemd, see failure 2), `--brain-only` (the brain alone, below).

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
