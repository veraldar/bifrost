# SPEC — LAYMAN-DEPLOY: the friend's journey, end to end (10-29)

Status: **P1 of 4 — the spec.** Phases: P1 spec → P2 full simulation → P3 implementation →
P4 report (human gate). **No real VPS is provisioned in any phase** (owner rules 10-09/10-10);
real-world execution is the owner's runbook (see P4 report §runbook).

The target, the owner's words: *"a friend on another computer installs the root → the trunk
auto-installs on a VPS → they scan with their phone → they use the app (PWA install or
Play-Store APK)"*.

## 0 · Who is who

| actor | who/what | acts via |
|---|---|---|
| **Friend** | a layman on any random Linux box (their laptop/desktop) | paste **one command**, follow printed instructions, scan a QR with the phone |
| **Root installer** | `bootstrap.sh` (step 3) | runs on the friend's box; provisions the ROOT (yggdrasil brain + bridge) there |
| **Trunk deployer** | `trunk-deploy.sh` (step 4) | runs on the friend's box; drives the VPS over SSH; idempotent, health-gated, rollback-safe |
| **Owner** | the human gate | reviews the runbook, owns the account decisions; only actor who can touch a real VPS |
| AI | chat guidance when the friend is stuck | reads the deploy receipt; never holds secrets |

## 1 · The six decisions this spec locks

1. **Split stays.** Root (brain+bridge, shell-capable) on the friend's box; public face (PWA
   + WebRTC media) on the VPS. Alternative topologies rejected: everything-on-VPS (gives a
   layman's machine's worth of trust + keys to a rented box AND doubles the bill), everything-
   home (needs port-forwarding/CGNAT + a domain — the exact wall the layman can't climb),
   Vercel-PWA (splits the origin; the overlay PWA's same-origin API seam breaks).
2. **Pairing = S1 device token, reuse as-is.** The `/pair` surface, `lib/devices.ts`
   (sha256 registry, `.devices.json` 0600, tokens shown once), `BIFROST_AUTH=devices`
   middleware, and the bridge's tokens_file — all exist and are e2e-proven
   (`pwa/e2e/bridge.spec.ts`: pair → data-channel → message → voice round-trip). The trunk
   runs `BIFROST_AUTH=devices` + `BIFROST_ADMIN_TOKEN`; the friend mints ONE bootstrap admin
   token from the root box, uses it once to reach the deployed `/pair` page, and pairs the
   phone as a device.
3. **App acquisition: PWA install NOW; APK = a later track.** The PWA is already
   installable (manifest standalone; the friend's phone "Add to Home Screen" on the VPS
   origin). The Play internal-track APK needs signing infra + release engineering the trunk
   does not have yet (trunk-apk-readiness gap 5). **P2 sim measures the PWA path; the APK
   path is a P4 gap-row**, not a blocker: with the bridge carrying voice, an installed PWA
   and an APK are behaviorally near-identical; the Play track buys branding + store presence,
   not capability.
4. **Provider: Hetzner Cloud, €5.89/mo all-in.** See §6.
5. **Domain: a real one, DNS via the provider's API.** The PWA proxy must be same-origin
   HTTPS for the overlay/service-worker phone install, and browser mic (getUserMedia) is
   gecko/blink-refused on plain HTTP origins. DNS-01 via provider API = no interactive ACME,
   wildcard possible, works before any HTTP is up. Fallback (SIM-ONLY, never the real path):
   plain-HTTP + IP over Tailscale (mic works on tailscale-IP origins for local testing).
6. **Secrets never leave the two machines that need them.** The provider API key stays on
   the friend's box (0600). Every secret generated on the VPS stays on the VPS. The deploy
   receipt NEVER contains a secret — only URLs, service states, and the pairing URL with the
   one-time admin token, which is delivered to the friend's phone out-of-band (QR). AI
   sessions on either side read receipts, never key material; `trunk-deploy.sh` has a
   `--redact` log mode that is the default.

## 2 · The journey — numbered steps

Legend: ACTOR = who performs it. Every step lists what can fail and the fallback. Steps
marked [SIM] are exercised in the P2 simulation.

### Phase A — root on the friend's box

**Step 1 [SIM]** — *Friend gets the code.* Friend clones/downloads the bifrost repo
(`git clone --depth 1 <release-tag>`).
- fails: no git → print the zip-URL fallback; no network → dead end (print check).
- fallback: `bootstrap.sh` detects `git` missing and says exactly one sentence with the curl-zip command.

**Step 2 [SIM]** — *Friend reads the one command.* `docs` say: `scripts/bootstrap.sh --as-root-box`.
- fails: wrong version cloned → script prints its own MIN_SPEC and refuses with a version-echo.

**Step 3 [SIM]** — *Root install.* `bootstrap.sh` (root-box mode) on the friend's Linux box:
  a. check prereqs (git, node ≥22, cargo/rust for the root build, openssl, ssh) — missing ones printed with the exact distro command;
  b. build `yggdrasil` (lab/yggdrasil crate) + `bifrost-net` (bridge binary);
  c. mint secrets into `~/.config/yggdrasil/yggdrasil.env` + bridge config (0600, never overwrite — idempotent);
  d. install systemd USER units (yggdrasil.service exists as a template; bridge unit written from the real one on this box), `systemctl --user enable --now`;
  e. health: `yggdrasil /session` 200 on 127.0.0.1:4096 (the bridge's opencode_url), bridge 18080 alive;
  f. print the ROOT RECEIPT: URLs, unit states, and the next command.
- fails: cargo missing → script offers `rustup` one-liner then re-runs; build fail → journal printed, abort with state intact (nothing half-installed: units only enabled after health); port already held → detect + say which unit.
- fallback: `--dry-run` prints every action first; re-run is always safe (idempotent).
- **the root is NOT public**: binds 127.0.0.1; the phone talks to the bridge THROUGH the VPS relay (step 6), never to the friend's box.

### Phase B — trunk on the VPS

**Step 4 [SIM]** — *Trunk deploy.* `trunk-deploy.sh` runs on the friend's box. It takes: VPS
ssh host/port/key path, the domain, the Hetzner API token (env file, 0600), and a release
git ref. Sub-steps, each with an idempotence guard and a health gate:
  a. **preflight** — ssh reachable, Ubuntu 22.04/24.04, systemd, ≥2 GB RAM, ≥10 GB disk; ports 80/443/UDP 3478+media free; DNS A record pointed (checked, not created);
  b. **deps** — apt install node/uv/caddy/certbot (skipped when present);
  c. **DNS-01 cert** — Hetzner API TXT challenge → wildcard cert for `<domain>`; cert + key land 0600 in /etc/ssl/bifrost;
  d. **secrets mint** — on the VPS: `BIFROST_ADMIN_TOKEN`, `NEXTAUTH/turn secrets`, agent env; 0600 gitignored, printed NEVER;
  e. **app** — clone the SAME ref, `npm ci`, `next build`, install as `bifrost-pwa.service` (systemd, hardening copied from this box's real units), env from (d) with `BIFROST_AUTH=devices`;
  f. **relay** — bifrost-net `serve` mode as `bifrost-relay.service`: WireGuard listener + str0m WebRTC relay + signaling, `candidates` = the VPS public IP, peers = the friend's root bridge; its `opencode_url`/STT/TTS point at the friend's root over the WireGuard mesh (10.7.0.x);
  g. **caddy** — terminates TLS for `<domain>`: `/` → 127.0.0.1:8080 (PWA), `/wss/*`-equivalent media+signaling paths → the relay; **NO route to anything else**;
  h. **gates** — `https://<domain>` serves BUILD_ID; `/api/ping` 200; relay media port answers; pairing page loads **over public HTTPS**;
  i. **receipt** — one text block: what runs, where, the pairing URL. NO secrets. Failure at any gate = **rollback** (see §4).
- fails per sub-step: preflight (undersized box, held ports, DNS not propagated → wait/re-check ×5, then abort pointing at the exact record to fix); DNS-01 (API token bad → say so, never retry-loop; rate-limit → backoff then abort); build (npm failures → retry once, then abort); gate red → rollback automatically.
- **provider-agnostic core**: everything except (c) is plain ssh+apt+systemd. (c) has a documented manual path ("paste these commands on your DNS panel") for any provider — the sim exercises BOTH paths.

**Step 5 [SIM]** — *Friend's root joins the mesh.* `bootstrap.sh --join-relay <vps-ip>`: the root bridge config gains the relay as a WireGuard peer; health re-checked (mesh ping over 10.7.0.1).
- fails: UDP blocked → printed with "try port 51820/udp on your router"; key mismatch → abort, no config written.

### Phase C — phone in hand

**Step 6 [SIM]** — *Pair.* Friend opens the pairing URL from the receipt on the PHONE browser →
the deployed `/pair` page (admin token consumed once, from the receipt) → token shown once +
QR → phone stores `bifrost_device` (existing behavior, proven in e2e).
- fails: QR unreadable → the raw token text is right there (copy-paste path — the sim tests it); token expired → re-pair via a NEW one-time admin token printed by `trunk-deploy.sh --new-pairing`.

**Step 7 [SIM]** — *Install the app.* On the deployed origin the PWA manifest offers
"Add to Home Screen" (installability = the P4 sim checks the manifest + service worker over
HTTPS). The bridge (not LiveKit) carries voice: mic → phone PWA → WebRTC → VPS relay →
WireGuard → friend's root → STT → yggdrasil → TTS → back.
- fails: manifest/HTTPS broken → the deploy gate (4h) already failed on exactly this.

**Step 8 [SIM]** — *Talk.* Phone says a sentence; transcript replies. `--redact` receipts
prove: device token in registry, one round-trip logged with RTT.
- fails: mic permission denied → browser prompt explained on the receipt; quota outage (429) mid-onboard → **the PROVIDER-WAVE error banner** shows the provider's message in the PWA (wave/provider-banner e2e covers this exact rendering); mesh down → bridge page shows 'sys' line, receipt names the unit.

**Step 9** — *The owner's review (human gate).* Before ANY real VPS: owner reads the P4
runbook, confirms the provider account + domain + the friend. No script in this lab can
spend money.

## 3 · Journeys the sim must also prove (failure paths)

1. bad QR / garbage token → 401, PWA says unauthorized, nothing stored;
2. expired/revoked device token → middleware 401, revoke honored on next call;
3. provider quota outage mid-onboard (mock 429/1310) → error banner renders the provider's reason (reuse wave/provider-banner behavior);
4. deploy gate red → automatic rollback, old version still serving;
5. re-run everything twice → idempotent (no dup units, no overwritten secrets);
6. secrets discipline → grep all logs/receipts for any minted secret = 0 hits.

## 4 · Rollback + idempotence contract

- `trunk-deploy.sh` writes `/opt/bifrost/versions/<ts>/` on the VPS; a `current` symlink
  flips only after ALL gates pass; gates red = symlink never moves (old version untouched)
  + a `--rollback <ts>` re-points it manually. Mirrors promote.sh's contract on this box.
- `bootstrap.sh` never overwrites an existing env file (the install.sh pattern: "created
  once, never overwritten"); re-run = upgrade paths only.

## 5 · What is reused, not rebuilt

| existing asset | reuse |
|---|---|
| `lab/yggdrasil` (root brain, crates, install.sh, service unit, verify.sh, mock upstream) | the root build+install — verbatim patterns |
| `lab/bifrost-net` (mesh+relay+signaling, config, keygen, M1 verify) | the relay role on the VPS + root-side join |
| `pwa/lib/devices.ts` + `/api/pair` + middleware (S1) | the auth seam, unchanged |
| `pwa/app/bridge/page.tsx` + `pwa/e2e/bridge.spec.ts` | the phone client + the sim's round-trip harness |
| PROVIDER-WAVE error turns + `wave/provider-banner` PWA work | the quota-outage UX in step 8 |
| `promote.sh`/`next-slot.sh` (frozen-release contract, gate-then-switch, rollback) | the release discipline trunk-deploy reimplements for a remote host |
| `docs/spec-onboard.md` (the 09-26/09-28 decisions) | the ancestor spec; §1 of it (all-on-VPS) is superseded by decision 1 here — noted, not silently |

## 6 · Provider decision — the numbers (fetched live 10-29)

Fetched from provider pages during this session (VAT incl. DE where shown; Hetzner net→gross
computed at 19%):

| | **Hetzner Cloud CX22** | netcup VPS Lite 1 G12.5s | netcup VPS 500 ARM G12.5 |
|---|---|---|---|
| price/mo | **€4.99 net → €5.94 gross** (page headline "from €5.99/mo excl. VAT"; CX22 = €4.99 net) | **€5.86** incl. | **€9.50** incl. (12-mo term; €8.26 net) |
| vCPU / RAM / disk | 2 shared / 4 GB / 40 GB | 2 / 4 GB / 80 GB | 2 ARM / 4 GB / 64 GB |
| hourly billing, delete anytime | **yes** | no — 6-mo minimum term | no — 12-mo minimum term |
| API for scripts (the friend never opens a console) | **yes — full REST + hcloud CLI; DNS API for the wildcard cert** | CCP panel + webservice (SOAP, clunkier; no DNS API on VPS lines) | same |
| locations | Nuremberg/Falkenstein/Helsinki (+US/SG) | Nuremberg/Vienna/Amsterdam | Nuremberg/Vienna/Amsterdam |
| special | one-click Ubuntu 24.04 + Docker images; snapshots | reduced bandwidth tier | Ampere ARM — brain+relay are Rust (arm64-fine), PWA build node-arm-fine |

**Recommendation: Hetzner Cloud CX22 — €5.94/mo gross (€4.99 net), hourly, deletable.**
Why: (a) the whole phase-B flow is SCRIPTED — the REST API + DNS API mean the friend's only
acts are paste-command + scan-QR; netcup's panel-centric + SOAP-webservice story and fixed
terms fight that; (b) hourly billing matches the human gate (spin a real box only for the
owner-approved rehearsal); (c) 2/4GB meets the spec-onboard floor with headroom; the
spec-onboard 4vCPU/8GB assumption was for CPU-STT co-located — here STT/TTS live on the
friend's root, NOT the VPS, so the small box is honest; (d) netcup Lite's €5.86 is 7¢
cheaper but 6-month-locked + bandwidth-capped + no scriptable DNS on this line. ARM noted:
if a future brain needs more CPU per €, netcup ARM64 is the fallback line — the Rust core
is arm64-clean; flagged in P4 gaps, not needed for v1.
