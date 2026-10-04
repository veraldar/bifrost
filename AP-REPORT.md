# LANE AP report: bifrost-net becomes the access point

**Verdict: GREEN for the edge, channel, PWA proxy, websocket/SSE and token gate. The voice
MEDIA leg is not built** (signaling flows; RTP/UDP does not cross the ap yet; see "What
remains"). Nothing touched the VPS: the deployment is packaged, dry-run tested and
waiting for the operator.

Branch `lane2/merge`, commits `50f4066` → `f323c89` (plus this report). Territory kept:
`lab/bifrost-net/` + `docs/claims.md` + this file. pwa/agent/brain untouched.

## Built

`bifrost-net ap -c ap.toml` is a new file `src/ap.rs`, in the existing module style (one file,
one subcommand, selftest inside).

| Piece | What it is |
|---|---|
| TLS edge | rustls (ring), TLS 1.2 + 1.3 only, ALPN http/1.1, cert/key from PEM paths, `Strict-Transport-Security: max-age=31536000` stamped on every response (incl. 503/401). No nginx or docker dependency. |
| Bridge channel | The bridge dials **out** to `wss://<ap>/ap`. It is a real RFC 6455 websocket (masked client frames, ping/pong every 15 s, 45 s silence ⇒ re-dial with 1→30 s backoff). The bridge **pins the ap's SPKI sha-256** and still verifies the handshake signature against the pinned key. It presents a pairing Bearer that the ap stores **only as its sha-256**. One bridge per ap; a new registration replaces the old one. |
| Mux | Each browser TCP connection is one stream: `[kind][id][payload]`, with OPEN = client IP + request head, then DATA and CLOSE. Covers plain HTTP, request bodies, SSE (`/api/run-events`) and websocket upgrades (`/rtc` → LiveKit signaling when `livekit = …` is set). |
| S1 gate (on the bridge) | `/api/*` needs a live, unexpired device token (Bearer or `bifrost_device` cookie), checked against the **bridge's** registry (`tokens.rs`, the same file the PWA mints). It is region-checked against the **real client address the ap saw on its socket**. `/api/pair*` is open because pairing mints there. The 401 body matches the PWA middleware (`why`, `reauth`). The ap verifies nothing. |
| Proxy hygiene | Client-sent `X-Forwarded-*`, `X-Real-IP`, `X-Bifrost-Peer`, `Forwarded` and `X-Middleware-Subrequest` are deleted; `X-Forwarded-For` is stamped with the real peer. One request per upstream connection (`Connection: close`). Only the declared `Content-Length` body is forwarded, so a pipelined request can't be smuggled past the gate. Chunked request bodies are refused (411). Upgrade bytes flow only after the upstream's 101. The gate classifies a **normalized** path (repeated %-decode, `\`→`/`, dot/empty segments, case-fold). |
| nginx SNI mode | `proxy_protocol = true` reads nginx's PROXY v1 line, so the client region survives SNI passthrough. The ap refuses that setting unless it listens on loopback, and a connection without a PROXY line is dropped. |
| Helpers | `ap-token` (raw for the bridge + sha-256 for the ap), `ap-pin CERT.pem` (equals `curl --pinnedpubkey sha256//…`), `ap-cert DIR NAMES…` (self-signed, for local runs), `selftest ap`. Pins may be comma-separated for key rotation. |
| bridge.toml | New `[ap]` section: `url`, `pin`, `token`, `upstream` (default `127.0.0.1:8090`), optional `livekit`. `bridge_main.rs` starts the dialer, which reuses `[bridge].tokens_file`. |

## Working (evidence, this machine)

`lab/bifrost-net/ap-verify.sh` runs the **real chain**: curl → `ap` process (self-signed,
:4443) ← `bridge` process dialing out, pinned → the live sandbox PWA on :8090.
**AP VERIFY: 14/14 PASS, AP VERDICT: GREEN** (run several times, last on the final binary):

1. `selftest ap` (in-process, stub upstream): wrong pairing token → 401; wrong pin →
   TLS refused; spoofed XFF dropped; 9 path-normalization bypass shapes → 401; 5000-byte POST
   exact + smuggled pipelined request dropped; websocket 101 + 3000 bytes byte-exact.
2. Bridge offline → 503 + HSTS.
3. The bridge dialed out and registered (`channel up`, `link #1`).
4. **`curl -k https://127.0.0.1:4443/` → 200, the PWA's HTML (8758 B) + HSTS.**
5. The pin is the standard SPKI sha-256: `curl --pinnedpubkey` accepts it and rejects a wrong
   one (exit 90).
6. TLS 1.2 → 200, TLS 1.3 → 200, TLS 1.1 refused.
7. **A device-token'd request passes**: `/api/session` → 200 with Bearer and with cookie.
8. **An uncredentialed request → 401**, both from loopback and LAN-style (`--interface
   192.168.1.89` → `https://192.168.1.89:4443`). A bad token → 401 `invalid`.
9. The region comes from the socket: a LAN-issued token passes from the LAN. A loopback
   token replayed from the LAN with a spoofed `X-Forwarded-For: 127.0.0.1` → 401 `region`.
10. **SSE `/api/run-events`** (the PWA route is SSE, not a websocket): 200
    `text/event-stream`, the first event arrives through the chain, and the stream stays open.
11. **Websocket upgrade through the chain** (`/rtc` → signaling stand-in): 101 + 20000
    random bytes echoed exact.
12. The bridge→ap socket is outbound; no inbound port is opened for it.
13. Bridge killed → 503. Bridge restarted → re-registers → 200.
14. SNI/PROXY mode (stand-in nginx front): the region follows the PROXY line; a bare
    connection is refused.

Regressions on the same build: **M0 3/3 GREEN, M1 5/5 GREEN, V9 GREEN** (V9.2 channel
protocol vs live opencode, V9.3 voice vs speaches; STT heard 4/4 keywords). There are zero
new warnings; the 5 that remain are pre-existing in bridge.rs/speech.rs.

## What remains

1. **Voice media through the ap (brief item 3), not built.** `/api/token` and the
   LiveKit signaling websocket (`/rtc`) flow today. RTP does not, because the channel
   carries TCP only. There are two paths, cheapest first:
   - **LiveKit ICE-TCP over the channel:** add raw TCP stream forwards to the ap
     (`[[ap.tcp]] listen = ":7881"` → bridge target `127.0.0.1:7881`, same mux, no HTTP
     parsing), and set LiveKit `rtc.tcp_port: 7881`, `node_ip: <VPS IP>`. That's about 40
     lines plus a LiveKit config change. It needs a phone test to prove.
   - **bifrost-net relay on the VPS** (relay.rs/str0m, already proven 39/39 frames in M1):
     the phone does WebRTC to the ap's UDP port, and the ap cross-forwards to the bridge
     peer. This adds an open UDP port on the VPS.
2. **The sandbox PWA should run behind `server.mjs` with `BIFROST_TRUST_PROXY=1
   BIFROST_AUTH=devices` on `127.0.0.1:8090`.** Today it is plain `next start` on `*:8090`
   in tailnet mode. The bridge gate covers `/api/*` anyway, but the PWA's pairing flow
   needs the stamped real IP to mint correctly region-bound tokens. This is PWA/ops
   territory (frozen for this lane). Hit directly, :8090 answers `/api/session` 200 with no
   credentials (probed from loopback). It listens on `*:8090` in tailnet mode, so its
   LAN exposure is a separate risk.
3. **Hardening not done:** flow control (per-stream queues are unbounded, so a slow
   reader of a big response buffers on the ap), connection limits / rate limiting at the
   edge, HTTP→HTTPS redirect on :80 (nginx keeps :80 for certbot; add a `return 301`
   there), and h2 (http/1.1 only today).
4. **Not exercised:** a real browser/phone through a real LE cert, and real nginx (stand-in
   used: no nginx on this box). The VPS glibc is unknown: the binary needs glibc ≥ 2.38 +
   libopus0. The script preflights both and offers `AP_BUILD=remote`.

## VPS deployment, exact operator steps

Full detail in `lab/bifrost-net/deploy-vps.md`. Run from this box, in `lab/bifrost-net`:

1. **DNS:** `sandbox.veraldar.org A <VPS IP>` (a second IP only for the `direct` option).
2. **Cert (website session):**
   `sudo certbot certonly --nginx -d sandbox.veraldar.org --reuse-key`. `--reuse-key`
   keeps the bridge's pin valid across renewals.
3. **Share :443 with nginx.** Pick one:
   - **B, `sni`** (one IP, recommended): add the `stream { map $ssl_preread_server_name … ;
     server { listen 443; ssl_preread on; proxy_pass $bifrost_upstream; proxy_protocol on;
     } }` block from deploy-vps.md §2-B. Move the site's `listen 443 ssl` to `listen
     127.0.0.1:8444 ssl proxy_protocol;` + `set_real_ip_from 127.0.0.1; real_ip_header
     proxy_protocol;`. `apt install libnginx-mod-stream` if needed, then
     `sudo nginx -t && sudo systemctl reload nginx`.
   - **A, `direct`**: nginx binds `<SITE_IP>:443` only; the ap takes `<SANDBOX_IP>:443`.
4. **Dry run:** `DRY_RUN=1 ./deploy-vps.sh sni` prints every remote step and changes nothing.
5. **Deploy:** `./deploy-vps.sh sni` (or `AP_LISTEN=<ip>:443 ./deploy-vps.sh direct`).
   It mints the pairing token and installs `/usr/local/bin/bifrost-net`,
   `/etc/bifrost-ap/ap.toml` and `bifrost-ap.service` (DynamicUser, cert+key via
   `LoadCredential`) plus the certbot deploy hook. It then reads the pin from the public cert,
   writes `[ap]` into `~/.local/state/bifrost-bridge/bridge.toml` (backup kept), restarts
   `bifrost-bridge.service`, and probes from outside. It expects `/` → 200 + HSTS and
   `/api/session` → 401, then prints **`DEPLOY: GREEN`**.
6. **Phone:** open `https://sandbox.veraldar.org`, then pair. Voice media waits on "What
   remains" #1.

Rollback: `sudo systemctl disable --now bifrost-ap`, restore nginx's `listen 443 ssl`, delete
`[ap]` from bridge.toml, then `systemctl --user restart bifrost-bridge`.
