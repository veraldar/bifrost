# Spec — one-button onboarding (VPS bootstrap + QR pair) — POST-V1, NOT IMPLEMENTED

Status: **specification only**. Out of v1 scope (`plan.md` Deferred). Raised 09-26.
Goal: a new user goes from "nothing" to "talking to their own private bifrost" in
minutes — one script on a fresh VPS, one QR scan from the phone.

## Non-goals

- Multi-tenant hosting: **we never run opencode for other people** (shell access).
  Every user gets their own private stack.
- Migrating existing installs; Windows/macOS servers (Ubuntu LTS first).

## Architecture

### 1. `bootstrap.sh` on a fresh VPS (Ubuntu 24.04)

Idempotent, re-runnable, logs to a journal. Steps:

1. Install system deps (node LTS, uv/python, caddy).
2. Mint secrets if absent (never overwrite): LiveKit key/secret, VAPID keypair,
   opencode API token, session secret. All into gitignored `.env` files, 0600.
3. Configure Caddy: HTTPS (Let's Encrypt; domain + email from `onboard.env`),
   routes:
   - `/` → PWA (next start) — public, but gated (see Privacy model)
   - `wss://live.<domain>` → LiveKit (public WebRTC edge + embedded TURN)
   - **opencode and the voice agent get NO public route** (127.0.0.1 only)
4. Start services (systemd units, mirroring this box's units): `lk-pwa`,
   `lk-agent`, `opencode-serve`, LiveKit.
5. Print the pairing QR (terminal, plus served at `/pair` once).

### 2. Pairing (QR → configured phone)

`/pair` page (one-time token, printed by bootstrap) renders a QR encoding:
`{PWA_URL, LIVEKIT_URL, ONE_TIME_TOKEN}`. The PWA setup screen:

- reads the QR (or manual paste), stores config
- exchanges the one-time token for a long-lived session cookie
- registers Web Push (VAPID public key comes from the server)
- runs a self-test: ping proxy → LiveKit connect → mic loopback → opencode echo

### 3. Privacy model (hard constraint)

opencode has **shell access** — it is never reachable from the public internet.

- **Default topology (everything on the VPS)**: PWA + LiveKit + opencode all
  co-located. Caddy gates the PWA (session cookie from pairing) and exposes only
  the LiveKit WebRTC edge publicly. The proxy seam (`/api/*`) stays same-origin
  on the VPS → opencode stays 127.0.0.1.
- **Vercel path (BYO networking)**: README button stays for users who put the
  PWA on Vercel — but then the Vercel proxy must reach opencode, which requires
  exposing it somehow (Tailscale Funnel + auth). Documented as the advanced
  path, never the default.
- Tailscale-on-VPS stays an option for users who want zero public exposure at
  all (no Caddy, no domain needed).

### 4. Updates

`bootstrap.sh` re-run = update (git pull + rebuild + restart, secrets kept).
Un-attended upgrades stay off for LiveKit/opencode (breaking-change risk).

## Open questions

All six DECIDED 09-28 (self-answered per prime directive; veto by saying so):

1. **Auth**: one-time pairing token → signed HttpOnly cookie, 90d. Passkeys post-v1 if needed. (Blocks Stage B — unblocked.)
2. **VPS voice**: speaches-CPU is the shipped default; Mac-LAN documented as the quality upgrade path.
3. **Domain/ACME**: `onboard.env` file; bootstrap validates and prints exactly what's missing.
4. **TURN**: time-limited (LiveKit auto-mints); static only as documented fallback.
5. **Multi-phone**: works as-is (token per connect); document, don't build.
6. **VPS floor**: measure during phase-2 dogfood; working assumption 4 vCPU / 8 GB.

## Phases (post-v1)

1. `bootstrap.sh` for this box's exact topology; dogfood = run it against a
   clean container "VPS" and get a working stack (mirrors the release
   fresh-clone validation).
2. `/pair` + PWA setup screen + self-test.
3. E2E: clean container → phone pairs → voice round-trip → push notification.

## Review findings (09-26, opencode session `review-spec-onboard`)

Skeptical-architect review landed 10 gaps; top severity: no auth layer exists to
gate (session concept must be built — Next middleware at the `/api/*` seam
proposed); LiveKit+speaches run under **docker compose**, not systemd, and the
units that exist are **user** units (bootstrap-as-root needs a decision);
livekit.yaml must be *generated* per-VPS (external IP, TURN, ports
80/443/7880-7882 + UDP 50000-50100); LLM provider key + domain/ACME email are
un-mintable user inputs; opencode install + `VOICE_MODEL` provisioning missing;
speaches-CPU cold-start will time out the pairing self-test; Vercel path
contradicts the "never public" constraint (Tailscale Funnel IS public); one-time
token needs durable storage; phase-1 container dogfood needs a `--local` mode.
Full review lives in session `ses_f20934ea5fferpsynIgfeqTnf5`.

## Decision 09-26 (user)

**Both topologies are product, neither is cut:**
- **A — full local** (as this box runs today): models + server + AI harness all
  user-owned (LAN speech models, local opencode, tailnet-only). README quickstart
  is the install path; nothing public, ever.
- **B — one-click deploy**: `bootstrap.sh` + QR pairing per this spec, for users
  who start from a bare VPS.

## Product framing 09-26 (user-confirmed)

Three sellable options, ONE app (installable PWA; "Android app" = browser
install, no native APK; iOS via Safari A2HS):

| | Compute | Connection | Setup |
|---|---|---|---|
| 1 | user hardware (models+server+harness) | Tailscale, nothing public | README manual (ships today) |
| 2 | user hardware | VPS hosts only the WebRTC edge | README manual |
| 3 | rented VPS hosts everything | public (edge + gated PWA) | one button |

bootstrap.sh is a SETUP LAYER, not a topology: it must also run on the user's
own box ("one button on my hardware") — effort option, not just VPS option.

## Acceptance criterion 09-26 (user)

**"GitHub link + a ≤5-word phrase, given to any agent harness → working stack."**
The bootstrap must leave zero judgment calls: mint all keys, detect the
tailnet/LAN IP, generate livekit.yaml + every .env, pick defaults for
everything a human would otherwise decide. An opencode/claude/codex-class
agent must succeed running only scripted commands — no reading between lines.
This is phase 1's definition of done.

### Refinement 09-26 (user): SKILL.md-first

The agent-facing entry point is an **in-repo install skill** (`SKILL.md`),
not a prose doc: any harness (opencode / Claude Code / Codex class) loads it
and follows it. Skill = instructions (prereq check → run bootstrap.sh →
verify via scripts/selfhost-check.sh → report what it did + the pair URL).
bootstrap.sh = the deterministic mechanics. Harness-agnostic: discoverable
from AGENTS.md/README ("agents: load skills/install/SKILL.md"), standard
skill frontmatter (name/description). A different harness on a different
machine must be able to install bifrost from this skill alone.

### Refinement 09-26b (user): the whole prompt is "<link> set it up"

The harness is given ONLY a link + "set it up" — no clone step by the human.
So the skill must be self-bootstrapping from a bare URL:
- stable raw URL advertised in the README, e.g.
  `https://raw.githubusercontent.com/veraldar/yggdrasil-bifrost/main/skills/install/SKILL.md`
  (and the repo link itself must lead a harness to the same skill via
  README/AGENTS.md pointer)
- the skill's FIRST mechanical step is cloning the repo (it cannot assume
  local files)
- frontmatter description must match "set it up" / "install bifrost" intents
- zero assumptions beyond: a shell, git, network, sudo-or-user-install paths

## Status 09-27: phase 1 built (by hand — two agent runs wedged)

`skills/install/SKILL.md` + `scripts/bootstrap.sh` landed. Cold-container
validated (node:24, no docker/uv): self-clones, mints everything, boots
PWA+opencode → probes 200/200, docker/uv layers skip honestly. Pending:
cross-harness (Claude Code) container test of the raw skill URL; real-VPS
trial of the docker/uv/tailscale layers.
