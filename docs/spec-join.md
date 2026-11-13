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
| 1 | `POST /api/roots/join` `{name, os, host}` | none; rate-limited per client address | `201 {req, secret, code, approve_url, poll_url, expires_in}` |
| 2 | `GET /join?r=<req>` (page) | a paired device. Without one, the page sends you to `/pair?unpaired=1` | name, os, host, the code; **Add to my tree** / **Refuse** |
| 3a | `POST /api/roots/join/<req>/approve` | a paired device | `200 {status:"approved", root_id, name, os, host}` |
| 3b | `POST /api/roots/join/<req>/refuse` | a paired device | `200 {status:"refused"}` |
| 4 | `GET /api/roots/join/<req>`, header `x-join-secret` | the join secret | `202 {status:"pending"}`, `200 {status:"approved", root_id, root_secret, link_tokens[20], rootlink_url, peer_token, hub}` exactly once, or `410 {status:"refused"\|"expired"}` |
| 5 | `POST /api/roots/<root_id>/tokens`, header `x-root-secret` | the root credential | `200 {link_tokens[20]}` |
| 6 | `GET /api/roots` | a paired device | `{roots:[{id, name, os, host, joined_at, delivered_at}]}` |
| – | `GET /api/roots/join/<req>/view` | a paired device | the page's data: `{req, name, os, host, code, status, expires_at, root_id}`. Has no secrets |

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
4. **Allow the approving device to reach the root.** It adds `root_id` to that device's
   `roots` in `devices.json`. It edits that one record in the raw file and writes every other
   record back exactly as it was read, v1 `tokenHash` records included. The write is atomic
   (rename) and goes through the same serialized chain as every other registry write.
   `lib/devices.ts` now keeps `roots` through every rewrite. Before this change, a token
   refresh silently dropped it.
5. **Hold the result for the poller.** `{root_secret, link_tokens, rootlink_url, peer_token,
   hub}` is kept **in memory only**. The first poll with the right secret takes it, and it
   is dropped from memory as it is sent. That poll also stamps `delivered_at`.

Approval does not touch the hub brain. Once the new root links, the bridge lists it on
`GET /_roots`, and a hub brain started with `YGG_PEERS_FROM` adds it as a peer within about
5 s. It needs no restart and no edit to `YGG_PEERS`.

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
| `BIFROST_PUBLIC_URL` | base of `approve_url` and `poll_url`. It must be **https** wherever the poll crosses a network you do not own, because the poll carries the root credential |

The bridge must have:
- `root_link_secret` set;
- `[bridge.root-link] enabled = true`;
- the same `tokens_file` as the app's `BIFROST_DEVICES_FILE`, because the bridge checks the
  token's `dev` claim against it.

The hub brain (yggdrasil) should have:
- `YGG_PEERS_FROM=http://127.0.0.1:<bridge http>/_roots`. The bridge answers
  `[{"id","since"}]` for the roots linked right now, to loopback clients without browser or
  proxy headers, like `/_root/`. The brain reads the list every 5 s and adds a peer per linked
  root: the name is the root's id, and the url is `YGG_PEERS_VIA` with `{id}` replaced. The
  default is `<scheme://host:port of YGG_PEERS_FROM>/_root/{id}`, the switchboard. A static
  `YGG_PEERS` entry wins a name clash, and the brain never adds its own name. A root that
  unlinks stays known and shows as unreachable, like any peer that is down;
- the same `YGG_PEER_TOKEN` as the app.

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
  To remove a root, delete it from `roots.json` and from the allowlists by hand.
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
