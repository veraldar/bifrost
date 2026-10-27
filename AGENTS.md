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
- services: this tree is served by `bifrost-sandbox` (:8090 → https :8443). Never restart `lk-pwa`/`lk-agent`/`opencode-*` from here — that is LIVE (see the layer below).
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

## Sandbox layer (S5, 10-27) — this tree is the user's daily stack
`lab/sandbox` → `~/Work/bifrost-sandbox`, served by `bifrost-sandbox` (:8090 → tailnet :8443). One call
tells you where everything is: `~/Work/bifrost/scripts/where.sh` (version · URL · what runs · what to test next).

### Build — the jitless recipe (when `cat /proc/self/cgroup` shows `lk-yggdrasil`)
A session spawned by the yggdrasil brain inherits `MemoryDenyWriteExecute`: plain `node` aborts with
`Check failed: 12 == (*__errno_location ())`. Stay inside the hardening, do not escape it with `systemd-run`:
- build: `cd pwa && NODE_OPTIONS="--jitless --require $HOME/Work/bifrost-sandbox/scripts/jitless-wasm-shim.cjs" npm run build` (2–4 min; the shim replaces webpack's WASM hashes)
- node has no `fetch` jitless → use `curl` in scripts
- Playwright: run the runner with `node --jitless` and `PW_JITLESS=1` (Chromium gets `--js-flags=--jitless`)
- `next start` jitless can't serve API routes — serve through the real unit (below), which has JIT
- Outside that cgroup (a normal shell) plain `npm run build` works. Say in your report which path you used.
- NEVER build inside this tree's `pwa/` while :8090 is serving it from `.next`: build in a scratch
  `git worktree add --detach /tmp/x <sha>` (symlink `node_modules`, copy `.env.local`), serve it with its own
  `scripts/sim-stack.sh` (own ports, mock brain), and swap only when green.

### Deploy / restart — the restart rule
- Restart = `systemctl --user restart bifrost-sandbox`, nothing else. After a restart `where.sh version`
  must show `:8090 serves build` = `built tree` (a mismatch means the old build is still being served).
- A build alone changes nothing visible; a restart alone serves the old build. You need both, in that order.
- New files under `pwa/public/` (voice pack, etc.) 404 until the restart, even with no rebuild.
- `scripts/deploy.sh` here is the OLD live-deploy script: it demands branch `main` and restarts **lk-pwa :8080
  (LIVE)**. Do not run it from this tree. Its sandbox replacement (build → restart `bifrost-sandbox` → probe →
  served BUILD_ID = built) is S3 RELEASE-TOOLING-V07; until it lands, build + restart by hand as above.
- Live moves only through `~/Work/bifrost/scripts/promote.sh` (docs/STABLE.md). Never touch :8080/:4096/`bifrost-live`.
- Tests: plain `npx playwright test` targets LIVE :8080. Always `PW_BASE_URL=http://127.0.0.1:8090`.
  Taps are touch events, not mouse clicks (the phone's ghost click only shows with `hasTouch`).

### Artifacts — the rule
- Write deliverables to **`~/Work/bifrost/artifacts/`**, reference as `/api/artifact/<name>.<ext>`.
  The :8443 gallery reads three sources per request (`pwa/artifacts-builtin`, this tree's `artifacts/`, main's
  `artifacts/`; newest mtime wins; `X-Artifact-Source` says which). Never hand-copy into this tree's `artifacts/`.
- A spec run with cwd `pwa/` must write `../artifacts/…`; `artifacts/…` creates `pwa/artifacts/`, which nothing reads.

### Fork warning
`lab/sandbox` was cut from `ab00e73` (10-01) and never merged back from `rebuild/cohesive-opus`. A "regression"
may be a fix that exists only on main: `git log lab/sandbox -S <symbol>` before bisecting.
