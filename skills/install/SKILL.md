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
3. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4096/` → any HTTP code (opencode up)
4. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7880/` → any HTTP code (LiveKit up)
5. Full clean-room check (optional, heavy): `bash scripts/selfhost-check.sh`

## 4. Report

Tell the user, in this order: verdict line from the bootstrap, which layers
are up (pwa / opencode / livekit / agent / speaches), what was skipped and
why, the URL to open (LAN or tailnet), and the single remaining manual step
if any (`opencode auth login`). If any verify probe failed, include the last
20 lines of `bootstrap.log`.
