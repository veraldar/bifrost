# Deploying the access point — sandbox.veraldar.org

```
phone ──https://sandbox.veraldar.org──▶ VPS :443 ── bifrost-net ap (TLS ends here)
                                                        ▲  one wss channel, opened FROM the box
omarchy (the box) ── bifrost-net bridge ──dials OUT─────┘  pinned (SPKI) + pairing token
        └─ serves each browser stream from the sandbox PWA 127.0.0.1:8090 (S1 gate on the bridge)
```

The box never accepts inbound internet. The ap holds no device secrets: it knows the
bridge's pairing token only by its sha-256, and every device-token check runs on the
bridge against the box's registry, using the client address the ap saw.

## 1. Certificate (website-session step, not this script)

Issue the cert next to the existing site. Use **`--reuse-key`**: the bridge pins the
public key, and reusing the key keeps that pin valid across renewals.

```sh
# webroot / nginx plugin, whichever the site already uses:
sudo certbot certonly --nginx -d sandbox.veraldar.org --reuse-key
# existing cert:  sudo certbot reconfigure --cert-name sandbox.veraldar.org --reuse-key
```

Files consumed: `/etc/letsencrypt/live/sandbox.veraldar.org/{fullchain,privkey,cert}.pem`.
`deploy-vps.sh` installs `/etc/letsencrypt/renewal-hooks/deploy/bifrost-ap.sh`, which
restarts the ap after each renewal (systemd `LoadCredential` re-reads the root-only key
on restart, so the service itself runs as an unprivileged `DynamicUser`).

DNS: `sandbox.veraldar.org A <VPS IP>`. Option A below needs its own IP.

## 2. Pick how :443 is shared with nginx

nginx already owns :443 for veraldar.org. You have two options.

### Option A: `direct`, the ap owns :443 on a dedicated IP

Use this when the VPS has a second IPv4 address. Point `sandbox.veraldar.org` at it, and make
nginx bind only the site's IP:

```nginx
# in every existing site server block:  listen 443 ssl;  →
listen <SITE_IP>:443 ssl;
```

```sh
AP_LISTEN=<SANDBOX_IP>:443 ./deploy-vps.sh direct
```

The ap sees the phone's real address directly, so `proxy_protocol = false`.

### Option B: `sni`, nginx passes `sandbox.veraldar.org` through untouched (one IP)

nginx stops terminating TLS on the public :443. A `stream` block reads the SNI (no
decryption) and passes **sandbox.veraldar.org** to the ap on `127.0.0.1:8443`. Every other
name goes to the site, which moves to `127.0.0.1:8444`. `proxy_protocol on` carries the
phone's real address to both. The ap needs it because device tokens are region-bound.

`/etc/nginx/nginx.conf` (top level, beside `http {}`; needs `ngx_stream_module` +
`ngx_stream_ssl_preread_module`. On Debian/Ubuntu: `apt install libnginx-mod-stream`):

```nginx
stream {
    map $ssl_preread_server_name $bifrost_upstream {
        sandbox.veraldar.org  127.0.0.1:8443;   # bifrost-net ap (TLS ends there)
        default               127.0.0.1:8444;   # the existing site (nginx http, below)
    }
    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;
        proxy_pass $bifrost_upstream;
        proxy_protocol on;
        proxy_connect_timeout 5s;
        proxy_timeout 1h;            # long-lived: the bridge channel, SSE, websockets
    }
}
```

The site's existing server blocks: replace `listen 443 ssl` / `listen [::]:443 ssl` with
the loopback PROXY-aware listener, and restore real client IPs for its logs:

```nginx
server {
    listen 127.0.0.1:8444 ssl proxy_protocol;
    http2 on;
    set_real_ip_from 127.0.0.1;
    real_ip_header proxy_protocol;
    server_name veraldar.org www.veraldar.org;
    # … certificates and locations unchanged …
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
./deploy-vps.sh sni
```

The ap refuses to start with `proxy_protocol = true` unless it listens on loopback,
because otherwise anyone could forge their address. A direct connection that skips
nginx (no PROXY line) is dropped. `ap-verify.sh` check 14 proves both, using a
stand-in for nginx.

## 3. Run it

```sh
cd lab/bifrost-net
DRY_RUN=1 ./deploy-vps.sh sni     # prints every remote step, changes nothing
./deploy-vps.sh sni               # or: AP_LISTEN=<ip>:443 ./deploy-vps.sh direct
```

What the script does:

1. Preflight: the LE files exist, and the VPS glibc is ≥ 2.38 (the binary also needs
   `libopus0`). If the glibc is older, rerun with `AP_BUILD=remote`, which builds on the
   VPS and needs rustup + `libopus-dev` there.
2. `bifrost-net ap-token`: the raw pairing token goes only into this box's
   `bridge.toml`. The VPS gets its sha-256.
3. Installs `/usr/local/bin/bifrost-net`, `/etc/bifrost-ap/ap.toml`,
   `bifrost-ap.service` (DynamicUser, CAP_NET_BIND_SERVICE only, ProtectSystem=strict,
   `LoadCredential` for cert+key) and the certbot deploy hook. Then
   `enable --now`.
4. Pin: `bifrost-net ap-pin` over the public `cert.pem`. To check it independently:
   `openssl x509 -in cert.pem -pubkey -noout | openssl pkey -pubin -outform der | sha256sum`
   (the same bytes, printed as hex).
5. Writes `[ap]` into `~/.local/state/bifrost-bridge/bridge.toml` (keeps a backup and
   replaces any previous `[ap]`), restarts `bifrost-bridge.service` (user unit), and waits
   for `channel up`.
6. From outside: `https://sandbox.veraldar.org/` must return 200 with HSTS, and
   `/api/session` without a token must return 401. Then it prints `DEPLOY: GREEN`.

Resulting bridge section (this box):

```toml
[ap]
url = "wss://sandbox.veraldar.org/ap"
pin = "sha-256 AA:BB:…"             # comma-separate two pins during a key rotation
token = "<64 hex, chmod 600 file>"
upstream = "127.0.0.1:8090"          # the sandbox PWA the phone gets
# livekit = "127.0.0.1:7880"         # /rtc → LiveKit signaling (voice), see §6
```

## 4. The sandbox PWA behind it

The bridge stamps `X-Forwarded-For: <phone's real IP>` after deleting any copy the client
sent, and also `X-Bifrost-Peer`, `Forwarded` and `X-Real-IP`. For the PWA's own
region-aware logic (pairing mints region-bound tokens) to use that address, run the
sandbox through `server.mjs` with `BIFROST_TRUST_PROXY=1 BIFROST_AUTH=devices`, bound to
`127.0.0.1:8090`. Today's sandbox is plain `next start` on `*:8090`, so the PWA sees every
proxied request as unknown/loopback. The bridge's own gate still enforces device tokens
on `/api/*` regardless. That gate is what `ap-verify.sh` checks 7–9 prove.

## 5. Operating it

- Logs: `journalctl -u bifrost-ap -f` on the VPS (shows registrations, `link #n down`, and
  refused bridges). On the box: `journalctl --user -u bifrost-bridge -f`.
- Bridge offline: the ap answers 503 `bifrost: the bridge is offline`. The bridge
  re-dials with 1→30 s backoff. A new registration replaces the old one (one bridge per
  ap).
- Rotate the pairing token: rerun `deploy-vps.sh`, which mints a new token and replaces
  both sides.
- Key rotation without downtime: put `pin = "<old>,<new>"` on the bridge, renew with the
  new key, then drop the old pin.
- Rollback: `sudo systemctl disable --now bifrost-ap` and restore nginx's `listen 443 ssl`.
  On the box, delete `[ap]` from `bridge.toml` and restart `bifrost-bridge`.

## 6. Voice: what flows today and what doesn't

- `/api/token` (device-gated) and the LiveKit signaling websocket (`/rtc`, with
  `livekit = "127.0.0.1:7880"` in `[ap]`) both flow through the channel. LiveKit's JWT
  gates `/rtc`.
- **Media (UDP/WebRTC) does not cross the ap yet.** The channel carries TCP streams only.
  The next slice is either LiveKit ICE-TCP (tunnel :7881 as a raw stream and set
  LiveKit `node_ip` to the VPS) or the bifrost-net str0m relay on the VPS (relay.rs) with
  its UDP port open there. See `AP-REPORT.md`.
