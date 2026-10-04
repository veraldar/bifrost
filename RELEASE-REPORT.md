# v0.9.0 — release report: no-tailscale direct pairing

**Verdict: the validation ladder is GREEN on this machine.** The tag is the operator's
(this session tagged nothing). Review law followed: `docs/reviews/agi-roadmap-review.md`
Part 15. Note: Part 15 exists only in the main checkout's working copy, uncommitted. It is
not in this branch's copy of the file.

## What was built (one commit per milestone)

| # | milestone | commit | evidence |
|---|---|---|---|
| M1 | **S1 full semantics:** short-lived region-bound access tokens, rotating refresh with theft detection, sha256-only at rest, one-time pairing codes, per-device rate limits, device list + revoke + KILL-SWITCH | `8baea57` (+ console fix in M3/M4 commit) | e2e `auth.spec.ts` **7/7** (devices mode); the 2 pre-existing S1 tests stay green |
| M2 | **P2P-first transport:** bifrost-net bridge with ONE persisted DTLS identity (QR-pinnable fingerprint), region-checked `/offer`, live peers severed on revoke / kill / expiry, in-band `auth.refresh`; browser `BridgeLink` refuses any answer not carrying the pinned key | `ad6d50f` | `selftest v9` **GREEN** (revoke mid-session → severed in 242 ms; kill epoch → 321 ms); `selftest m0` + `m1` **GREEN** (no regression) |
| M3 | **/pair QR + phone auto-setup:** the box console shows a one-time QR (code + box key + bridge URL in the fragment); scanning pairs the device, mints its credentials (HttpOnly cookies), pins the key, lands on MAIN | final commit | ladder rungs 1–3 |
| M4 | **validation ladder:** box + three browser "devices" (desktop console, iPhone-emulated, Pixel-emulated) | final commit | `e2e/pair-ladder.spec.ts` **1/1 (8 rungs)**; run `LADDER EXIT 0`, 8 passed in 1.1 min |

The spec of what the code does: **`docs/spec-pairing.md`**. It holds the invariants: the
box never accepts inbound internet connections; *the access point is the user's; the org
never operates one*. It also covers credentials, the QR as a security artifact, the
transport, the relay design with the DERP comparison named, and the kill-switch.

### The ladder, rung by rung (all green; corroborated from the box side)

1. The box console renders a QR. The test **decodes the rendered QR image with `zbarimg`**; it does not read the URL from the DOM. The decoded URL carries `code=bfnp-…`, the bridge's `sha-256` fingerprint, and the bridge URL.
2. The phone opens the decoded URL. The device is paired, an HttpOnly `bifrost_device` cookie is minted, the fingerprint is pinned, and the phone **lands on MAIN** (`/session/<main>?id=ses_…`).
3. The spent QR, replayed on a second phone, answers "already used". That phone stays unauthorized.
4. The **P2P data channel** opens: browser ↔ str0m bridge over the box's LAN address, with the answer's fingerprint checked against the QR pin.
5. **App round-trip through the transport:** a prompt goes over the data channel, `run.done` brings the reply back, and the marker is read from the **MAIN brain session** over HTTP.
6. **Revoke from the device list** (desktop `/devices`): the phone's live peer is **severed mid-session** with reason `revoked`, and its HTTP calls answer 401. Bridge log: `severed peer 0 (dev_4fe2f7b9) — revoked`.
7. The phone re-pairs and a Pixel pairs, giving two live P2P devices. The **kill-switch severs both** (`kill-switch`) and both get 401. Bridge log: two `— kill-switch` lines. Registry: `killEpoch 1`.
8. **Re-pair after the kill works** end to end: a new QR, then MAIN, then the P2P link opens again.

The disposable MAIN (`e2e-ladder-main`) is deleted at the end, so the live brain keeps no e2e debris.

### Bugs this arc found and fixed (several were pre-existing and invisible)

1. **Seam mismatch:** the PWA writes `tokenHash` (camelCase), but the bridge read `token_hash`. **Every PWA-minted token would have been rejected by the bridge.** V9.2 hid this because its selftest wrote its own file.
2. **Bridge `prompt` → `run.done` always timed out.** opencode's `POST /message` resolves only when the run ends, and the old code then waited for a *new* assistant message. V9.2 never sent a prompt.
3. **Bridge read opencode's role at the wrong level.** It looked at the top level instead of `info.role`, so assistant detection was blind and replies came back empty. The voice pipeline's run-wait had the same hole.
4. **Client IP was spoofable under `next start`.** It keeps a client-sent `X-Forwarded-For` (`??=`), so any LAN client could claim to be loopback (= pairing admin) or fake its region. Fixed with `pwa/server.mjs`: a socket-stamped `x-bifrost-peer` that deletes client copies. e2e: a spoofed console gets 403.
5. Ladder finds in my own code, all fixed:
   - a refused refresh cleared cookies and could race the claim on `/pair`
   - the box console was bounced to `/pair` by its own diag calls
   - a multi-homed client's ICE source address flaps between interfaces, so renewals are now anchored to the admitting `/offer`'s region
   - a just-minted token could miss the bridge's 300 ms registry cache

### Regression (default tailnet mode = what production runs)

My build was served on :8095 with the live env (`BIFROST_AUTH=tailnet`). Result: `PW_BASE_URL=http://127.0.0.1:8095 npx playwright test` → **49 passed, 6 skipped, 0 failed** (2.7 min, `SUITE EXIT 0`). The 6 skips are the 5 S1-full specs and the ladder, which self-skip outside devices mode.

## Skipped or partial: the honest why

1. **Relay fallback (NAT traversal through the user's access point): specified, NOT built.**
   `docs/spec-pairing.md` § Relay fallback has the design: user-owned, outbound-only, ciphertext-only, DERP named.
   - **Why:** the browser path needs a new seam. The access point's UDP forwarder must ride the boringtun mesh into the bridge's str0m socket, and the bridge must advertise the access point as a candidate.
   - **Part 15 §d.1 forbids calling it validated** without path emulation, which is the next item. Both together are their own slice.
   - Today the transport is **LAN-only**. A phone off the LAN still needs today's tailnet path.
2. **Path emulation (netem + network namespace + relay container): NOT done.**
   - **What ran:** the ladder ran over the box's real LAN address (192.168.1.89), with real ICE between interfaces. That surfaced and fixed the multi-homed flapping.
   - **Gap:** phone and box still share one kernel. This is better than loopback, but it is not the path Part 15 §d.1 asks for.
   - **Needed:** a Chromium "phone" in a container on a docker network with `NET_ADMIN` (`tc netem` loss/latency/jitter), the bridge advertising the docker-bridge address, and the relay node in a second container. The user is in the `docker` group, so no host root is needed. Lands with the relay slice.
3. **LAN HTTPS with a QR-pinned cert (Part 15 §b): not built.**
   - **Consequence for a real phone over `http://<lan-ip>`:** the P2P data channel works, because `RTCPeerConnection` needs no secure context. But the **mic (`getUserMedia`), service worker and PWA install all require a secure context**.
   - So voice-on-the-phone without tailscale is **not yet usable**.
   - This is the first item for the real-iPhone gate.
4. **Real iPhone:** not tested (no device here). "iPhone" = Chromium with the iPhone 13 descriptor. WebKit is untested; the open question is the cookie-jar behaviour below.
   - **Open question (iOS):** a home-screen PWA has its own cookie/localStorage jar, separate from Safari. A camera-scanned QR opens Safari, so it pairs *Safari*.
   - Whether the pairing survives "Add to Home Screen" must be checked on a real iPhone. Candidate fix: show the QR flow inside the installed PWA (an in-app scanner, or a typed short code).
5. **Voice over the P2P transport:** the bridge's Opus pipeline exists and is GREEN at V9.3, but `/p2p` sends no audio track. Voice stays on LiveKit. Part 15 §b's GO for voice (LiveKit ICE → bifrost-net TURN) is configuration and was not done in this arc.
6. **Data channel as THE app protocol: deliberately not done (Part 15 §b).**
   - HTTP stays the app protocol: every existing `/api` route and spec is unchanged, and S1 gates them in devices mode.
   - `/p2p` is the flagged, fingerprint-pinned transport. It exists now because it is the one place a browser lets the app pin a self-signed box key without a CA. That is how the brief's "P2P data channel → app round-trip" rung and Part 15 coexist.
7. **"Network region" means network prefix, not geography** (lan /24, cgnat, public /16, IPv6 /48 or /32; no GeoIP). Re-auth on change = the refresh credential (`BIFROST_REGION_POLICY=repair` makes it a full re-scan).
8. The 2 pre-existing "unused import/variable" warnings in `lab/bifrost-net` (speech.rs, bridge.rs V9Client) are untouched.

## Operator notes (read before switching a box to devices mode)

- **Nothing changes by upgrading.** The default stays `BIFROST_AUTH=tailnet`, served by `next start`. Devices mode is a deliberate switch: `BIFROST_AUTH=devices`, served by `node server.mjs` (NOT `next start`), plus a `bifrost-net bridge` unit. Both share `BIFROST_DEVICES_FILE`.
- **Never put devices mode behind a loopback proxy without `BIFROST_TRUST_PROXY=1`.**
  - `tailscale serve`, caddy and nginx on the same box all connect from 127.0.0.1. Under server.mjs every request would then read as the box console, i.e. a pairing admin.
  - With `BIFROST_TRUST_PROXY=1`, the proxy's first `X-Forwarded-For` hop is used instead. If neither applies, set `BIFROST_PAIR_LOCAL=0` and use `BIFROST_ADMIN_TOKEN`.
- **Old registry entries:** a v1 registry (non-expiring `tokenHash` entries from `9c0425e`) reads as revoked ("v1 token — re-pair"). Those devices scan once.
- **The box key:** deleting the bridge's `dtls_cert_file` changes the box key. Every paired phone then refuses the bridge (by design) and must re-scan.
- **Live services:** none were stopped or restarted (lk-pwa, lk-agent, opencode-serve, LiveKit untouched). The ladder uses :8095 (PWA) and :7890 / udp :7891 (bridge), plus the live opencode brain with a disposable session.
- **Env files:** `pwa/.env.local` in this worktree is a copy of the main checkout's, made only for the regression run. It is gitignored and mode 600.

## How to run the gate

```bash
cd ~/Work/release-v09
# 1. builds
(cd pwa && npm run build)
(cd lab/bifrost-net && source ~/.cargo/env && cargo build --release)
# 2. bridge seams (live opencode + speaches)
lab/bifrost-net/target/release/bifrost-net selftest v9   # expect V9 VERDICT: GREEN
lab/bifrost-net/target/release/bifrost-net selftest m0   # regression
lab/bifrost-net/target/release/bifrost-net selftest m1   # regression
# 3. THE LADDER: boots bridge + devices-mode PWA (:8095), runs S1 + ladder specs,
#    tears both down; state/logs in /tmp/v09-ladder (e2e.log, bridge.log, pwa.log)
scripts/v09-ladder.sh 192.168.1.89        # <the box's LAN address>; expect 8 passed
# 4. regression suite in default (tailnet) mode against this build
(cd pwa && node node_modules/next/dist/bin/next start -p 8095 -H 127.0.0.1 &)   # needs pwa/.env.local
(cd pwa && PW_BASE_URL=http://127.0.0.1:8095 npx playwright test)               # S1-full + ladder self-skip here
```

No spec hardcodes :8080 (`auth.spec.ts` mentions it only in a comment), so lk-pwa never has to stop.

Ladder timing: about 1–8 min, mostly the model's reply latency. The S1 specs add about 60 s of deliberate waits (TTL and pairing-code expiry). Server knobs the specs assume are set by the runner:
- `BIFROST_ACCESS_TTL_S=30`
- `BIFROST_PAIR_TTL_S=20`
- `BIFROST_ROTATE_GRACE_S=2`
- `BIFROST_RATE_BURST=120`
- `BIFROST_RATE_PER_SEC=2`
