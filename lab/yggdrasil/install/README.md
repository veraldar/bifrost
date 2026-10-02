# yggdrasil — install

yggdrasil is a small HTTP server (one ~8 MB binary) that speaks the slice of
[opencode](https://opencode.ai)'s API that **bifrost** uses: sessions, messages, SSE events,
abort, and model/agent switching. It relays chat to any **OpenAI-compatible** endpoint, such as
OpenAI, OpenRouter, Ollama, llama.cpp or vLLM. Sessions are stored as JSON files on disk.

It runs as a **systemd user service**, the same way bifrost does on Omarchy/Arch. You don't
need root.

## 1. Install

You need either a prebuilt `yggdrasil` binary placed next to `install.sh` (release tarball), or
a Rust toolchain (`sudo pacman -S rust`, or rustup) so the script can build one.

```sh
cd lab/yggdrasil/install
./install.sh
```

It installs these files and touches nothing else:

| what | where |
|---|---|
| binary | `~/.local/bin/yggdrasil` |
| config (created once, never overwritten) | `~/.config/yggdrasil/yggdrasil.env` (mode 600) |
| systemd user unit | `~/.config/systemd/user/yggdrasil.service` |
| session store | `~/.local/share/yggdrasil/session/*.json` |

It also runs `systemctl --user daemon-reload`. It does **not** start the service until you've
configured an upstream (see `--now` below). Re-running it is safe: your config and sessions are
kept, and the binary and unit are replaced only if they changed. You can change the locations
with `BIN_DIR=…`, `XDG_CONFIG_HOME=…` and `XDG_DATA_HOME=…`.

**Arch package instead:** `cd install && makepkg -si`. This installs `/usr/bin/yggdrasil` and
`/usr/lib/systemd/user/yggdrasil.service`. Then copy the template:
`install -Dm600 /usr/share/doc/yggdrasil/yggdrasil.env.example ~/.config/yggdrasil/yggdrasil.env`.

## 2. Configure the upstream

Edit `~/.config/yggdrasil/yggdrasil.env`. Every variable is documented inline in that file.
Only the first one is required:

```sh
YGG_UPSTREAM_BASE_URL=https://api.openai.com/v1   # /chat/completions is appended
YGG_UPSTREAM_API_KEY=sk-...                       # leave empty for local servers
YGG_UPSTREAM_MODEL=gpt-4o-mini
YGG_LISTEN=127.0.0.1:4100
```

There's no authentication, so keep `YGG_LISTEN` on localhost or a tailnet address.

## 3. Run

```sh
systemctl --user enable --now yggdrasil      # or: ./install.sh --now
journalctl --user -u yggdrasil -f            # expect "yggdrasil listening on 127.0.0.1:4100"
```

If the URL is missing, the service exits with status 2 and does not restart-loop. Fix the env
file, then run `systemctl --user restart yggdrasil`.

## 4. Point bifrost at it

bifrost talks to opencode at `OPENCODE_URL`, which defaults to `http://127.0.0.1:4096`. Set it
in **both** places:

```sh
# bifrost/pwa/.env.local   (phone UI → /api proxy)
OPENCODE_URL=http://127.0.0.1:4100
# bifrost/agent/.env       (voice agent)
OPENCODE_URL=http://127.0.0.1:4100
```

Then run `systemctl --user restart lk-pwa lk-agent`. To switch back to opencode, remove the
lines and restart again.

## 5. Verify (one curl)

```sh
curl -sN -X POST http://127.0.0.1:4100/session/$(curl -s -X POST http://127.0.0.1:4100/session \
  | sed 's/.*"id":"\([^"]*\)".*/\1/')/message -H 'content-type: application/json' \
  -H 'accept: text/event-stream' -d '{"parts":[{"type":"text","text":"say hi"}]}'
```

You should see `event: message.part.delta` lines carrying the model's reply, ending with
`event: message.completed`. `curl -s http://127.0.0.1:4100/session` lists the stored session.

## Uninstall

```sh
systemctl --user disable --now yggdrasil
rm ~/.local/bin/yggdrasil ~/.config/systemd/user/yggdrasil.service
systemctl --user daemon-reload
# optional: rm -r ~/.config/yggdrasil ~/.local/share/yggdrasil   (config + chat history)
```
