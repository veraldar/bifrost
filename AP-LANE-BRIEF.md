# LANE AP — bifrost-net becomes the ACCESS POINT (TLS 443, no tailscale)

The architecture (driver-locked): the phone reaches **https://sandbox.veraldar.org**
(no port, no tailscale) → TLS terminates on the **veraldar VPS** where
bifrost-net runs as the ACCESS POINT → the PWA + the voice path flow through
it → the **bridge on omarchy dials OUT to the access point** (server-to-server;
the box never accepts inbound internet). LE cert for sandbox.veraldar.org is
issued on the VPS beside the existing site (operator/website-session step —
you consume cert+key file paths, you do not run certbot).

## Build (Rust, in this worktree's lab/bifrost-net)

New subcommand: `bifrost-net ap -c ap.toml`:

1. **TLS termination on 443** (rustls; cert_path/key_path from config; TLS1.2+;
   HSTS header). No docker, no nginx dependency — the ap IS the edge.
2. **PWA reverse proxy**: HTTPS → the bridge's registered internal channel
   (the bridge dials OUT to the ap and registers: `bridge.toml` gains
   `[ap] url = "wss://sandbox.veraldar.org/ap"`, cert pin = the ap's
   fingerprint, token = a pairing-scoped credential). The ap forwards
   browser requests over that channel to the bridge, which serves them from
   the local sandbox PWA (127.0.0.1:8090) and returns responses. WebSocket
   passthrough included (the PWA's /api/run-events + LiveKit-style signaling).
3. **Voice path**: WebRTC audio relay through bifrost-net (relay.rs exists):
   the phone's browser speaks WebRTC natively to the ap; the ap relays media
   to the bridge's peer. Signaling rides the same registered channel (the
   PWA's existing /api/token + LiveKit-style flow MAY be reused behind the
   proxy — prefer that: least new protocol).
4. **Tokens**: the existing S1 device tokens gate everything (the ap trusts
   the bridge's device registry — token verification stays on the bridge).

Config file (ap.toml): listen 443, cert/key paths, the pairing token the
bridge must present, the LAN address of the bridge-facing sandbox (if any).
Keep the code in the existing module style (serve.rs/relay.rs/bridge.rs);
new file ap.rs.

## Deployment package (docs + script, no VPS access from here)

`lab/bifrost-net/deploy-vps.sh` + `deploy-vps.md`: scp the ap binary + config
to the VPS, systemd unit, the cert paths the site's certbot maintains
(document the nginx cooperation: nginx may own 443 for the main site — then
the ap listens on 443 of a dedicated IP or nginx streams/passthroughs
sandbox.veraldar.org SNI to the ap on 8443-internal; write BOTH options with
the exact nginx snippet for SNI passthrough).

## Verification on THIS machine (no VPS needed)

- Locally: run the ap with a self-signed cert on :4443, run the bridge with
  `[ap]` pointing at it (pin + token), serve the sandbox PWA through the
  chain: `curl -k https://127.0.0.1:4443/` → the PWA answers; a WebSocket
  route (/api/run-events) upgrades through the chain; a device-token'd
  request passes; an uncredentialed LAN-style request 401s.
- The existing selftests (m0/m1/v9) stay green.

## Facts

- `source ~/.cargo/env`. Territory: lab/bifrost-net + deploy docs. The pwa/
  brain/agent are FROZEN for this lane.
- You have until ~22:25 — hard stop, commit whatever is green, write
  AP-REPORT.md (built/working/what remains + the exact VPS deployment steps
  for the operator).
