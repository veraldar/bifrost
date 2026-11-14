# bifrost-net — M0 findings

**Mission**: de-risk spike for the sovereign access point (docs/vision.md,
bifrost-net). THE QUESTION: can a correctly-prompted AGI rebuild
tailscale+webrtc in Rust — one binary on a VPS, country chosen by the user —
from PROVEN crates only?

**M0 scope (small, per playbook)**: two local nodes mesh via boringtun
(WireGuard protocol) + str0m WebRTC echo relay. Not the product — the two
seams everything else hangs on.

**Date**: 10-03 · **Session**: BIFROST-NET-LAB · **Verdict: FEASIBLE — M0 GREEN (4/4) → M1 FULL BUILD GREEN (5/5)**

---

## M1 — the full build (same session, driver GO after M0)

One binary now exists: `bifrost-net serve -c config.toml` = private mesh +
WebRTC relay + HTTP signaling in one process, from one explicit config file.

```
$ ./m1-verify.sh
[PASS] S1 config: generated config VALID + livekit-scar warning present
[PASS] M0 regression: both seams still green
[PASS] S2 mesh: M1.1 PASS
[PASS] S3 relay: 39 A-frames relayed to B, 39 B-frames relayed to A
[PASS] S4 serve: one process, mesh+webrtc LIVE, signaling answering
M1 VERIFY: 5/5 PASS
```

- **S1 config+keys**: TOML config ([node]/[mesh]/[webrtc]) with LIVE bind-probe
  validation — it caught the real 7880 collision with this box's LiveKit on its
  first run. Empty candidates = loud warning (the scar made structural).
  `keygen` prints wg-style pairs.
- **S2 mesh service**: a userspace WireGuard *device* for N peers — routing
  mirrors boringtun's own device layer (identity via parse_handshake_anon for
  inits, receiver_idx>>8 for the rest), allowed-IP checked on inner SOURCE
  (virtual-IP spoof drops), endpoint learning (NAT roaming), keepalive timers,
  forced rekeys. Selftest: 2×200 packets + forced rekey + 2×200 more, in-order
  byte-verified, 25 garbage datagrams injected mid-stream — counters consistent,
  4/4 runs.
- **S3 relay service**: str0m SFU-lite — one shared UDP media socket,
  datagram-per-datagram demux, media forwarded to all-but-origin; signaling =
  HTTP POST /offer (tiny_http). Selftest drives the REAL signaling path: two
  clients, frames cross-relayed byte-exact, 6/6 runs.
- **S4 serve**: both halves + config report in one process; boot smoke verified
  (LIVE lines + signaling answering 400 on garbage offers).

### What the M1 build taught (Rule 10-02 evidence, would be invisible from APIs)

1. **boringtun's queue-flush is undocumented at the API surface**: after ANY
   WriteToNetwork result you must repeat `decapsulate` with an EMPTY datagram
   until Done, or pre-handshake queued packets never flush. Found because the
   M1 test's 200-packet wave never arrived; confirmed against boringtun's own
   device loop (`flush` flag). This is exactly the class of behavior only a
   life-respecting test catches.
2. **stats-based rekey detection is unreliable in 0.7** (handshake age never
   resets) — replaced with wire evidence: the rekey proof is B receiving a
   second HandshakeInit, not a timer reading.
3. **Shared-socket demux is where WebRTC servers actually break**: a
   per-client socket drain silently discards the OTHER peers' packets; the
   selftest flipped which peer connected per run (HashMap order), exposing it.
   chat.rs's demux-each-datagram pattern is the correct one.
4. **Config probes pay for themselves immediately** (port collision caught on
   first run).

### M1 honest limits
- Mesh inner traffic in serve mode is counted and dropped — no TUN/bridge
  routing yet (M2).
- Relay forwards single-audio-track peers; simulcast/BWE/NACK-chaos untested.
- No NAT traversal beyond host candidates (no STUN/TURN) — VPS public-IP
  pinning covers the flagship deployment; phone-on-cellular needs M2 work.
- Signaling is plain HTTP on purpose (LAN/tailnet); TLS is deployment config.
- No VPS run yet — needs the user's VPS choice (BLOCKED = VISIBLE: country +
  account are user decisions).

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

- **The scar in trunk/deploy/livekit.yaml**: LiveKit auto-detected docker-bridge
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

## A + B merged (trunk-merge, 2026-11-13)

Two lines of this crate had diverged since `f7a15ffb` (the real fork point;
`merge-base root-coord origin/main` reports `09d5e681`, but that commit is
already on line A, and root-coord's own merge `b14cc43c` kept B's side of every
shared file, which dropped A's `mod` lines and A's bridge changes):

- **A** (this `trunk/`): room relay, candidate hygiene (`cand.rs`), root-link
  dial-in (`rootlink.rs`, `roots.rs`, `registry.rs`, `ws.rs`), `POST /branch`,
  `rootlink mint`.
- **B** (root-coord `3b4792c9`): v0.9 pairing (persisted DTLS identity on
  `GET /identity`, region-checked `/offer`, revoke/kill/expiry severing live
  peers, in-band `auth.refresh`), the access point (`ap.rs`, `region.rs`), plus
  root-dial `--tls` from `0799aec2`.

They are now **one crate** with every module compiled (`mod ap, cand, region,
registry, rootlink, roots, ws` all present). Shared files were merged 3-way
(`git merge-file`, base `f7a15ffb`), keeping both behaviours:

| File | Resolution |
|---|---|
| `tokens.rs` | One reader for **both** schemas in one file: v1 (`tokenHash`, no expiry, no region, `roots` allowlist) and v2 (`killEpoch`, `access[{hash,exp,region}]`). `check(raw, region) → Grant{device, exp_ms, region, roots}`; `knows_dev` re-reads the file once on a miss (a device paired milliseconds before its root dials in). |
| `bridge.rs` | A's signaling (v2c candidate law, trickle, ws refusal, `/branch` pool, room relay, root turns) + B's identity/pin, region-checked grant at `/offer` **and** `/branch`, accountability sweep, `auth.refresh`, `severed` notices, JSON 401 `{why, reauth}`. Prompt runs off-worker and its return is `run.done {reply}` (B). The signaling loop honours `stop` again. |
| `config.rs` | Union: `[bridge]` root-link fields + `dtls_cert_file`, `public_url`; `[ap]` dial-out section. `deny_unknown_fields` kept; tests pin the installer's exact `bridge.toml`. |
| `main.rs`, `bridge_main.rs`, `opencode.rs`, `Cargo.*` | Both subcommand sets and dependency sets; B's `MessageInfo::role()` (top-level or nested `info.role`). |

**Subcommands:** `keygen` · `check -c` · `selftest m0|m1|v9|ap` · `serve -c` ·
`bridge -c` · `rootlink mint` · `ap -c` · `ap-token` · `ap-pin` · `ap-cert`.

**What each proof shows:**
- `selftest m0`: the WireGuard mesh (boringtun) rejects an impostor key, and str0m echoes WebRTC media byte-exact.
- `selftest m1`: the config-driven mesh with timers, rekey and stats, plus cross-forwarded WebRTC relay byte-exact.
- `selftest v9`:
  - **V9.2:** one DTLS identity, stable across restarts and published on `/identity` (the answer carries the pinned fingerprint).
  - **V9.2:** `/offer` answers 401 for a missing, invalid, wrong-region or expired credential.
  - **V9.2:** a v2 access token and a v1 `tokenHash` token both open the channel. hello, create, list and transcript work against a live opencode.
  - **V9.2:** `auth.refresh` with another device's token is refused.
  - **V9.2:** revoking a device (v2 or v1) mid-session gets the live peer `severed` in about 0.5 s. A kill-epoch bump severs everyone.
  - **V9.3:** Opus goes through speaches STT and TTS round-trip.
  - **Bug fixed here:** V9.2 used to write snake_case `token_hash`, which the camelCase reader rejected (`401 unknown or revoked device`).
- `selftest ap`: TLS edge plus a pinned dial-out channel. A wrong pairing token or pin is refused, and the `/api` gate covers 9 path-normalization bypasses. POSTs and websockets come through byte-exact.
- `scripts/rootlink-sim.py`: all 10 checks GREEN against this binary. They cover routing, single-use, takeover, the allowlist, reaping, wedged-root unlink, the in-flight cap, the mint CLI, the real root-dial exec leg, and the plaintext guard. T10 now exercises `--allow-plaintext` and `--tls`.
- `m0-verify.sh` 3/3; `m1-verify.sh` 5/5; `ap-verify.sh` 15/15 (run with `AP_UPSTREAM` = a stub, never the running app).

**How pairing identity and root-link fit:** one bridge process on `http`.
- **Port `http`** serves `GET /identity` (the QR pins it), `POST /offer` (the phone, DTLS-pinned) and `POST /branch` (harnesses).
- **Port `http`+1** is the root-link ws (loopback by default, `[bridge.root-link].listen`). It is off unless `enabled = true` and `root_link_secret` are both set.
- **`devices.json`** is shared. A device's `roots` allowlist rides its grant into the peer. Its `id` is what a link-token's `dev` claim must name.
- **The sweep** severs a revoked device's phone. New root links for that `dev` are refused.
- **The `[ap]` dial-out** reuses the same registry for its `/api` gate.

**Honest limits:**
- **v1 tokens never expire and are region-free** (A's contract). The v2 PWA treats v1 entries as revoked and re-pairs them, so the two writers must not share one file expecting different v1 semantics.
- **Root links already up are not cut on revoke.** Only new dials are refused.

## Roots through the trunk — the switchboard (trunk-switch, 2026-11-13)

Several yggdrasil roots (brains on different machines) now reach each other
through the trunk with **no tailnet and no inbound port on any root**: every
root dials out (to the root-link listener, or to the access point), and turns,
health and brain-to-brain HTTP all ride that one link.

**1. Root-link through the access point.** On the box, an ap stream for path
`/rootlink` (websocket upgrade) goes to the root-link listener instead of the
app upstream, without the `/api` device gate (the link token, first ws frame,
is the auth). A plain GET is 426; `/_root*` never crosses the edge (404).
`[ap] rootlink = "host:port"` overrides the target (default: the bridge's
root-link listener, unspecified bind → loopback; `"off"` = not routed).
The root dials `wss://<ap>/rootlink` (`--tls --path /rootlink`).
The root-link plane now reassembles frames across read timeouts
(`ws::FrameReader`, 8 MB max), keeps bytes sent right after the upgrade head,
caps conns still in the handshake/token phase at 64, and sets a 10 s write timeout.

**2. Turns on the root's own brain.** `root-dial.py --brain URL`: a `root.job`
runs on that brain, one session per device (the job body now carries `dev`,
from the grant on `/branch` or the peer on the data channel), titled
`trunk · <dev>`, found by title or created on first use, reused after; the reply
text rides `root.result` as `{"text","session","dev"}`. `transcript`,
`sessions` and `create` jobs are served too. With `--brain` the health pong is
earned by `GET <brain>/root` = 200. `--exec` (opencode run) remains the fallback.
`[bridge.root-link] result_secs` (default 20) is how long a turn waits for its root.

**3. The switchboard** (`src/switch.rs`). Two ops on the existing links:

    {op:"http", id, to, method, path, headers:{content-type?, x-ygg-peer?}, body_b64}
    {op:"http.reply", id, status, headers, body_b64}

| From | Endpoint / op | Goes to |
|---|---|---|
| hub brain | `ANY http://127.0.0.1:<bridge http>/_root/<id>/<path?query>` (loopback only; refused with Origin, Sec-Fetch-*, X-Forwarded-For, Forwarded or X-Real-IP) | `http` frame to root `<id>`, `from = local`; the reply's status/body/headers are the response |
| root X | `http` frame, `to = Y` (linked) | forwarded to Y as `{op:"http", id:<trunk id>, from:X, …}`; Y's `http.reply` goes back to X under X's id |
| root X | `http` frame, `to = local` | performed by the trunk against the bridge's `opencode_url` (the hub brain) |
| a joined root's brain | `ANY http://127.0.0.1:<P>/<target>/<path>` (root-dial `--peer-port P`) | `http` frame to `<target>` (`local` = the hub brain) |
| trunk → root | `http` frame | root-dial performs it against `--brain`, answers `http.reply` |

Laws: X may address Y only if X's link-token `roots` claim (kept in the
registry per conn) names Y or `*`; `local` is always allowed (as on `/branch`);
otherwise 403 `root 'X' may not address root 'Y' …`. Unlinked → 502, no answer
in 120 s → 504, the target's link dropping mid-call → 502 at once. A reply is
accepted only from the root the request was sent to. Only `content-type` and
`x-ygg-peer` cross, both ways (CR/LF refused). Methods GET POST PUT PATCH DELETE;
the path must start with `/`; bodies up to 4 MB. In-flight caps: 32 `/_root`
calls, 32 `local` performs.

**Wiring.** Hub brain: `YGG_PEERS mac=http://127.0.0.1:<bridge http>/_root/mac`.
Joined root's brain: `YGG_PEERS home=http://127.0.0.1:<P>/local`. Both use the
same `YGG_PEER_TOKEN` (sent as `x-ygg-peer`, which the switchboard passes).
Since roots-learn the hub brain can have `YGG_PEERS_FROM` instead of the
hand-written line, and the join hands the joined root the name `home` (see the
last section).

**root-dial.py flags (new):** `--brain URL`, `--peer-port P`, `--cafile PEM`
(trust a test CA or self-signed cert with `--tls`). `--path` already existed.

**Proofs:**
- `cargo test`: 34/34.
- `selftest m0 m1 v9 ap`: GREEN. v9 ran against a scratch yggdrasil brain on the mock (`OPENCODE_URL`). `ap` adds: `/rootlink` reaches the root-link listener with no device token, a plain GET is 426, and `/_root` is 404 at the edge.
- `scripts/rootlink-sim.py`: **14/14**. T1–T10 are unchanged. The new legs:
  - **T11:** `--brain` keeps one session per device, and pongs are earned by `GET /root`.
  - **T12:** hub→root, root→hub (`local`) and root→root work. Only the two headers cross. Status passes through, a 320 KB body arrives byte-exact, and 8 concurrent calls work. A browser `Origin` gets 403.
  - **T13:** a claim that excludes the target gets 403. `local` is allowed, and addressing yourself is 400.
  - **T14:** the root dials through the ap (self-signed test cert, `--cafile`) and a turn plus a switchboard call cross the edge. Without the CA the dial is refused.
- `sim/trunk-roots-e2e.py`: GREEN through the ap, and with `--direct`. It runs two real yggdrasil brains on the mock:
  - MAIN on home runs `session_start … root=mac`. The session runs on the mac brain, and its report comes home: home's `/tree` shows the proxy on root mac as done (MAC-DONE), and MAIN's inbox has it.
  - A `/branch` turn naming mac is answered by the mac brain, which reuses one session per device.

**Honest limits:**
- **Link tokens are still single-use with a 6 h TTL from minting.** A joined root that has to reconnect more than 6 h after its tokens were minted needs fresh ones from the hub. The trunk does not renew tokens in-band yet. That is the next gap for a root that stays joined for days. Every reconnect burns a token, and that includes each restart or blip of the bridge↔ap channel, because the root's stream rides it.
- The conn loop keeps its 2 s read tick. A queued `root.job` can wait up to 2 s; switchboard frames are written directly and do not wait. A 250 ms tick turned rootlink-sim T5's drained-turn answer into a "health probe failed" answer, so the tick stayed.
- root-dial reads and writes one TLS socket from several threads, as `--tls` already did.
- The data-channel path carries `dev` the same way, but only `/branch` is exercised here.

## The whole tree with a simulated phone (trunk-full, 2026-11-13)

`sim/trunk-full-e2e.sh` (+ `branch/e2e/trunk-full.spec.ts`, `sim/trunk-full-joiner.py`) runs
the hub box, an access point on a fake public address (`ap.tree.test`, self-signed cert),
and a new machine on another address, all in private namespaces (user, net, mount, pid),
deterministically on the mock. The phone (Chromium, Pixel 7) only ever talks to the ap; the
run asserts that from every request and websocket it made. Steps: pair by QR · MAIN answers
· join by QR (the phone approves, the machine collects its tokens and links through
`wss://ap/rootlink`) · MAIN delegates to the joined root and the report comes home · the
phone names the root itself (`/branch`) · revoke from the console → refused.

**Two bugs it found, fixed in `ap.rs`:**
- **A new machine could not join through the access point.** The edge's `/api` gate
  refused `POST /api/roots/join` (and the poll and the refill) with 401 `missing`, because
  only `/api/pair` was exempt. The join contract's three own-credential calls now pass the
  edge with the same exact method and path shapes the app's middleware exempts. The match
  is on the raw path, so anything encoded or dotted is still gated (`selftest ap` checks
  3 passes and 9 neighbours refused).
- **A phone could not name a root from outside the LAN.** `/branch` lives on the bridge,
  and the ap sent everything except `/rootlink` and `/rtc` to the app, which answered 404.
  The dial-out now hands `/branch` streams to the bridge's own listener. They come from
  this host, so the client's address rides X-Forwarded-For next to `X-Bifrost-Edge`, a
  per-process secret only the dial-out stamps. `/branch` then checks the device token in the
  region of the phone's real address (the check is shared with `/offer`, which the edge
  still does not route). Without the key, a request keeps its socket's region. A wrong key
  means no region (fail closed). A client-sent `X-Bifrost-Edge` is dropped at the edge.

**Still by hand (named, not hidden):**
- ~~**The hub brain does not learn a joined root.**~~ Closed by roots-learn (below).
- **The app has no screen for naming a root.** The phone's `/branch` call is the page's
  own `fetch`, with the token from `/api/pair/refresh`. The `/bridge` page's data channel
  cannot cross the ap: `/offer` and media are not tunneled.
- ~~**The joined root's peer name must equal the hub brain's `YGG_ROOT_NAME`.**~~ Closed by
  roots-learn (below).

## The tree learns its roots (roots-learn, 2026-11-13)

Two gaps from trunk-full are closed. With them, a join needs no operator step on either side.

**1. The hub brain learns joined roots by itself.**
- **Bridge:** `GET http://127.0.0.1:<bridge http>/_roots` answers `[{"id","since"}]`. That is
  the roots linked right now, sorted by id, with `since` = the unix ms the current link came
  up. It has the same guards as `/_root/`: loopback only, refused with Origin, Sec-Fetch-*,
  X-Forwarded-For, Forwarded or X-Real-IP, and no websocket. Other methods get 405. The ap
  answers 404 for `/_roots` at the edge, as it does for `/_root`.
- **Brain** (`root/src/peers.rs`): `YGG_PEERS_FROM=<that url>` and an optional
  `YGG_PEERS_VIA=<url with {id}>`. The default for `YGG_PEERS_VIA` is
  `<scheme://host:port of FROM>/_root/{id}`. The watch loop reads the list every 5 s and adds a
  peer per linked root, named by its id. It reads each peer's `/root` at once, then every 60 s,
  or every 15 s while the peer has never answered.
- **Rules:** a static `YGG_PEERS` entry wins a name clash, and the brain never adds its own
  name. A root that unlinks stays known and shows as unreachable after 3 minutes, like any
  peer that is down.
- **Unknown roots:** a call that names a root the brain does not know yet (`session_start …
  root=<id>` right after the link) reads the list once before it fails.
- **[roots] view, `GET /root` `peers`, `session_start`, report delivery:** all of these treat a
  learned peer exactly like a static one.
- **A fix found on the way:** a peer call refreshed the [roots] view's "seen" time on any answer.
  Through the switchboard, an unlinked root answers 502 from the trunk, so a root that was gone
  stayed "reachable" with its old summary forever. Now 502, 503 and 504 prove nothing.

**2. The joined root uses the hub brain's real name for its way home.** The join's approval
`hub` is now the hub brain's root name. The app asks `GET <OPENCODE_URL>/root` and reads
`name`. Failing that it uses `YGG_ROOT_NAME`, and then `"hub"`. That name is also never given
out as a root id. `rootjoin.py` checks the name like a root id, refuses one equal to its own
`root_id`, keeps it in `root.json` as `hub_name`, and writes
`YGG_PEERS <hub>=http://127.0.0.1:<peer port>/local`. A `root.json` from an older join, or an
older hub that sends no name (or `"local"`), keeps the name `hub`. See docs/spec-join.md.

**Proofs:**
- `sim/trunk-full-e2e.sh` has no operator step any more. The hub brain starts once with
  `YGG_PEERS_FROM` and no `YGG_PEERS`. Step 4a checks four things: `/_roots` lists `mac`; the
  brain's `/root` `peers` becomes `[mac]` by itself; its log says `learned root mac`; and its
  pid never changed. The joiner reads `hub: "home"` from the answer, and its brain's only peer
  is `home`.
- `rootlink-sim` T12 checks `/_roots`: it lists the linked roots, refuses a browser (403) and a
  proxied request (403), and answers POST with 405. `selftest ap` checks that `/_roots`,
  `/_roots?x=1` and `/%5froots` are 404 at the edge.
- `join-test` checks the following:
  - the hub's name reaches `brain.env`;
  - the live brain's `peers` is `[home-box]`;
  - an older hub, with no name, gets the peer `hub`;
  - a bad name is refused with exit 1.

## Your own trunk, for a lay user (trunk-install, 2026-11-13)

Two installers make the trunk a thing a non-expert can run (`docs/own-trunk.md`):
`trunk/install/trunk.sh` on a rented server (Debian 12+ / Ubuntu 22.04+), and
`root/install/install.sh --trunk '<the line it prints>'` on the home computer, then
`install.sh pair` for the phone's QR. `trunk/deploy/sni-443.py` shares :443 with a website.

**What the server side does:** the release binary (SHA256SUMS checked) or `--binary`; the ap's
P-256 key made once (600, root); a Let's Encrypt certificate made from that key (`certbot --csr`:
HTTP-01 standalone when :80 is free, `--webroot` through nginx/caddy/apache otherwise, with the
snippet printed), renewed by a daily timer when a third of its life is left; :443 directly, or
`--behind-proxy` on `127.0.0.1:4443` with `proxy_protocol = true`; ufw opened when active; the
hub's token minted with `ap-token`, only its SHA-256 kept, the token shown once in the connect
line `wss://NAME/ap#pin=AA:…,token=…`. Re-runs keep the key (the pin) and the token.

**What the home side does with the line:** `[ap]` url/pin/token/upstream + `[bridge.root-link]` +
`root_link_secret` + `opencode_url` in `bridge.toml`; the app in devices mode on **127.0.0.1 only**
with `BIFROST_TRUST_PROXY=1`, `BIFROST_PUBLIC_URL=https://NAME`, the join env and
`BIFROST_MAIN_TITLE=[MAIN]`; the brain's `YGG_ROOT_NAME`, `YGG_PEER_TOKEN`, `YGG_PEERS_FROM`.
A health line proves the whole way in: `trunk https://NAME/pair → 200`, with curl pinning the key.

**Found on the way (each would have stopped a real user):**
- **`LoadCredential=` is unreadable on Debian 12 (systemd 252) in a container.** The credentials
  directory stays `root 0700` with no ACL for the service's user, static or dynamic, so the ap
  died with `Permission denied`. Container-based VPSes (LXC, OpenVZ) are common at the cheap end.
  The unit now hands the key over itself: a root-run `ExecStartPre=+` copies it into the
  service's private `RuntimeDirectory` (tmpfs, 0700, owned by the dynamic user, gone on stop).
  The key on disk stays root-only.
- **`. /etc/os-release` overwrites `NAME` and `VERSION`.** Sourced in the script, Debian's
  `VERSION="12 (bookworm)"` became the release to download. It is read in a subshell now.
- **ufw refuses a rule whose comment has an apostrophe** ("Let's Encrypt"), so :80 stayed closed
  and Let's Encrypt timed out. The comment has none now, and a refused rule is reported.
- **A token minted by a run that then failed was never shown**, but the next run said "token
  kept". A marker now makes the next run mint and show a new one.
- **The installed app could not delegate:** the phone landed on a session titled `main`, which the
  brain runs as `build`. Only `[MAIN]` gets the coordinator. Trunk mode sets
  `BIFROST_MAIN_TITLE=[MAIN]`. Plain LAN installs are unchanged and still get `main`; that is a
  known gap.
- **install.sh pointed the app and agent units at `pwa/` and `agent/`**, the folders from before
  the rename. The app now runs from `branch/` and the agent from `branch/voice/`.
- **Behind a :443 router the ap must get PROXY v1.** Without it every phone would arrive from the
  VPS's loopback, which the hub reads as its own console. `--behind-proxy` always sets
  `proxy_protocol = true`, so a router that sends no PROXY line fails closed. The simulation
  checks that the region the hub binds is the phone's real address.

**Proof:** `sim/own-trunk-e2e.sh` (docker: fresh Debian 12 servers with systemd as PID 1, Pebble as
the ACME server, a Debian 12 + Node 24 home computer, an Ubuntu 24.04 joiner, Chromium as the
phone) and `trunk/deploy/sni-443-test.py`.

**Not proven:** real Let's Encrypt (Pebble speaks the same ACME, but the run never leaves docker),
a real VPS provider's firewall and DNS, IPv6 end to end, voice over the trunk (not wired).
