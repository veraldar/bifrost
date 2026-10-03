# Bifrost — talk to your coding agent from your phone

A voice-controlled opencode: speak or type on your phone (PWA), a LiveKit
voice agent bridges your words to a local [opencode](https://github.com/anomalyco/opencode)
server, and you get the answer back as text **and speech** — with markdown,
attachments, multi-session support, and frontend diagnostics.

## Easiest install: let an agent do it (Omarchy, Arch, Debian, any Linux box)

Open your coding agent (opencode, Claude Code, Codex, …) in an empty folder
and give it this one line:

```
https://raw.githubusercontent.com/veraldar/bifrost/v0.6.0/skills/install/SKILL.md set it up
```

That's the whole instruction. The agent fetches the skill, clones this repo,
checks prerequisites (Node ≥ 22, docker for voice), mints every secret,
starts LiveKit + opencode + the voice agent + the PWA, verifies each layer,
and prints a verdict + the URL to open. Already cloned? Say instead:
*"follow skills/install/SKILL.md and set it up"*. One manual step remains
afterwards: `opencode auth login` (your LLM provider key — nothing may mint
that for you). Prefer manual setup? Keep reading.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fveraldar%2Fyggdrasil-bifrost&root-directory=pwa&env=LIVEKIT_URL%2CLIVEKIT_API_KEY%2CLIVEKIT_API_SECRET%2COPENCODE_URL)

> One-click Vercel deploy of the PWA: after cloning, set the env vars
> `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (see
> `pwa/.env.example`). Text-mode needs `OPENCODE_URL` reachable from the
> deployment — keep opencode private (Tailscale), it has shell access!

## Using other AIs (Claude Code, Codex, …)

bifrost drives **opencode** natively — sessions, voice, queue, transcript.
Other AI CLIs are one sentence away, not one integration: from any session,
just ask — *"ask claude to review this diff"* or *"have codex write tests
for X"* — and the [delegate skill](skills/delegate/SKILL.md) runs them as
sub-tools, relays their output into your transcript, and works by voice too.
No config, no second login flow beyond the CLI's own auth.

## Your voice, your identity

Bifrost is built to run speech **on your own hardware** — your voice never
has to leave your machines. That's the setup we push. But you choose: local
models (CPU or MLX), or any cloud API for LLM and voice — American, Chinese,
European, open weights. The AI is yours to pick; the identity stays yours.

## Architecture

**Hardware** — 3 nodes, one Tailscale tailnet (no public exposure):

| Node | Role |
|---|---|
| Phone | PWA client (mic + UI), joins the tailnet |
| omarchy (Linux desktop) | all server layers: PWA, LiveKit, voice agent, opencode |
| Mac Studio (M3 Ultra) | local speech models via MLX/GPU on the LAN |

**Software layers** (top = user, bottom = model):

```
Phone (PWA: Next.js)                        Omarchy desktop
┌──────────────────────────┐                ┌──────────────────────────────────┐
│ sessions UI / transcript │   REST         │  opencode serve :4096            │
│ text + attachments  ─────┼───────────────►│  (sessions, prompts, streaming)  │
│                          │                │        ▲                         │
│ WebRTC media (mic/speech)│                │        │ llm.LLM adapter         │
│   ▼                      │                │  Python voice agent (livekit-    │
│ LiveKit server :7880 ◄───┼───WebRTC───────┤  agents)                         │
│ (docker, host net)       │                │   STT ⇄ opencode ⇄ TTS           │
└──────────────────────────┘                └───────┬─────────────┬───────────┘
        ▲                                           │ LAN         │ fallback
   tailscale serve                         Mac Studio :8001    speaches :8000
   (tailnet-only TLS)                      (MLX, GPU)          (docker, CPU)
```

**Local models** (no cloud speech APIs):

| Layer | Primary | Fallback |
|---|---|---|
| STT | Qwen3-ASR (MLX, Mac :8001) | speaches faster-whisper (CPU, :8000) |
| TTS | Qwen3-TTS (MLX, Mac :8001) | speaches Kokoro (CPU, :8000) |
| LLM | opencode's configured model (`VOICE_MODEL`) | — |

Everything is systemd-managed on omarchy (`lk-pwa`, `lk-agent`,
`opencode-serve`) + docker compose — reboots self-heal.

- **PWA (`pwa/`)** — Next.js 15 + Tailwind 4. Sessions list, transcript with
  markdown (Streamdown), image/file attachments, sandboxed HTML preview,
  pixel-art UI (pixelarticons), push-to-talk & hands-free voice modes.
- **Proxy (`pwa/app/api/*`)** — the phone never talks to opencode directly;
  the Next server proxies sessions/messages/tokens and stays the single
  auth/seam point. Also receives frontend diagnostics (`/api/diag`), log-only.
- **Agent (`agent/`)** — Python `livekit-agents` worker. Custom `llm.LLM`
  adapter maps LiveKit room → opencode session (room name = session slug),
  so voice turns land in the same transcript as text.
- **Deploy (`deploy/`)** — docker compose: LiveKit (host network, ICE pinned
  to tailnet + LAN IPs so phone media flows over Tailscale) + speaches STT/TTS.
- **Diagnostics** — the PWA records console errors, crashes, network timings,
  and taps, uploads them in batches, and they are logged server-side
  (`journalctl` + `pwa/.diag/*.log`). Log-only by design: no automatic fix
  sessions (a past auto-`autofix` experiment was removed as a bad idea).

## One-click install (self-host)

> **Minimum hardware:** ONE Linux box (any machine that runs Docker + Node) +
> your phone. No Mac needed — the CPU speech fallback (speaches, in the
> compose) works out of the box; a Mac Studio running MLX speech models is an
> optional quality upgrade (see `agent/.env.example` → `SPEACHES_URL`).
> Everything below runs on that one box; nothing needs to be public —
> Tailscale is the only network requirement (install it on box + phone).

```bash
git clone https://github.com/veraldar/bifrost.git && cd bifrost
scripts/selfhost-check.sh   # one-command check: can this box run the PWA? (clone→build→boot→probe)

# 0. opencode itself (the coding agent this whole thing drives)
#    install: curl -fsSL https://opencode.ai/install | bash   (or your package manager)
opencode auth login                          # configure your LLM provider key
opencode serve --port 4096 &                 # REST server on 127.0.0.1:4096

# 1. LiveKit + speech stack (cp example → real; edit .env LIVEKIT_KEYS and
#    livekit.yaml ICE IPs for your network — see deploy/livekit.yaml.example;
#    `tailscale ip` on the box gives the tailnet IP to pin)
cd deploy && cp livekit.yaml.example livekit.yaml && docker compose up -d && cd ..

# 2. Voice agent
cd agent && uv sync && cp .env.example .env  # edit values (SPEACHES_URL empty = CPU fallback)
uv run agent.py dev                          # or a systemd unit

# 3. PWA
cd ../pwa && npm install && cp .env.example .env.local  # edit values
npx web-push generate-vapid-keys --json      # paste into .env.local for push notifications
npm run build && npm start                   # :8080
tailscale serve --bg 8080                    # tailnet-only HTTPS
```

Or deploy just the PWA to Vercel with the button above and point it at your
LiveKit (and a network-reachable opencode).

## Env vars

| Var | Where | Purpose |
|---|---|---|
| `LIVEKIT_URL` | pwa / agent | signal URL (`wss://…` for web, `ws://127.0.0.1:7880` local) |
| `LIVEKIT_API_KEY/SECRET` | pwa / agent | token minting / worker auth |
| `OPENCODE_URL` | pwa / agent | opencode REST (`http://127.0.0.1:4096`) |
| `VOICE_MODEL` | agent | opencode model for spoken replies |
| `SPEACHES_URL`, `STT_MODEL`, `TTS_MODEL`, `TTS_VOICE` | agent | speech stack fallbacks |

## Roadmap

See `docs/plan.md` — invariants, current phase, deferred work. `docs/environments.md`
records where the system is installed and every automated test run (`npm run verify`,
also scheduled daily via a systemd timer).

## Support

Want to be part of the journey? Veraldar is free and stays free — but it
isn't free to build.

- GitHub Sponsors: `github.com/sponsors/veraldar` *(pending activation)*
- OpenCollective: `opencode Collective pending — transparent public ledger`

Every franc goes to hardware, hosting, and keeping the voice local.

## License

Bifrost is [AGPL-3.0](LICENSE) — copyleft including network use: modified
versions offered as a service must make their source available. Talking to
bifrost over its API does not make your app a derivative; interop stays free.

Attributions: PWA derives from
[livekit-examples/agent-starter-react](https://github.com/livekit-examples/agent-starter-react)
(Apache-2.0). Icons: [pixelarticons](https://github.com/halfmage/pixelarticons) (MIT).
