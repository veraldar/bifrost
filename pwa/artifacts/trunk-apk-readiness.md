# TRUNK-APK READINESS — inventory, gaps, the dated answer (10-27)

*Rebuilt 10-29: the original `docs/reviews/trunk-apk-readiness.md` from the 10-27 TRUNK-APK
session was not present in either tree (prompt survives at `~/Work/bifrost/prompts/trunk-apk.txt`
— mission, verdict summary, and the 10-29 LAYMAN-DEPLOY mission both cite it). Reconstructed
from the 10-27 evidence + the prompt's own task list. Sections marked (RC) are reconstruction.*

Session: TRUNK-APK (10-27) · deliverable: docs/reviews/trunk-apk-readiness.md

## 1 · Inventory (what exists — real vs imagined)

| asset | state | evidence |
|---|---|---|
| PWA installable (phone, :8443) | **REAL** — the user's daily stack is the sandbox PWA on :8443, PWA-installable, tailnet-only | `where.sh` URL/runs rows |
| /pair QR (v0.9 S1 arc) | **REAL code** — `pwa/app/pair/page.tsx` mints device token, renders QR (token payload); `/api/pair` mints via admin/tailnet gate | main tree pwa tree |
| device tokens (S1 seam) | **REAL code** — `pwa/lib/devices.ts`: sha256-hashed registry `.devices.json` 0600, token shown once, revoke support | lib/devices.ts |
| admin gate | **REAL** — `pwa/lib/admin.ts`: BIFROST_ADMIN_TOKEN required for public deploys; no token + BIFROST_AUTH=tailnet | lib/admin.ts |
| bridge (bifrost-net, rust) | **REAL, running** — `bifrost-bridge` active on the box; config.example.toml: WireGuard mesh + WebRTC relay + HTTP signaling, one binary | lab/bifrost-net, M0 4/4 + M1 5/5 GREEN |
| yggdrasil root (trunk brain, :4100) | **REAL** — Rust, provider system (openai+anthropic dialects, fallback chain, {file:} secrets), live on :4100 as the user's brain | provider-wave report |
| v0.6 full-cycle sim (ygg-sim) | **REAL but STALE** — paired app 0.6.0 ↔ sim 0.6.0; DORMANT; revival owed when client format changes (trunk-apk finding: sim never tested the artifact the user held) | LABS.md ygg-sim row |
| bootstrap.sh (root provisioner) | **HALF-REAL** — exists for single-machine local mode (docker compose, minted secrets), but the VPS/bootstrap-on-fresh-box path is **SPEC-ONLY** | docs/spec-onboard.md "Status: specification only" |
| VPS one-button onboarding | **SPEC-ONLY** — docs/spec-onboard.md: bootstrap on fresh VPS (deps, secrets, caddy, systemd, QR), decided open-questions (auth, domain, TURN, 4vCPU/8GB floor) | spec-onboard.md |
| APK / Play internal track | **NOT BUILT** — android-lab exists as docs + scripts scaffolding; no signed APK pipeline | docs/android-lab.md |

## 2 · Gap table (ordered; S/M/L; owner lane)

| # | gap | size | lane | note |
|---|---|---|---|---|
| 1 | device tokens shipped in a release (S1 seam) — today's live :443 build predates it | M | v0.8 | BLOCKS public-facing installs; code exists, needs release |
| 2 | /pair QR loop end-to-end on a public origin (pair → token → bridge page, no tailscale) | M | v0.9 arc | pages exist; needs public-origin e2e proof |
| 3 | VPS bootstrap.sh (fresh-box provisioner: deps, secrets, caddy/TLS, systemd, print QR) | L | this lab | spec exists (spec-onboard.md); implementation owed |
| 4 | phone-usable bootstrap surface (layman can't paste a terminal QR reliably; need URL-fetched /pair or printed URL + token) | M | this lab | the QR-printed-in-terminal gap |
| 5 | APK pipeline (build + sign + Play internal track) | L | v0.8+ / android-lab | PWA install covers android today; Play track = owner's want |
| 6 | sim coverage of the full layman journey (fresh box → trunk → phone talks) | L | this lab | v0.6-era ygg-sim never tested the artifact the user held |

## 3 · Verdict (carried into LAYMAN-DEPLOY)

**PWA-now / APK-later**: the PWA is installable today (Add to Home Screen) on the user's
stack; the APK/Play track waits on the signing pipeline + internal track setup (owner's
want — plan for internal testing track, not public Play listing). This lab's provider
recommendation accounts for both.

**The two hard preconditions** (from the 10-27 mission): S1 token seam + the QR onboarding
loop (website → app → QR → trunk provisioned). Both have real code today; the missing
middle is the trunk deploy automation (gap 3+4) — which is LAYMAN-DEPLOY's job.

## 4 · Sim-coverage obligations (rule 10-09, for the sim that proves this)

If the OWNER finds an interaction/perf issue the sim missed, the sim failed its job. The
LAYMAN-DEPLOY sim must cover: fresh-box provisioner run (real script, scratch box), trunk
deploy + health gates, pairing surface reachable + token minted, bad-QR/expired-token/quota
failure paths, PWA load on a phone-class UA, minutes-to-talking metric per run.
