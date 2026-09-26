# Spec — bifrost

Voice-and-text remote for a local coding agent: talk or type from a phone, a LiveKit voice agent bridges to `opencode serve`, replies come back as text and speech. Architecture, models, install: `README.md`. UI flows: `wireframes.md`. Status: `plan.md`. History: `journal.md`.

## Product rules

1. **Base integrity over features** — the invariants in `plan.md` are the product. A regression there blocks everything else.
2. **One seam** — the phone only talks to the Next proxy (`/api/*`); opencode, LiveKit, and the Mac speech wrapper are never exposed. Tailnet is the security boundary.
3. **opencode is the source of truth** for sessions; rooms map to sessions by slug. No second mapping store.
4. **Local-first** — speech runs on the LAN (Mac MLX; CPU fallback). No cloud speech APIs. The coding LLM is whatever opencode is configured with (`VOICE_MODEL`).
5. **Degrade, don't break** — transient failures retry (bounded, silent); empty/error states are never cached as truth; diagnostics capture enough to pinpoint from the log alone (log-only, no auto-fix loops — tried, removed as a bad idea).

## Security

- Nothing public: LiveKit (tailnet-pinned ICE), PWA (`tailscale serve`), opencode (`127.0.0.1`), speech (LAN).
- Secrets in gitignored `.env` files. The GitHub repo contains no keys; the tailnet name appearing in docs/issues is acceptable (private network).
- Agent tool-permission policy: deny-by-default; voice confirms safe actions (open item for hardening).

## Non-goals (v1)

Multi-user/shared access, public URL, SIP/telephony, video, agent provisioning UI.
Nightly memory consolidation / self-organizing agents ("dreaming"): specced for
post-v1 in `spec-dream.md`, deliberately not built yet.
