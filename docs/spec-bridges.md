# spec-bridges — one phone, every tree, one list (v0.8/v0.9 federation lane)

*REVIEW session, 10-04. Implements AGI review Part 13 Stage 1: client-side
fan-out over a static bridge list. Peer #1 = Mac Studio (its bifrost runs
today — dogfooding, zero new installs); peer #2 = TV-PC (the couch demo).
Feeds BIFROST-NET-V09's S1 work: the device token minted at /pair IS the
bridge credential.*

## Model

The PWA holds a **bridge list**. A bridge:

```
{ id, name, base_url, deviceToken, glyph, accent }
```

- `base_url` = that tree's own Next proxy (e.g. `https://studio.tail…ts.net`)
- `deviceToken` = minted by THAT tree's `/api/pair` (S1) — one per tree
- Self-bridge (the instance serving the PWA) is bridge #0, implicit.

## Transport (per Part 15 GO-WITH-CHANGES)

- App semantics stay **HTTP(S)**: the PWA fetches each bridge's `/api/*`
  directly with its bearer token. Peer proxies set
  `Access-Control-Allow-Origin` = the home origin (allowlist, tailnet-only
  hosts) and `Access-Control-Allow-Headers: authorization`.
- Voice: the **owning tree hosts the room** — the phone joins that tree's
  LiveKit with a token minted by that tree (`/api/token` already mints
  per-room). No audio relay, ever.
- The tailnet is the network layer at this stage; the no-tailscale swap
  (v0.9) changes the transport UNDER this spec, not the model.

## List merge

- `GET /api/session` on every bridge, in parallel, per bridge timeout **2s**.
- Sessions render under a tree chip (glyph + name). Unreachable bridge =
  **grey chip, one-line reason** ("studio: asleep") — never a spinner, never
  a hang. Failures are per-bridge; one tree down never blanks the list.
- Create/delete/message route to the bridge that owns the session id:
  session ids are `tree/slug` (v0.8 namespacing — REQUIRED before merge:
  LiveKit rooms, JWT identity and opencode slugs all collide on bare slugs).

## Doors (Part 12/14 integration)

- First-run on a NEW bridge = the tree (door) fills the screen; the vocal
  welcome runs against that tree's agent; its first session is that tree's
  `MAIN` (reserved slug, never swipe-deleted). The existing sandbox lane
  (yggdrasil-sandbox) builds this for one tree; bridges is that, ×N.
- Pairing a new bridge = scan that tree's QR (its /pair) → token stored →
  tree appears in the list. No restart, no settings wizard.

## Non-goals (v1 of bridges)

No peer discovery; no server-to-server anything; no cross-tree actions
(move session, unified search); no shared presence. Two same-owner static
peers make discovery a complication without a customer (Part 13).

## Tests (the referee)

1. unit: bridge store (add/remove/persist), id namespacing.
2. e2e (fake second bridge: a static JSON /api/session stub behind the dev
   server): merged list renders both chips; stub times out → grey chip +
   reason, self-bridge unaffected; sending to a stub session 401s cleanly
   when its token is revoked.
3. e2e (live, post-S1): pair the Studio for real → its sessions appear;
   voice round-trip on a Studio session lands in the Studio's transcript.
4. revocation: revoking the Studio token on the Studio greys the chip with
   "token revoked — re-pair", never a 401 wall of errors.

## Effort

5–8d after S1 middleware lands (it is the credential). The Studio is peer #1
with zero new installs; the TV-PC recipe rides the same code.
