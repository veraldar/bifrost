# bifrost-net — M0 findings

**Mission**: de-risk spike for the sovereign access point (docs/vision.md,
bifrost-net). THE QUESTION: can a correctly-prompted AGI rebuild
tailscale+webrtc in Rust — one binary on a VPS, country chosen by the user —
from PROVEN crates only?

**M0 scope (small, per playbook)**: two local nodes mesh via boringtun
(WireGuard protocol) + str0m WebRTC echo relay. Not the product — the two
seams everything else hangs on.

**Date**: 10-03 · **Session**: BIFROST-NET-LAB · **Verdict: FEASIBLE — M0 GREEN, 4/4 runs**

---

## Verification

```
$ ./m0-verify.sh
M0.1 PASS — two nodes connected privately (WireGuard protocol)
M0.2 PASS — WebRTC media relayed and byte-verified
M0 VERDICT: GREEN — both seams proven
VERIFY: 3/3 PASS
```

- **M0.1 mesh**: full Noise_IKpsk2 handshake between node A (10.7.0.1) and
  node B (10.7.0.2), real UDP sockets on loopback, boringtun state machines
  doing all crypto. A→B encrypted ping, B→A encrypted pong, payloads
  byte-verified. Negative test: an impostor node with the wrong static key is
  **rejected at handshake** (WireGuard's Noise IK identity check) — the
  privacy claim has evidence, not vibes.
- **M0.2 echo**: two str0m peers, real loopback UDP, full ICE + DTLS + SRTP
  (no shortcuts, no rtp_mode bypass). L sends paced Opus-shaped frames; R —
  acting as the relay/echo peer — re-emits each frame; L verifies byte-exact.
  59 frames round-tripped, zero corruption.
- **Stability**: 4/4 runs green (1 dev + 3 repeat + verify script).

## What worked (and worked well)

1. **boringtun 0.7 delivered the WG protocol as a library.** `Tunn::new` +
   `format_handshake_initiation` / `decapsulate` / `encapsulate` — the whole
   WireGuard protocol usable without root, without kernel TUN, embedded in a
   normal process. This is the load-bearing fact for the whole vision: the
   mesh IS embeddable in the one binary.
2. **str0m 0.24 is a real WebRTC stack, not a toy.** Full ICE+DTLS+SRTP came
   up between two peers with no browser, no signaling server, no SDP text
   munging — `sdp_api()` offer/answer in-process. The media event/writer API
   (`Event::MediaData` → `writer(mid).write(...)`) is exactly the SFU seam.
3. **The build "just worked".** Feared blocker (aws-lc-rs needing
   cmake/nasm — neither installed here) did not materialize on x86_64 Linux;
   prebuilt-bindings path compiled clean in ~35s debug / 1m24s release.
4. **Smallness is real.** Release binary **6.4MB stripped**, dependency tree
   **232 lines total** (incl. transitive). Compare the incumbent on this box:
   livekit/livekit-server **137MB image, ~150MB RSS** for the WebRTC half
   alone. A bifrost-node is one small binary + systemd unit.

## What AGI struggled with (honest log)

1. **Crate APIs outran training memory.** boringtun 0.6→0.7 (keygen moved,
   `Tunn::new` no longer returns Result), str0m 0.6-era→0.24 (crypto moved to
   provider crates, `MediaData` fields renamed, `SdpApi::apply` returns
   Option). Writing against remembered APIs produced ~4 compile errors; the
   fix was mechanical but mandatory: **read the vendored source + the crate's
   own tests first** (`~/.cargo/registry/src/.../tests/` is the best API doc
   str0m has). Playbook lesson: pin crate versions in the prompt.
2. **Session-establishment semantics.** First mesh run failed because A
   waited for `TunnResult::Done` to consider itself connected — but Done only
   comes to the *responder* processing the keepalive; the *initiator's*
   session exists as soon as the handshake response is processed
   (WriteToNetwork arm). One state-flag bug, found by reasoning against the
   crate's own test choreography, fixed in one line. Fine for M0; the full
   build must handle rekey/timeout paths with the same care (update_timers
   loops — untested at M0, see Limits).
3. **etherparse 0.21 API churn** (no flat `.payload` on SlicedPacket;
   transport-slice match instead). Minor, mechanical, same class as (1).
4. **Nothing else.** No flaky timing, no race conditions, no environment
   blockers. The two hardest networks problems (crypto protocol, WebRTC
   media) were *library problems*, not *research problems* — that is the
   entire thesis of "assemble from proven crates" holding up.

## Rule 10-02 — what the life taught before any code

Studied the live stack first (this box runs the real thing):

- **The scar in deploy/livekit.yaml**: LiveKit auto-detected docker-bridge
  IPs as ICE candidates and the phone had **no media path** until IPs were
  hand-pinned to tailscale0 + LAN. This is the class of time-dependent
  behavior an API surface hides. bifrost-net must make "who can reach whom"
  explicit config from day one, not auto-detect-and-hope.
- **Tailscale life**: 6 nodes, 2 accounts (phone is on a *different* tailnet
  than this box), direct connections via LAN when available. The mesh needs
  to treat coordination as a product concern (key distribution), not an
  afterthought — that's what tailscale actually sells.
- **Incumbent size**: LiveKit 137MB image / ~150MB RSS. Sets the bar the
  smallness thesis must beat (6.4MB binary at M0 — on track).
- **The phone path today**: PWA → tailnet → LiveKit → agent worker. Media
  already terminates on a general-purpose box; bifrost-net replaces two
  vendors' daemons with one auditable binary we ship ourselves.

## Verdict for the full build

**FEASIBLE — proceed if the sovereign tier triggers.** The M0 evidence:

| Claim | M0 status |
|---|---|
| WireGuard mesh from crates, no hand-rolled crypto | **proven** (boringtun, incl. impostor rejection) |
| WebRTC media relay from crates | **proven** (str0m echo, byte-exact) |
| One small binary, few deps, auditable | **on track** (6.4MB, 232 dep-tree lines) |
| AGI can assemble it correctly-prompted | **demonstrated at M0 scale** (~1 working session, zero env blockers) |
| Safer than tailscale | **NOT CLAIMED** — needs audit. Current honest claim: auditable smallness + country-pinned hosting + self-hosted |

### M1+ order (when the spike is called)
1. **Rekey + timer loop**: run boringtun `update_timers` under sustained
   traffic, force rekeys, drop-packet chaos — M0's session logic is the thin
   part.
2. **Real reachability**: same test across two LAN machines (then a VPS),
   including the ICE-candidate-pinning lesson made config.
3. **Coordination**: key distribution + node registry (what headscale does)
   — the actual product gap, not crypto.
4. **TUN/routing** for true drop-in mesh (needs CAP_NET_ADMIN; /dev/net/tun
   is world-writable here, so testable on this box without root).

### Limits of M0 (read before citing this file)
- Loopback only; no NAT, no loss, no rekey, no persistence.
- No kernel TUN — "mesh" here = WG protocol + encrypted transport between
  userspace processes, which is what a VPS binary would actually embed.
- Echo test = relay seam, not a load-bearing SFU (no simulcast/bwe/NACK
  chaos). str0m has these; M0 didn't test them.
