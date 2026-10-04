# v0.9.0 — no-tailscale direct pairing (ONE arc, ONE tag)

Base: this worktree (release/v0.9.0 = the merge-wave tip, gate-verified
47/47). Existing groundwork in-tree: S1 device tokens (mint + middleware
gate + revocation, e2e 2/2) and `lab/bifrost-net` (bridge: token-gated
signaling + data-channel app API, GREEN 3/3; voice pipeline GREEN). The
review law is `docs/reviews/agi-roadmap-review.md` Part 15 — read it first.

## The arc (internal commits per milestone, evidence as you go)

1. **S1 FULL semantics first** (transport security depends on it):
   short-lived access tokens + refresh flow, hashed at rest (never
   plaintext), device list + revoke + KILL-SWITCH ("sever all bridges"),
   token bound to first-seen network region with re-auth on region change,
   per-token rate limits. Audit what 9c0425e already gives, build the gap,
   keep its e2e green.
2. **WebRTC transport — P2P first**: LAN pairing needs NO signaling server
   (Part 15 §3): the QR carries the box fingerprint (hash of the DTLS
   cert / WireGuard pubkey) + one-time pairing code + the token;
   trust-on-first-scan. str0m for WebRTC, boringtun for the mesh (no
   hand-rolled crypto). **Relay fallback**: bifrost-net relay for NAT
   traversal, specified as USER-OWNED infrastructure (the access point is
   the user's; the org never operates one — Part 15 §2, this sentence goes
   in the spec/docs you write).
3. **/pair QR + iPhone auto-setup**: the box serves /pair → QR; scanning on
   the phone auto-sets the PWA up (pairs the device, mints its token, lands
   on MAIN). Phone = any mobile browser context.
4. **Validate end-to-end on this machine**: box + two browser "devices"
   (desktop + phone-emulated), the full ladder: pair via QR → token mint →
   P2P data channel → app round-trip through the transport (message lands
   in a yggdrasil/brain session) → revoke from the device list → killed
   mid-session → kill-switch severs everything → re-pair works. Then the
   release tag.

## Gates

You tag nothing. When the validation ladder is green: write
RELEASE-REPORT.md (built / skipped / honest why + how to run the ladder),
commit, and exit. The operator runs the gate and cuts tag v0.9.0.

## Facts

- Toolchain: `source ~/.cargo/env` (Rust) + pwa node/npm; playwright
  browsers in ~/Work/bifrost/pwa/node_modules.
- The e2e config has NO webServer: serve your build on :8095 and run with
  `PW_BASE_URL=http://127.0.0.1:8095` for browser specs; specs that
  hardcode :8080 are hit by serving YOUR build there while lk-pwa is
  stopped — coordinate via the operator note in RELEASE-REPORT.md, do NOT
  stop live services yourself.
- Territory: this worktree + lab/bifrost-net. ~90 minutes. Blocked twice on
  the same thing: stop, write the blocker, exit.
