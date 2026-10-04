# spec — v0.9 direct pairing (no tailscale)

Status: built in v0.9.0 (release/v0.9.0). Review law: `docs/reviews/agi-roadmap-review.md`
Part 15 (GO-WITH-CHANGES). This spec is what the code does; `RELEASE-REPORT.md` says what
is proven and what is not.

## The shape in one paragraph

The phone pairs to the **box**, not to a network. The box shows a QR; the phone scans it;
the QR carries the box's key (the bridge's DTLS fingerprint), a one-time pairing code and
where to dial. Redeeming the code mints the phone's credentials and lands it on MAIN. From
then on every request carries a short-lived, region-bound access token, and the optional
direct transport (WebRTC data channel to the bifrost-net bridge) refuses any peer that does
not hold the key the QR pinned. Any device, or the box console, can revoke a device or pull
the kill-switch, which severs every live connection within a second.

## Invariants (load-bearing — a change that breaks one is a security bug)

1. **The box never accepts inbound connections from the internet.** LAN pairing is direct
   (phone → box on the LAN). Remote reach is the box dialing OUT to an access point; the
   box opens no internet-facing port, ever.
2. **The access point is the user's; the org never operates one.** A relay, when needed,
   runs on a server the user rents, in the country the user chooses, under the user's
   account. There is no org-run relay, signaling or coordination service — not as a
   fallback, not as a default. (If one ever exists it is an explicit paid sovereign tier,
   named as such, and still never a default.) Copy line: *relayed, when needed, only
   through a server you rent, in the country you choose.*
3. **No stranger-organized signaling.** LAN pairing needs no signaling server at all: the
   bridge's own `POST /offer` on the box is the signaling, and its URL comes from the QR.
   Remote signaling goes through the user's own access point only.
4. **No third-party discovery.** No public STUN/TURN: the client uses `iceServers: []`
   (LAN host candidates); the bridge advertises only pinned candidates (`candidates` in
   its config — never auto-detected; the livekit.yaml scar).
5. **Only hashes at rest.** Every credential is CSPRNG output (128–256 bit); the registry
   stores sha256 hashes only. A raw credential leaves the box once, in the response that
   minted it.
6. **A presented credential must stand on its own.** Network trust (box console, legacy
   tailnet) applies only when NOTHING is presented; a garbage or stale token is never
   upgraded by where it came from.

## Credentials (pwa/lib/devices.ts; the bridge verifies the same file)

| credential | prefix | life | bound to | where it lives |
|---|---|---|---|---|
| pairing code | `bfnp-` | 5 min, ONE use | — | the QR fragment only |
| access token | `bfnd-` | 15 min | the network region it was issued in | `bifrost_device` cookie (HttpOnly, SameSite=Strict); JS copy for the bridge |
| refresh token | `bfnr-` | 30 days, rotated on EVERY use | the device | `bifrost_refresh` cookie, path `/api/pair` only |

- **Refresh rotation + theft detection.** Each refresh retires the presented refresh token.
  A retired token presented again more than 30 s later (two tabs racing is not theft) revokes
  the whole device — the attacker and the owner both lose it, and the device list says why.
- **Region binding.** Region = the network the request arrives from (`lib/region.ts`,
  mirrored by `lab/bifrost-net/src/region.rs`): `loopback`, `lan:a.b.c.0/24`,
  `cgnat:100.64.0.0/10`, `net:a.b.0.0/16`, IPv6 equivalents. No GeoIP. A token used from
  another region answers `401 {why:"region", reauth:"refresh"}`; the refresh credential
  re-authenticates and rebinds (counted in the device list as "moved ×n").
  `BIFROST_REGION_POLICY=repair` makes a region change require a fresh QR scan instead.
- **Where the region comes from.** Only `x-bifrost-peer`, which `pwa/server.mjs` stamps
  from the socket after deleting any client-sent copy. Plain `next start` keeps a
  client-sent `X-Forwarded-For` (Next base-server `??=`), so under it every request reads
  as region `unknown` and the box console is not recognized — devices mode must be served
  by `node server.mjs`. Behind a reverse proxy you run, `BIFROST_TRUST_PROXY=1`. The bridge
  needs no help: it reads the real TCP/UDP source address.
- **Rate limits.** Token bucket per device credential lineage (`BIFROST_RATE_BURST` 300,
  `BIFROST_RATE_PER_SEC` 5 → 429 + Retry-After); the pairing surface is limited per peer
  address (`BIFROST_PAIR_BURST` 60, 1/s).
- **Who may do what.** Pairing codes and direct mints: the box console (loopback peer
  behind server.mjs) or `BIFROST_ADMIN_TOKEN` — never a device, so a stolen device token
  cannot buy persistence by minting a sibling. Device list, revoke, kill-switch: the
  console, the admin token, or any live device (a safety control must be reachable from
  the phone in your hand).

## The QR — a security artifact (Part 15 §a.3, §d.2)

```
<BIFROST_PUBLIC_URL>/pair#v=1&code=bfnp-…&fp=sha-256 AB:CD:…&bridge=http://<lan-ip>:7890&box=<name>
```

- The payload is a URL **fragment**: it never reaches a server log, and `/pair` wipes it
  from history before it does anything else.
- **Trust on first scan:** the phone stores `fp` (+ `bridge`) and from then on refuses any
  bridge answer whose `a=fingerprint` differs — before a byte of app data flows. The
  browser's own DTLS then enforces that fingerprint on the wire, so injected candidates
  or a swapped answer (the signaling MITM of Part 15 §a.3) fail closed.
- **Replay:** the code is single-use → 410 `used`. **Expiry:** 5 min → 410 `expired`; the
  console re-mints at expiry. **Revoke-on-repair:** a browser that still holds an old
  refresh cookie retires its previous device when it claims a new code. **Kill-switch**
  burns every outstanding code.
- The fingerprint is stable because the bridge persists ONE DTLS identity
  (`dtls_cert_file`, chmod 600). Deleting that file = a new box key = every phone must
  re-scan (the pin will refuse the new key, by design).

## Transport

- **App semantics stay HTTP(S)** (Part 15 §b) — every existing `/api` route and e2e spec is
  unchanged; S1 gates them in `BIFROST_AUTH=devices` mode.
- **The pinned P2P data channel** (`/p2p`, `lib/p2p.ts` ↔ `lab/bifrost-net` bridge) is the
  v0.9 flagged transport: hello / session.list / session.create / transcript / prompt →
  `run.done {reply}` / voice.commit, plus the control plane below. It is the one place a
  browser lets the app pin a self-signed box key without a CA, which is why it exists
  before LAN HTTPS does. It does not replace the session UI's fetches.
- **Accountability of live peers.** The bridge re-checks every connected peer every 500 ms
  and severs it (`{"op":"severed","why":…}`, then disconnect) when its device is revoked,
  the kill epoch moves, or its access token lapses (30 s grace). Clients renew in-band with
  `{"op":"auth.refresh","token":…}` (same device, region checked against the media path).
- **Voice** rides LiveKit as today; its P2P-first/relay-fallback is LiveKit ICE pointed at
  bifrost-net TURN (Part 15 §b) — configuration, not invention, and not changed by v0.9.

## Relay fallback (NAT traversal) — user-owned, specified, not yet built

When the phone is not on the box's LAN:

1. The user rents a small server (their account, their country). `bifrost-net serve` runs
   there as the **access point** — mesh (boringtun / WireGuard protocol) + UDP relay.
2. The box dials OUT to the access point over the mesh and keeps the tunnel alive
   (invariant 1). Nothing listens on the box's internet side.
3. The bridge advertises the access point's public address as an extra candidate; the
   access point forwards that UDP through the tunnel to the bridge's media socket. DTLS is
   end to end phone ↔ box, so the access point carries **ciphertext only** — it cannot read
   or forge app data even though it is in the path (the QR pin still decides).
4. Remote signaling (`/offer`) is tunneled the same way. No other party is involved.

**The DERP comparison, named so nobody rediscovers it:** this is tailscale's DERP design
(a relay that forwards encrypted packets it cannot read, used only when direct paths fail).
The delta vs tailscale is sovereignty of the coordination plane — the user owns the relay
and there is no org control server — not capability. The tunnel can be validated with a
plain WireGuard container first and swapped to boringtun without changing the product seam.

## Kill-switch

`POST /api/pair/kill` ("sever all bridges", `/devices`): every device revoked (reason
`kill-switch`), every pairing code burned, `killEpoch` incremented; the bridge drops every
live peer on its next sweep. Recovery = scan a fresh QR. Measured: severed in ~0.3 s.

## Operating it

- Box: `node server.mjs` with `BIFROST_AUTH=devices`, `BIFROST_DEVICES_FILE`,
  `BIFROST_PUBLIC_URL=http://<lan-ip>:<port>`, `BIFROST_BRIDGE_URL`, optional
  `BIFROST_ADMIN_TOKEN`; and `bifrost-net bridge -c bridge.toml` with `tokens_file` = the
  same registry, `dtls_cert_file`, `public_url`, `candidates = ["<lan-ip>"]`,
  `media = "<lan-ip>:<port>"`.
- Pair: open `/pair` on the box's own screen → scan with the phone.
- Validate: `scripts/v09-ladder.sh <lan-ip>` (RELEASE-REPORT.md).
