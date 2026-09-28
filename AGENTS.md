# bifrost — voice-controlled opencode

Talk or type from the phone; the code you're changing lives here. Full architecture: `README.md`.

## Map
- `pwa/` — Next.js 15 phone client. `/api/*` proxy is the ONLY seam to opencode (phone never talks to it directly).
- `agent/` — Python livekit-agents worker: STT → opencode → TTS. Room slug = session slug.
- `deploy/` — docker compose: LiveKit (host net) + speaches fallback.
- `docs/plan.md` — checklist board, work top-to-bottom. `docs/open-questions.md` — every unresolved decision lands there.

## Hardware
This box runs everything. Mac Studio serves speech models (MLX Qwen3-ASR/TTS) on the LAN — endpoint in `agent/.env` (`SPEACHES_URL`). Private IPs/hostnames/ssh: `docs/local.md` (gitignored). Tailnet-only, nothing public.

## Verify
- pwa: `cd pwa && npm run build` + e2e: `cd pwa && npx playwright test`
- agent: `cd agent && uv run agent.py console` (local mic test)
- deploy: `cd deploy && docker compose up -d`
- services: `systemctl --user restart lk-pwa lk-agent opencode-serve`
- live diag: `tail pwa/.diag/$(date +%F).log`

## Rules
- Proceed autonomously; verify with evidence; contact user only when stuck or looping.
- No commits unless asked. Secrets stay out of git.

## Delivering files to the user — through the chat, never paths
The user is on the phone. They cannot open local paths, files on this box, or
LAN links. If it is not in the chat, they did not receive it — "it's at
/home/..." or "check the repo" is never an answer. Deliver every file in the
reply itself: save it to `artifacts/<name>.<ext>` in this repo root, then
reference it as `/api/artifact/<name>.<ext>`. Everything renders inline:
- Images (png/jpg/webp/svg/gif): markdown image `![description](/api/artifact/<name>.<ext>)`.
- HTML page/mockup: fenced ```html block, or save `.html` and link it — renders
  as a sandboxed frame.
- Markdown/text/code/config (md, txt, json, csv, log, yaml, py, ts, …): plain
  markdown link `[name](/api/artifact/<name>.<ext>)` — renders inline, md
  formatted. Write the file FIRST, then link it.
- PDF: plain markdown link → tap-to-view card. Audio (wav/mp3): inline player.
- Never point the phone at LAN IPs/ports — only `/api/artifact/...` is reachable.

## Parallel sessions (avoid overlap)
Before working: `git log --oneline -8` + read `docs/claims.md`. Working on something
non-trivial? Claim it FIRST (one line: scope + files + session name), delete the claim
when done. Commit small and often with req-linked messages — tests (cd pwa && npx
playwright test) are the referee: run them before claiming done. Never edit a file
another session holds a claim on unless merging deliberately.
