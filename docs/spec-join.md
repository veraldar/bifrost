# spec — join a new machine to the tree (contract v1, hub side)

Status: built on `hub-join` (branch/). The joining side is `root/install/join.sh`. This
spec is the contract between the two. Validated by `scripts/v09-ladder.sh e2e/join.spec.ts`, and
end to end through an access point (a simulated phone approves) by `sim/trunk-full-e2e.sh`.

**Change (roots-learn, 2026-11-13): `hub` is now the hub brain's root name.** Until then the
approval's `hub` was the literal `"local"` (the switchboard's address for the hub brain), and
the joining side named its peer for the hub brain `hub`. Reports from the joined root go to
`report_to.root`, which is the hub brain's `YGG_ROOT_NAME`, so they only arrived when the hub
brain happened to be named `hub`. Now the app asks its brain for the name and sends it, and
the joining side writes `YGG_PEERS <hub>=http://127.0.0.1:<peer port>/local`. The address is
always `/local`. A joiner that gets no `hub`, an empty one, or an older hub's `"local"` uses the
name `hub`, as before. The other side of the same gap is closed in the hub brain: it learns
every root that links to the trunk by itself (`YGG_PEERS_FROM`, below).

**Change (trunk-wg, 2026-11-14): approving a join pins the machine's WireGuard key.** Brain
calls between roots (`GET /root`, `session_start` on another root, reports home) now ride a
WireGuard tunnel end to end between the two roots (`bifrost-net wg`, trunk/src/wg.rs). The hub's
bridge and the access point only relay its datagrams. The joining machine makes its own key and
sends the public half with the join (`wg_pub`). The approve page shows the key's fingerprint
next to the code, so approving the code pins that key. The hub stores it in `roots.json` with a
tunnel address, and the poll hands back the hub's public key and the addresses (`wg`). The
plaintext switchboard (`/_root/<id>/`, a root's `http` ops) is off on the bridge unless it opts
in for roots joined before this (`[bridge.root-link] plaintext_http = true`). See
[The tunnel](#the-tunnel-root--root-over-wireguard) below.

## The shape in one paragraph

The **hub** is the box whose app is the access point's upstream. A **new machine** (Linux,
WSL2, macOS or Windows) installs a root and asks the hub to join its tree. The machine
shows a QR code (the approve URL) and an 8-character code. The owner scans the QR with a
phone that is already paired (docs/spec-pairing.md), checks that the phone shows the same
code, and taps **Add to my tree**.

The hub then does four things:
- names the root (a unique id);
- mints 20 single-use **link tokens** with the trunk's own CLI;
- creates the root's long-lived **root credential**;
- lets the approving phone reach the new root (adds it to that phone's `roots` allowlist).

The machine collects all of this **once** by polling with its join secret. Afterwards it
dials the trunk's root-link plane with a link token (roots dial OUT; nothing listens on the
root). It buys more tokens with its root credential.

## Endpoints

All are reached through the public URL (`BIFROST_PUBLIC_URL`).

| # | call | auth | answer |
|---|---|---|---|
| 1 | `POST /api/roots/join` `{name, os, host, wg_pub?}` | none; rate-limited per client address | `201 {req, secret, code, approve_url, poll_url, expires_in}` |
| 2 | `GET /join?r=<req>` (page) | a paired device. Without one, the page sends you to `/pair?unpaired=1` | name, os, host, the code, the tunnel key's fingerprint; **Add to my tree** / **Refuse** |
| 3a | `POST /api/roots/join/<req>/approve` | a paired device | `200 {status:"approved", root_id, name, os, host}` |
| 3b | `POST /api/roots/join/<req>/refuse` | a paired device | `200 {status:"refused"}` |
| 4 | `GET /api/roots/join/<req>`, header `x-join-secret` | the join secret | `202 {status:"pending"}`, `200 {status:"approved", root_id, root_secret, link_tokens[20], rootlink_url, peer_token, hub, wg?}` exactly once, or `410 {status:"refused"\|"expired"}` |
| 5 | `POST /api/roots/<root_id>/tokens`, header `x-root-secret` | the root credential | `200 {link_tokens[20]}` |
| 6 | `GET /api/roots` | a paired device | `{roots:[{id, name, os, host, joined_at, delivered_at, wg_fp}]}` |
| – | `GET /api/roots/join/<req>/view` | a paired device | the page's data: `{req, name, os, host, code, wg_fp, status, expires_at, root_id}`. Has no secrets |

Field details:
- `req` is 18 random bytes, base64url.
- `secret` is 32 hex characters (128 bits).
- `code` is `XXXX-XXXX` from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L).
- `approve_url` is `<public>/join?r=<req>`.
- `poll_url` is `<public>/api/roots/join/<req>`.
- `expires_in` is 600.
- `hub` is the hub brain's root **name**. The app asks its brain when the owner approves:
  `GET <OPENCODE_URL>/root` → `name` (3 s). If the brain does not answer, or its name is not a
  plain root name, it uses the app's own `YGG_ROOT_NAME`, and failing that `"hub"`. A plain name
  matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, the shape the trunk takes for a root id. The
  joining side checks the same shape, refuses a name equal to its own `root_id`, and writes
  `YGG_PEERS <hub>=http://127.0.0.1:<peer port>/local`. Do not name the hub brain `local`:
  joiners read that as an older hub and use `hub`.
- `wg_pub` is the machine's WireGuard public key: canonical base64 of 32 bytes (what
  `bifrost-net wg-key FILE` prints). Anything else answers `400`. A join without it is an older
  joiner: it gets no tunnel.
- `wg_fp` is the key's fingerprint, the same on every screen: the first 6 bytes of
  sha256(the raw 32-byte key), hex, `xxxx-xxxx-xxxx`. `bifrost-net wg-key` prints it, the
  joining machine shows it next to the code, the approve page shows it under the code
  (`data-testid="join-wg-fp"`). Reference: the all-zero key is `6668-7aad-f862`.
- `wg` (in the approval, only when the machine sent `wg_pub` and the hub has a WireGuard node:
  `BIFROST_WG_PUB_FILE` is readable) is `{public_key, hub_ip, ip, net}`: the hub node's public
  key, its tunnel address (`.1` of the tree's range), this root's address, and the range
  (`10.x.y.0/24`). The joining side runs its node with `address = <ip>/<prefix>` and one peer,
  `local` = `public_key` at `hub_ip`, and writes `YGG_PEERS <hub>=http://127.0.0.1:<node
  http>/_wg/local`.
- `name` is capped at 40 characters, `os` at 24, `host` at 64. Control, zero-width and
  bidi characters are stripped. Whitespace is collapsed. If `name` is empty, `host` is used.
  If both are empty, the answer is `400`.

Other answers:
- Approve or refuse on a request that is already decided answers `409`. On an expired one,
  `410`. On an unknown one, `404`.
- A poll with a wrong or missing secret answers `401`. On an unknown `req`, `404`. This also
  happens after a hub restart: start over.
- A second poll after delivery answers `410 {status:"expired", why:"delivered"}`.
- An approval the machine never collected answers `410 {status:"expired", why:"undelivered"}`.
- Approving a join whose `wg_pub` is already pinned to another root answers `409` (a key pins
  one root: the hub's node could not tell two roots apart). When the tree's range is full (252
  roots), `503`.
- A refill answers `401` for an unknown root or a bad secret, and `409 {why:"device-revoked"}`
  when the device that approved the root has been revoked. Join again in that case.
- `429` comes with `Retry-After`.
- `503` means minting is not configured or the CLI failed. The join stays **pending**, so
  the owner can approve again after fixing it.

**Middleware (devices mode):** only the exact method and path shapes of 1, 4 and 5 skip the
device gate:
- `POST ^/api/roots/join$`
- `GET ^/api/roots/join/[A-Za-z0-9_-]{8,64}$`
- `POST ^/api/roots/[a-z0-9][a-z0-9-]{0,40}/tokens$`

Each carries its own credential, or none for the join itself. The access point's edge gate
(`trunk/src/ap.rs`) lets the same three shapes through, so a new machine can join through
the public URL. They still get a per-address burst guard (`BIFROST_PAIR_BURST`, 1/s), so
poll no faster than every 2 s. Every other path under `/api/roots` goes through the device
gate.

Routes 2, 3, 6 and `view` also check for a **device** inside the route. The admin token and
the box console are not devices: they can never approve, because a device id has to become
the tokens' `dev` claim. Tailnet mode is unchanged: the middleware still returns at once.
Approval still needs a paired device, so joins are a devices-mode feature.

## What approval does

1. **Pick the root id.** It is a slug of the name: lowercase `[a-z0-9-]`, at most 32
   characters, `root` if nothing is left. If the slug is taken, `-2`, `-3` and so on are added.
   The id must not be any of these:
   - `local`, which is the hub itself;
   - `join`, which is a route segment;
   - the hub brain's own name (the `hub` it is handed), or that name in lower case. A root with
     the hub brain's name would be its own peer on both sides;
   - an id already in `roots.json`;
   - an id that **any** device allowlist in `devices.json` already names, v1 or v2. A
     reused id would let an old device reach a machine nobody approved for it.
2. **Mint 20 link tokens.** It runs `$BIFROST_NET_BIN rootlink mint --root <id> --dev
   <approving device id> --roots <id> --secret <root_link_secret>` once per token. It uses
   execFile with no shell and an env holding only `PATH`, and checks the output shape. Using
   the trunk's CLI means the capsule format can never drift from the bridge's opener.
   Minting comes first because it has no side effects.
3. **Create the root credential.** It is 32 hex characters. Only its sha256 goes into
   `roots.json`, in a record `{id, name, os, host, joined_at, dev, secretHash, delivered_at}`.
   **Pin the key:** with a `wg_pub`, the record also gets `wg_pub` and `wg_ip`, the next free
   address in the tree's range. The range is chosen once, at the first such approval (a random
   `10.x.y.0/24`), and kept in `roots.json` as `wg: {net}`. The hub's node is `.1`.
4. **Allow the approving device to reach the root.** It adds `root_id` to that device's
   `roots` in `devices.json`. It edits that one record in the raw file and writes every other
   record back exactly as it was read, v1 `tokenHash` records included. The write is atomic
   (rename) and goes through the same serialized chain as every other registry write.
   `lib/devices.ts` now keeps `roots` through every rewrite. Before this change, a token
   refresh silently dropped it.
5. **Hold the result for the poller.** `{root_secret, link_tokens, rootlink_url, peer_token,
   hub, wg?}` is kept **in memory only**. The first poll with the right secret takes it, and it
   is dropped from memory as it is sent. That poll also stamps `delivered_at`.

Approval does not touch the hub brain. The hub's WireGuard node re-reads `roots.json` every
second and lists the pinned roots on `GET /_wg`; a hub brain started with
`YGG_PEERS_FROM=http://127.0.0.1:<node http>/_wg` and `YGG_PEERS_VIA=http://127.0.0.1:<node
http>/_wg/{id}` adds it as a peer within about 5 s. It needs no restart and no edit to
`YGG_PEERS`. (Without a node, the bridge's `GET /_roots` still lists the linked roots.)

## Security choices

**Stored at rest (hashes only):**
- `roots.json` holds sha256(root credential) and metadata, mode 600, written atomically. It
  lives in `BIFROST_ROOTS_FILE`, by default `roots.json` next to `BIFROST_DEVICES_FILE`.
- `devices.json` gains only root ids.
- The join secret's hash is kept in memory.
- Raw link tokens and the raw root credential exist only in the hub's memory between
  approval and the one collection.
- The ladder checks: `roots.json` contains no raw secret or token and is mode 600.

**Expiry:**

| item | lifetime |
|---|---|
| join request | `BIFROST_JOIN_TTL_S`, default 600 s, from creation |
| approved, uncollected result | the same span counted from approval, then dropped (`undelivered`) |
| request records | kept 1 h after expiry so late polls get an honest 410, then forgotten (404) |
| link token | 6 h from mint (the trunk's `LINK_TOKEN_TTL`); single-use at the bridge |
| root credential | does not expire (see limits) |

**Rate limits** (in memory, per server process):

| what | key | default | env |
|---|---|---|---|
| join (1) | client address, IPv6 by /64 | 5 per 10 min (sliding window) | `BIFROST_JOIN_LIMIT`, `BIFROST_JOIN_WINDOW_S` |
| pending joins | the whole hub | 32 at once, then 503 | `BIFROST_JOIN_MAX_PENDING` |
| refill (5) | root id, counted only after the secret checks out | 6 per hour | `BIFROST_ROOT_REFILL_LIMIT`, `BIFROST_ROOT_REFILL_WINDOW_S` |
| 1 / 4 / 5 burst guard | client address | 60 burst, 1/s | `BIFROST_PAIR_BURST` |

A stranger who knows a root id cannot drain that root's refill budget, because only
authenticated refills count against it.

**Comparing credentials:** both secrets are 128-bit CSPRNG output. They are compared as
sha256 with `timingSafeEqual`.

**The code:** it is a comparison code, not a secret. Approve only a machine you can see,
and only when its code matches the phone's. A mismatch means you are looking at someone
else's request.

**The key:** the request carries the key, and nothing can change it after the POST. So
approving the code pins the key of that one request: a stranger's request has its own code.
The fingerprint is a second look at the same thing (48 bits: a check for the eye, not the
binding). The private key never leaves the machine (mode 600 in its state dir); the hub's
never leaves the hub's node.

**CSRF and framing:** approve and refuse are POSTs authenticated by a `SameSite=Strict`
cookie or a Bearer token. A cross-site form or a framed `/join` page carries no session.

## Configuring the hub

| env | meaning |
|---|---|
| `BIFROST_NET_BIN` | the bifrost-net binary (default `bifrost-net` on `PATH`) |
| `BIFROST_ROOTLINK_SECRET_FILE` | a file holding the bridge's `root_link_secret`; used first if set |
| `BIFROST_BRIDGE_CONFIG` | otherwise: the bridge's `bridge.toml`. The app reads its `root_link_secret` (one source of truth; the ladder uses this) |
| `BIFROST_ROOTLINK_URL` | what the machine dials, e.g. `wss://ap.example.org:4443/rootlink` |
| `YGG_PEER_TOKEN` | the hub brain's peer token. Handed out as `peer_token`; may be empty |
| `OPENCODE_URL` | the hub brain. Its `GET /root` `name` is handed out as `hub` |
| `YGG_ROOT_NAME` | the hub brain's name. It is used for `hub` only when the brain does not answer or gives no plain name (default `hub`) |
| `BIFROST_ROOTS_FILE` | the roots registry (default: `roots.json` next to `devices.json`) |
| `BIFROST_WG_PUB_FILE` | the hub's WireGuard node's public key (`<key file>.pub`, written by `bifrost-net wg-key`). Unset or unreadable: approvals pin the key but hand back no `wg`, and the machine gets no tunnel |
| `BIFROST_PUBLIC_URL` | base of `approve_url` and `poll_url`. It must be **https** wherever the poll crosses a network you do not own, because the poll carries the root credential |

The bridge must have:
- `root_link_secret` set;
- `[bridge.root-link] enabled = true`;
- `[bridge.root-link] wg_relay` and `wg_local` (the loopback UDP pair with the hub's node), for
  the tunnel to reach the hub; `plaintext_http = true` only while roots joined before the tunnel
  still need the old plaintext path;
- the same `tokens_file` as the app's `BIFROST_DEVICES_FILE`, because the bridge checks the
  token's `dev` claim against it.

The hub brain (yggdrasil) should have:
- with a WireGuard node (the tunnel): `YGG_PEERS_FROM=http://127.0.0.1:<node http>/_wg` and
  `YGG_PEERS_VIA=http://127.0.0.1:<node http>/_wg/{id}`. The node lists the pinned roots whose
  approver is live; the brain adds each, and calls it inside the tunnel;
- without one (old roots, `plaintext_http = true`): `YGG_PEERS_FROM=http://127.0.0.1:<bridge
  http>/_roots`. The bridge answers
  `[{"id","since"}]` for the roots linked right now, to loopback clients without browser or
  proxy headers, like `/_root/`. The brain reads the list every 5 s and adds a peer per linked
  root: the name is the root's id, and the url is `YGG_PEERS_VIA` with `{id}` replaced. The
  default is `<scheme://host:port of YGG_PEERS_FROM>/_root/{id}`, the switchboard. A static
  `YGG_PEERS` entry wins a name clash, and the brain never adds its own name. A root that
  unlinks stays known and shows as unreachable, like any peer that is down;
- the same `YGG_PEER_TOKEN` as the app.

## The tunnel (root ↔ root over WireGuard)

Every root runs one `bifrost-net wg -c NODE.toml`: boringtun (the WireGuard protocol) with a
userspace TCP stack (smoltcp) on top. No TUN device and no privileges: the tunnel addresses
exist only inside the node. It has two doors:
- the **front door**, loopback only: `ANY http://127.0.0.1:<http>/_wg/<root>/<path>` is one
  HTTP exchange with that root's brain, inside the tunnel (`local` = the hub). `GET /_wg` lists
  the peers `[{id, ip, fingerprint, up, handshakes, …}]`; `GET /_wg/_node` shows the node and
  what it dropped (`unknown_key`, `wrong_link`, `replay`, `auth_fail`, …). Browsers and proxied
  requests are refused, as on `/_root/`.
- the **in-tunnel door**, TCP port 80 on its tunnel address: a peer's exchange is performed
  against this root's own brain. Only `content-type` and `x-ygg-peer` cross, both ways.

The datagrams never touch the internet as UDP (the provider admits tcp 22/80/443 only). They
ride the root-link that exists already: one **relay frame** `[n][address][datagram]` per
binary ws frame on the dial-out wss. The address is the destination on the way to the relay
and the source on the way out, as the bridge saw it: the id of the authenticated link it came
in on, never what the sender claimed. The bridge relays root → root (under the link-token
`roots` claim, like the switchboard) and root ↔ the hub's own node (a loopback UDP pair,
`[bridge.root-link] wg_relay` / `wg_local`). It drops anything that is not a WireGuard-shaped
message. It holds no key and reads nothing.

**Who may talk:** a joined root has one peer, the hub (`local`), whose key came with its
approval. The hub's peers are the records in `roots.json` with `wg_pub` + `wg_ip`, not
`revoked`, whose approving device (`dev`) is live in `devices.json`. The hub's node re-reads both
every second: **revoking the approving device, or marking the root `revoked: true` (or deleting
it), cuts its tunnel at once**, both ways, even while its root link stays up. A datagram is
accepted only from the relay, only for a pinned key, and only when the relay's source is the
link that key is pinned to (a copied key on another link gets nothing); inner packets only from
the peer's own tunnel address. Replayed and tampered datagrams are dropped (WireGuard's counter
and AEAD). Sessions rekey on WireGuard's own timers (120 s).

**A joined root's node** (`NODE.toml`):

    [wg]
    key_file = "<state>/wg.key"          # mode 600; created with wg.key.pub if missing
    udp = "127.0.0.1:<B>"                # the dialer sends here
    relay = "127.0.0.1:<A>"              # the dialer's --wg-udp
    http = "127.0.0.1:<front door>"
    brain = "http://127.0.0.1:<its brain>"
    address = "<wg.ip>/<prefix of wg.net>"
    [[wg.peer]]
    id = "local"
    public_key = "<wg.public_key>"
    ip = "<wg.hub_ip>"

and its dialer adds `--wg-udp 127.0.0.1:<A> --wg-node 127.0.0.1:<B>` (trunk/scripts/root-dial.py).

**The hub's node:** the same, without `address` and `[[wg.peer]]`, with `roots_file` (the app's
`roots.json`) and `devices_file` (the app's `devices.json`); `udp` = the bridge's `wg_local`,
`relay` = the bridge's `wg_relay`, `brain` = the hub brain. Its key: `bifrost-net wg-key
<file>`; the app gets the public half (`<file>.pub`) through `BIFROST_WG_PUB_FILE`.

## Limits (known, not hidden)

- **The root link secret is in argv.** The mint CLI takes `--secret` as an argument, so the
  secret is visible in `/proc/<pid>/cmdline` for the few milliseconds each mint runs. On a
  shared machine, mount `/proc` with `hidepid=2`. The clean fix is a `--secret-file` flag on
  `bifrost-net rootlink mint`; this change leaves trunk/ untouched.
- **A restart loses joins in flight.** Pending joins and uncollected results live in memory.
  A restarted hub answers 404, and the machine runs join again. An approval collected by
  nobody leaves a root record with `delivered_at: null` that no one can use. The owner sees
  it in `GET /api/roots`.
- **No rotation or removal endpoint for roots in v1.** The root credential does not expire.
  To remove a root, delete it from `roots.json` (or set `"revoked": true` on its record, which
  cuts its tunnel within a second) and from the allowlists by hand. A WireGuard key is not
  rotated either: join again with a fresh key.
- **The tunnel covers root ↔ root brain calls only.** A phone turn naming a root (`/branch`,
  `root.job` ops) still rides the root link as text the bridge reads; that is the phone ↔ box
  leg. A joined root reaches the hub (and the hub any root); two joined roots do not reach each
  other yet: a joined root learns no other root's key (the link-token claim names only itself).
- **TCP inside TCP.** The datagrams ride the wss root link, so the tunnel's TCP runs inside the
  link's TCP. On a lossy path, retransmits stack; a direct UDP leg between roots is not built.
- **Link tokens hang on the approving device.** The tokens' `dev` claim is that device. If
  it is revoked (or the kill-switch is pulled), the bridge refuses new dials, refills answer
  409, and the machine must join again.
- **Single use resets on a bridge restart.** The bridge remembers spent tokens in memory
  (trunk/src/rootlink.rs). After a restart, a spent token can be replayed within its 6 h
  lifetime. Root links that are already up are not cut on revoke (trunk FINDINGS).
- **Without server.mjs, all clients share one limit.** Under plain `next start` there is no
  trustworthy peer address, so every joiner shares the `unknown` bucket: 5 joins per 10
  minutes for the whole hub, which fails closed. Behind your own reverse proxy, set
  `BIFROST_TRUST_PROXY=1`.
- **v1 records still turn into revoked v2 records.** A v1 record gains nothing from the join
  path and is not touched by it. Any ordinary registry write (pairing, refresh) still
  rewrites it as a revoked v2 record. That is v0.9 behaviour, unchanged, and its `roots`
  allowlist now survives the rewrite.
