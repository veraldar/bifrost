# Security model & threat statement

## The trust chain (what you actually trust)
1. **The tailnet is the auth layer.** Tailscale membership = the only way to
   reach the PWA, opencode, LiveKit, and speech. Nothing is public. This is
   the entire authentication story for a single-user install — and it is
   stated here so the day it is no longer true, you know it broke.
2. **The install skill** runs shell on your machine as your user. You trust:
   this repo (AGPL, public, auditable) + your agent's harness (it reads and
   executes the skill). The install URL is pinned to a release tag; the
   bootstrap prints what it will do before doing it. Verify the diff — that
   is the minimal trust chain.
3. **opencode has shell access** to its host. It is never exposed publicly;
   the phone talks only to the Next proxy (the one seam).

## Served surfaces
| surface | binds | exposure |
|---|---|---|
| PWA (Next) | 127.0.0.1:8080 | tailnet via `tailscale serve` |
| opencode REST | 127.0.0.1:4096 | localhost only |
| LiveKit | :7880 (+UDP range) | tailnet-pinned ICE |
| edge voice (optional) | 127.0.0.1 | localhost only |
| speech (Mac MLX / speaches) | LAN | tailnet/LAN only |

## Known debts (tracked in docs/plan.md ladder)
- **S1 (HIGH, fixes v0.9)**: `/api/*` routes are unauthenticated; the tailnet
  is silently the only auth. Fix: per-device bearer tokens minted by `/pair`,
  one proxy middleware, device revocation in settings. Blocking v1.0.
- **S2 (HIGH, fixed pre-wave)**: install chain mutable → pinned to release
  tags + bootstrap execution manifest + this file.
- **S3 (MEDIUM, fixes v0.7)**: `IS_VERCEL_PREVIEW=true` in live .env bypasses
  a dev guard. Fix: explicit `BIFROST_AUTH=tailnet` declaration.

## Secrets
`.env*` files are gitignored and contain all credentials (LiveKit keys,
VAPID, provider keys). They are included in backups (they are the point of a
backup) and never leave the box except through the user's own hands.
