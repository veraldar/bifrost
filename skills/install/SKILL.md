---
name: install-bifrost
description: Install bifrost (voice + chat remote for opencode) on this machine — one command bootstrap, then verify. Use when asked to "set it up", "install bifrost", or deploy it on this box/VPS.
---

# Install bifrost on this machine

You are installing bifrost: a self-hosted voice-and-text remote for opencode
(Next.js PWA + LiveKit WebRTC + a Python voice agent + opencode itself).
Work autonomously; this skill is written to be followed blind by any agent
harness. Do not ask the user questions unless a step hard-fails twice.

## 0. Get the repo (skip if already inside it)

If the current directory is not the bifrost repo:

```bash
git clone https://github.com/veraldar/yggdrasil-bifrost.git && cd yggdrasil-bifrost
```

## 1. Check prerequisites

Needed: `git node npm curl openssl ip docker docker-compose-plugin uv` (all
verify steps are best-effort — the bootstrap degrades gracefully and prints
what it skipped). Tailscale is OPTIONAL (HTTPS for the phone; LAN HTTP works
without it).

**Node must be ≥ 22 (24 recommended)** — Tailwind 4's native engine silently
emits no CSS on older Node: the site loads but renders completely unstyled.
Check `node --version` first and install a current Node if older.

## 1a. macOS installs — LiveKit must NOT run in Docker

`network_mode: host` on macOS means the colima/Docker-Desktop **VM's** network,
not the Mac's. TCP gets forwarded, but the UDP media range (50000–50100) does
not: signal connects, then WebRTC media never establishes ("connecting…"
forever, and even the on-box agent fails with `agent worker left the room`).
This is the #1 macOS trap — check for it BEFORE the bootstrap:

- Run LiveKit **natively**: `brew install livekit`, then a launchd unit
  (`~/Library/LaunchAgents/com.opencode.livekit.plist`) running
  `livekit-server --config deploy/livekit.yaml`, KeepAlive+RunAtLoad. Keep
  speaches in Docker (it's TCP-only). Stop/skip the livekit compose service.
- `rtc.ips.includes` in livekit.yaml must list the Mac's **tailscale IP**
  (e.g. `100.x.y.z/32`) — that's what phones dial.
- If ICE-TCP port 7881 is taken (colima's forwarder squats it), move
  `rtc.tcp_port` to 7882.

## 2. Run the bootstrap

```bash
bash scripts/bootstrap.sh
```

It mints all secrets, writes `deploy/.env`, `deploy/livekit.yaml` (ICE pinned
to the detected IP), `agent/.env`, `pwa/.env.local` (VAPID keys included),
starts opencode/LiveKit/speaches/agent/PWA, and prints a verdict line
(`READY` / `PARTIAL`) with an ok/skip/FAIL list. Idempotent — safe to re-run.

First run on a box without opencode: re-run with
`BOOTSTRAP_INSTALL_OPENCODE=1 bash scripts/bootstrap.sh`, then run
`opencode auth login` once (needs the user's LLM provider key — the ONE thing
the bootstrap cannot mint).

## 3. Verify (do all of these, report each)

1. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/` → `200`
2. `curl -s http://127.0.0.1:8080/ | grep -o '<title>[^<]*</title>'` → `Bifrost`
3. **Styling**: extract the css link from the page
   (`curl -s http://127.0.0.1:8080/ | grep -o 'href="[^"]*\.css[^"]*"'`) and
   fetch it — must be `200`. A 200 page with a dead stylesheet renders
   unstyled (the Node-too-old trap from §1).
4. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4096/` → any HTTP code (opencode up)
5. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7880/` → any HTTP code (LiveKit up)
6. Full clean-room check (optional, heavy): `bash scripts/selfhost-check.sh`

### 3a. Phone-path verify — mandatory, on-box probes all lie

Every probe above runs on the box, where loopback works. The phone path can
still be completely dead. If tailscale is on, ALSO check:

1. `tailscale serve status` must show BOTH mounts:
   `/ → http://127.0.0.1:8080` **and** `/livekit → http://127.0.0.1:7880`.
   Missing `/livekit` → add:
   `tailscale serve --bg --set-path=/livekit http://127.0.0.1:7880`
2. `pwa/.env.local` `LIVEKIT_URL` must be
   `wss://<host>.ts.net/livekit` — **never** `ws://127.0.0.1:7880` (the phone
   would dial itself; and plain ws:// from an HTTPS page is blocked anyway).
   `agent/.env` keeps the loopback URL — only the PWA needs the public one.
3. Mint a token and check what the phone will receive:
   `curl -s -X POST http://127.0.0.1:8080/api/token -H 'Content-Type: application/json' -d '{"room":"canary"}'`
   → `serverUrl` must NOT contain `127.0.0.1`.
4. Media ports are actually listening: `ss -uln | grep 50000` (Linux) or
   `lsof -nP -iUDP:50000-50100` (macOS) — empty means no media path.
5. **Canary from another tailnet node** (the decisive test): from any second
   machine on the tailnet, mint a token via the served HTTPS URL, join with a
   livekit client (publish a track), and confirm the agent joins the room
   (`remote participants` contains `agent-*`) within ~10 s. If it hangs in
   `room.connect()`, media is broken regardless of what on-box checks say.
6. TTS deck: `curl -s -X POST http://127.0.0.1:8080/api/tts -H 'Content-Type: application/json' -d '{"text":"check"}'`
   → must return WAV bytes (starts with `RIFF`), not hang.
7. STT round-trip: synth a phrase via `POST $SPEACHES_URL/v1/audio/speech`,
   feed the wav to `POST $SPEACHES_URL/v1/audio/transcriptions`, expect the
   text back. A 404 here means the speech backend has no STT model (see traps).

Theme note: three themes ship in-repo (`aether`, `terminus`, `drift`),
picker at `/theme` — nothing external to install.

### Symptom-indexed traps (all real incidents, 2026-09-29 Mac install)

| Symptom | Cause | Fix |
|---|---|---|
| PTT: "connecting…" never completes (signal OK, then silence) | LiveKit in Docker on macOS — UDP media range dies in the VM | §1a: native LiveKit + launchd |
| PTT error `Unexpected end of JSON input` | `/api/token` 500 with empty body | check `pwa/app/api/token/route.ts` prod guard is gone; route must return JSON errors |
| Token returns `"serverUrl": "ws://127.0.0.1:7880"` | re-install minted env with loopback; serve mount missing | §3a steps 1–2 |
| Audio sent, no message lands in chat, agent log shows `('user','')` empty turn | STT backend 404s (speaches registry has no whisper STT) → empty transcript, bridge skips | point `agent/.env` SPEACHES_URL/STT_MODEL at a working backend (macOS: `deploy/mlx_wrapper.py`, Qwen3-ASR); verify via §3a step 7 |
| "get to speak" stuck at `synthesizing…` | `pwa/.env.local` missing `SPEACHES_URL`/`TTS_MODEL` — deck's /api/tts hangs | add the TTS block to pwa/.env.local, restart PWA |
| Speech service down after reboot | service run via nohup/screen instead of a supervisor | every long-running piece under launchd (macOS) / systemd (Linux) |

## 4. Report

Tell the user, in this order: verdict line from the bootstrap, which layers
are up (pwa / opencode / livekit / agent / speaches), what was skipped and
why, the URL to open (LAN or tailnet), and the single remaining manual step
if any (`opencode auth login`). If any verify probe failed, include the last
20 lines of `bootstrap.log`.

## 5. Updating an existing install

If bifrost is already installed here (a `bifrost/` clone with services
running), "update" means:

```bash
cd bifrost && git pull --ff-only
bash scripts/bootstrap.sh   # idempotent — existing secrets/configs untouched
```

Then rebuild/restart only what changed (the bootstrap does this), re-run the
verify steps in §3, and report the same summary as §4 plus the git short
hash now deployed (`git rev-parse --short HEAD`). Never delete or regenerate
existing `.env` files — secrets persist across updates.
