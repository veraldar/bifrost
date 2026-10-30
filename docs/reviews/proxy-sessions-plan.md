# [LAB] proxy-sessions — review, design, simulation plan

**Status line: `proxy-sessions done review+design+simplan 2026-10-30`**
Session: PROXY-SESSIONS (design only, no build, no live-service changes — honored: only read-only
probes of :4096/:4100 and the ro-mode sqlite were made; see appendix A for the probe log).

Owner's verbatim intent: *"sessions should live in only ONE place. We should not copy-paste them
between roots; we should PROXY them."*

---

## 0 · Ground truth measured today (not assumed)

Probed 10-30, read-only:

| fact | value | source |
|---|---|---|
| sessions on the legacy opencode store (:4096) | 249 | API list + ro sqlite |
| sessions titled `[LAB]` on :4096 | **16** (voice, hardwar, Veraldar, yggdrasil, bifrost-net, worldtree-data, silicon, ask-agi errors, research-feed, ygg-sim, net-research, mini-agi, mini agi, agi-metrics, bifrost android-lab, japan-booking) | sqlite ro |
| `[V06]` copies in the root store (:4100) | **221 / 221 present, all `archived:true`**, deterministic ids (`ses_`+sha256(`v06-import:v1:`+old_id)[:32]) | API + store files |
| `[LAB]` sessions with a frozen twin already in the root store | **all 16** | store files |
| `[LAB]` sessions still written on :4096 since the import (10-28 15:57) | **exactly one: `[LAB] Veraldar`** (upd 10-29 21:33; ~2,350 messages live vs the 10-28 twin — divergence is real, not hypothetical). Everything else: voice 10-22, the rest ≤ 10-08. (The only other 10-29 writes on :4096 are `e2e-subs-*` junk from the v0.6 ring's own e2e.) | sqlite ro |
| MAIN (`ses_770b…30c`) | exists **only** in the :4100 store (318 msgs), never on :4096 — already single-homed | store + sqlite |
| relay client basis | harness-bench adapters for BOTH harnesses are proven against live services (`lab/harness-bench/adapters/opencode.py`, `yggdrasil.py`): POST /session, blocking POST /session/:id/message + global `/event` SSE (oc), per-request SSE (ygg) | `lab/harness-bench/` |
| root contract clause in tension | §2: the root *"never calls out; it never waits on anything but its own run"*; the dispatcher/relay is ruled EXTENSION ("do NOT land in root") | `docs/reviews/root-contract.md` |

The owner's complaint is already instantiated: `[LAB] Veraldar` has dual existence with live drift.
This is the case that proves the law, and it is one session away from being every lab.

---

## 1 · REVIEW — steel-man, then attack

### 1a. Benefits (why the owner is right)

1. **Single source of truth.** Today a continuation of `[LAB] Veraldar` from the phone writes to
   :4096, while the :4100 twin freezes into a lie. Under proxying, every write lands on the home
   root; the new root shows the same conversation with a badge. Divergence becomes impossible by
   construction rather than by discipline.
2. **Old roots stay authoritative AND usable.** This is the subtle one the owner got right: proxy
   is not deprecation. The v0.6 ring stays the emergency door (three-rings law, 10-29); a lab homed
   there keeps its history, its model routing, its provider config. Nothing is migrated to be
   "brought along"; it is *reached*.
3. **Live labs keep their home.** `[LAB] voice`, `[LAB] hardwar` and friends continue exactly where
   their tooling, transcripts and muscle memory live. The phone gains a window, not a takeover.
4. **Parallel routes as intended resilience.** The owner used :4096 as live fallback during the
   quota outage. Proxying makes that pattern first-class: several roots, one visible surface, and
   the fallback story becomes a routing fact instead of a copy ritual.
5. **Contract-shaped cheapness.** No store ETL ever again. v06-import was 221 sessions of careful
   one-way translation with verification machinery; proxying replaces the *class* of problem with
   one relay and a badge.

### 1b. Costs (attack honestly)

1. **Availability coupling — the big one.** A proxy turn needs the route up. Remote down = proxy
   degraded. This must be VISIBLE, never silent: reuse the provider-wave error-turn + banner work
   (the root already stores failure in `info.error` of an empty assistant message; the PWA banner
   renders it). For proxies the relay writes the same-shaped error turn into the handle with
   `info.error = {kind:"proxy.unreachable", route, since}` — the existing banner path renders it
   unchanged. Kill-the-remote-mid-turn is a mandatory sim scenario (§4).
2. **Contract tension (must be resolved, not papered over).** The mission's literal design —
   `POST /session {proxy:…}` in the root, messages relayed by the root — makes the root call out,
   which §2 of the root contract forbids ("never calls out"), and the same contract rules the
   dispatcher/relay an EXTENSION. Two honest resolutions: (A) the owner amends the contract for a
   `proxy` session kind; or (B) the relay lives as an extension sidecar and the root changes only
   by a guard. This plan recommends B (§2) and sizes both; the owner picks.
3. **Auth between roots.** v1 needs none: both roots are loopback-only, one trust domain, relay
   binds loopback. The door stays open: when a route leaves the box (Mac, VPS ring), the relay
   speaks the device-token scheme already planned for the v0.8 bridge. Explicit non-goal for v1.
4. **Latency.** One extra loopback hop plus the remote's own run. Measured baselines say upstream
   dominates (ygg-vs-oc: TTFB p50 4.2–4.7 s, upstream-bound); the relay is expected to add
   ≲100 ms. Sim must produce the number, not the hope (§4 metrics).
5. **Compaction / history semantics across roots.** The home root compacts (rollup) — correct,
   it owns context. The handle must never locally compact its mirror (that would manufacture a
   second truth); the guard that refuses local runs on proxy handles also skips them in rollup
   (same one-line check). A remote compaction is just a new message/part the mirror picks up on
   next sync — sim scenario §4.5.
6. **Turns to read-only / archived proxies.** opencode archives are still postable-to (unknown →
   sim verifies); if the home says archived, the relay refuses with an honest error turn: "archived
   on its home (:4096)". The escape hatch is explicit: **emigrate** = materialize a NEW local
   session seeded from the remote transcript (a user-initiated, one-way, provenance-stamped copy —
   `info.emigratedFrom`). Emigrate is the only sanctioned way a proxy becomes local; it is an
   event, not a drift.
7. **List-view weight.** The list must show provenance (badge "proxy · route :4096") from handle
   metadata alone — never per-row remote calls (16 routes × list render = latency soup). Freshness
   lives on the session page, not the list row.
8. **A second moving part.** The relay is a service that can itself be down. Mitigation: the root's
   guard 409s with a pointer when the relay is unreachable → the same visible banner; and the
   read-cache (§2) means *browsing* never depends on the relay, only turns do.

### 1c. Verdict

The idea survives attack. The one real fight is placement (contract tension) and the one real risk
is silent degradation — both addressed head-on: extension relay (or owner-amended contract) and
error-turn/banner reuse with a kill-test as a build gate.

---

## 2 · DESIGN

### 2a. The single-home LAW (words to land in the contract)

> A session has exactly **one home root** — the only root where its writes land. Every other root
> may hold at most an **appearance**: a *proxy* (live read/write, relayed) or an *archive*
> (frozen, read-only, explicitly inert — e.g. `[V06]` copies of closed history and the
> read-frozen originals left on the legacy store, which cannot be deleted by law).
> Two appearances of one session may never both accept writes. Violations are detectable by
> machine (the single-home audit, §2f).

This wording is what makes [V06] legal without deleting history: the law is about **write
authority**, and archives are inert by construction.

### 2b. The handle (minimal root change)

A proxy handle is a normal store file (`session/<id>.json`) in the consuming root's store with:

```json
{
  "title": "[LAB] voice",
  "archived": false,
  "info": {
    "proxy": {
      "route": "opencode:127.0.0.1:4096",
      "remoteSessionId": "ses_f08027176ffe…",
      "dialect": "opencode",
      "cache": "read",
      "syncedAt": 1798…,
      "remoteUpdatedAt": 1798…,
      "state": "fresh | stale | unreachable"
    }
  },
  "messages": [ …mirrored transcript… ]
}
```

- **Minting writes the file directly** (the v06-import pattern: store files are the interface;
  no root code involved). The mission's `POST /session {proxy:…}` shape is kept as *sugar the root
  may accept later*; it is not on the critical path.
- **The only root change (S): one guard branch** — a session with `info.proxy` set is not the
  root's to run or compact: `POST /message` → `409 {proxy:true, route, relay}` pointer;
  `rollup` skips it. That is a refusal, not a feature: the root still never calls out, and a
  direct post can never fork the session into two write targets. Contract-test + drift-guard rows
  added with it.
- Handles carry NO `parentID`, no MAIN significance, and deletion of a handle never touches the
  remote (single-home: the remote is the home).

### 2c. The relay — `ygg-relay` (extension, M)

A small loopback sidecar in the ygg-driver family (the same seam the contract already reserves for
the v0.7.x dispatcher), client logic lifted from the proven harness-bench adapters:

- `POST /session/:id/message` (root-shaped) → per-handle mutex (one run per session) → remote post
  (opencode dialect: blocking POST + global `/event` bus for deltas; yggdrasil dialect: per-request
  SSE) → **mirror the resulting messages into the handle** → re-emit the root event vocabulary on
  the relay's own `/event`.
- Turn timeout / connection refused → error turn written to the handle (`proxy.unreachable`),
  VISIBLE by construction (banner reuses `info.error` shape).
- Read-only/archived remote → refusal error turn (§1b-6). `DELETE /session/:id` on a relay front =
  handle only.
- Read-cache — **decided: mirror-on-write + refresh-on-open, cache is disposable** (the mission's
  "cache nothing OR read-cache" question):
  - Writes are relayed, never local — write authority stays singular.
  - Reads: the transcript lives in the handle (mirror) and is refreshed from the home on open and
    after each turn; `state: fresh|stale|unreachable` from `remoteUpdatedAt` vs `syncedAt`.
  - Why not cache-nothing: browsing would couple to remote uptime — the owner who used :4096 as an
    outage fallback wants old labs *readable* during an outage. Stale-and-visible beats dead.
  - Why it is not "copy-paste again": the mirror is derived, disposable, rebuildable, and
    authoritative-writes never touch it. The cache is a rendering, not a home.
- Placement alternatives sized:
  - **B — extension relay (recommended):** contract-clean, no live-brain deploys, adapters reused
    as-is (Python). Root change = the S guard only.
  - **A — in-root proxy (the mission's literal shape):** fewer moving parts, one endpoint for all
    clients, relay logic in Rust next to `provider.rs` (which already relays two upstream
    dialects). Requires the owner to amend §2 ("never calls out"). If he does, A is legitimate and
    S/M-sized; the relay library should be written B-first so A can absorb it later.

### 2d. Clients

- **PWA/trunk:** badge on list + session header: `proxy · route :4096` (+ stale/unreachable tint);
  error banner reuses the provider-banner component; turns post to the root, get the 409 pointer,
  follow it to the relay (one hop, trunk-side — the phone never learns addresses, seam law holds).
- **Voice agent:** same pointer-retry on 409 (one code path); room slug = title slug, unchanged.
- **e2e:** contract tests — guard refuses proxy posts; badge renders; banner renders on refused
  relay; single-home audit green.

### 2e. Provenance visibility

`GET /session` already returns stored `info` (v06 twins prove `archived` round-trips); the PWA
reads `info.proxy` for badge + freshness. List rows render from handle metadata only (§1b-7).

### 2f. Enforcement — the single-home audit (S, one-shot script)

Walk both stores; classify every session: home / proxy / archive / **VIOLATION** (two writable
appearances, or a writable twin of a proxied session). Output: a table + exit code; becomes a
drift-guard-style tripwire so dual-existence can never regrow silently. This is the instrument
that would have caught [LAB] Veraldar's drift the day it happened.

### 2g. Sizing

| slice | size | content |
|---|---|---|
| P1 | **S** | contract law text + root guard (refuse run & rollup on `info.proxy`) + contract-test + drift-guard rows |
| P2 | **S** | single-home audit script + its first run (feeds §3 verdicts with data) |
| P3 | **M** | `ygg-relay` (both dialects, mirror, error turns, per-handle mutex, own /event) + handle minting tool |
| P4 | **M** | trunk pointer-follow + PWA badge/banner/freshness + voice pointer-retry + e2e |
| P5 | **L** | sim suite (§4) + compaction-across-relay verification + multi-route table (≥2 remotes) |

### 2h. Out of scope (explicit, v1)

- Any write to :4096 beyond adapter-created-and-deleted `[RUN]` scratch sessions (the import's
  read-only discipline stays the default for the legacy store).
- Deleting anything on the legacy store (read-frozen originals stay as inert archives — the law
  permits them as archives, not homes).
- Cross-root search, root-to-root event fan-out/federation, cross-root MAIN.
- Auth between roots (loopback trust domain v1; device-token story rides v0.8).
- Proxying between two yggdrasil roots as a product path (works mechanically — the relay speaks
  both dialects — but productized later; the route table keeps the door open).
- Write-through caches, speculative prefetch, offline queues.
- The third ring (:8443) consuming proxies (later; nothing in the design blocks it).

---

## 3 · THE [V06] QUESTION — 221 copies

| option | what it means | migration cost | attack |
|---|---|---|---|
| **(a) keep all copies as frozen archive, proxy nothing** | 0 work today; labs continue only on :4096; phone UI shows frozen twins that lie the moment :4096 moves | zero | keeps exactly the dual-existence the owner hates; `[LAB] Veraldar` already diverged; phone turns on a `[LAB]` write to the frozen twin → a THIRD copy is born |
| **(b) retire all copies, proxy all originals** | purest reading of the law; delete 221 twins, mint 221 proxies | every history read now needs :4096 up; churn 221 handles for 205 sessions nobody has written in ≥3 weeks; if :4096 ever mothballs, history becomes unreachable | negative value for closed history |
| **(c) hybrid — closed history stays copied; anything still written becomes proxy** (recommended) | criterion is **write authority**, measured not guessed: sessions written on :4096 after import (or owner-flagged) = live → proxy original + delete that twin; the rest = closed history → `[V06]` copy becomes the inert home (archive), original on :4096 demoted to read-frozen archive | script + sim: **~hours** (16 handles max; today exactly **1** session qualifies by data — `[LAB] Veraldar` — plus the owner's named set: voice, hardwar "and friends", i.e. the 16 `[LAB]`s; twin deletion only after the sim is green, owner-gated) | the archive notion must stay honest — that is what the audit (§2f) enforces; without it (c) rots back into (a) |

**Recommendation: (c), with the audit as its teeth.** It matches the measured world (one live
lab, 205 dead histories), it is what the owner literally asked for (keep the labs homed on the old
roots — proxy them — while not churning dead history), and it is the only option whose end state
contains no writable duplicates. Under the single-home law: closed-history twins are not
"copies-of-record" but *archives* (inert), so no law is broken and nothing needs deleting.

Sequence: run the audit (P2) → it prints the live set (today: Veraldar; owner can flag more) →
sim on scratch (§4) → owner consents → mint the 16 proxies, delete those 16 twins, re-run audit →
green. The other 205 twins are never touched.

---

## 4 · SIMULATION PLAN (owner's law: simulation is the proof)

Territory — all scratch, no live writes:
- **Scratch home root** `:4130` (`YGG_DATA_DIR=$(mktemp -d)`) — the consuming root under test.
- **Scratch remote root** `:4135` (own `YGG_DATA_DIR`) — the kill-test victim (kill/restart it
  freely; the LIVE :4096 is never killed, never posted to except one adapter-created `[RUN]`
  session deleted afterwards — the harness-bench proven pattern).
- **`ygg-relay`** on `:4140` (loopback).
- Real `:4096` used read-only: list, transcript fetch, latency baselines; a second sim leg
  exercises the opencode dialect against :4096 with the disposable `[RUN]` session.

Flows (bifrost-shaped):

1. **Mint + list:** proxy a real :4096 `[LAB]` (read-only mint: mirror seed) into :4130's store;
   list shows `proxy · route :4096`; MAIN's row is untouched.
2. **Open transcript:** mirror serves instantly; refresh-on-open updates from the remote; freshness
   badge states its age.
3. **Text turn (the money path):** turn from the PWA shape → pointer 409 → relay → remote → deltas
   stream back → mirror updated. *Metrics: added latency p50/p95 vs (i) direct-to-remote and
   (ii) local native turn — reuse harness-bench's TTFB/wall machinery; pass bar: relay overhead
   p95 ≤ 250 ms.* Repeat on the oc-dialect leg.
4. **Kill the remote mid-turn (the build gate):** `SIGKILL :4135` mid-stream → the user must see a
   VISIBLE degraded state: error turn `proxy.unreachable` + banner, relay returns clean errors,
   no silent hang, no wedged handle; restart the remote → next turn recovers and the mirror
   re-syncs. Kill the *relay* mid-turn too: root guard 409s visibly; handle intact.
5. **Compaction across the relay:** set `YGG_ROLLUP_TOKENS` tiny on :4135 → marathon until the
   remote compacts → mirror shows the compaction part; local rollup provably skipped the handle
   (byte-identity of the handle's pre/post messages apart from mirrored additions).
6. **Read-only/archived proxy:** archive the remote session → turn → refusal error turn, wording
   per §1b-6; emigrate path mints a local copy with `info.emigratedFrom`, audit stays green.
7. **Outage browsing:** remote down → transcript still browsable from mirror, badge "stale since
   X" (resilience requirement from the owner's own outage story).
8. **Audit:** single-home audit over the scratch world + the real stores (read-only) → report
   artifact; `proxy-sessions-sim-report.md` with the latency table + failure-UX timings
   (time-to-visible-banner on each kill).

GREEN gate: all 8 flows pass + metrics table filled + audit green. Only then does §3's real
migration (owner-gated) proceed.

---

## 5 · SEQUENCING (what depends on what)

```
P1 contract law + root guard (S) ──┐
P2 single-home audit (S) ──────────┼─→ P3 ygg-relay + minting (M) ─→ P5 sim suite (L)
profiles-ui / session-list wave ───┼─→ P4 trunk+PWA badge/banner (M) ─┘   │
v0.7.1 slice = the release vehicle for P1–P4 after P5 GREEN            │
MAIN-as-coordinator: owns per-session verdicts + migration consent ────┘
```

- **Root guard (P1)** first: it makes dual-writes *impossible* before anything else exists; tiny,
  contract-testable, shippable alone.
- **Audit (P2)** second: turns §3 from judgment into data; its first real run is a deliverable.
- **Relay (P3)** needs P1's pointer shape and P2's classification; adapters already exist, so the
  size is integration, not invention.
- **PWA/trunk (P4)** lands with the **profiles-ui / session-coordination wave on :443** (the owner
  validates provider + session coordination there before v0.8) — the badge rides that surface
  rather than shipping a UI wave of its own.
- **v0.7.1 slice:** the release vehicle for P1–P4 once P5 is green (v0.7.0-rc2 is the live ring
  today; proxy support is the first post-rc delta — small, gated, rollback-able via promote.sh).
- **MAIN-as-coordinator:** per the root-contract law ("MAIN coordinates sessions… the root only
  serves them"), MAIN owns the *decision* layer: which sessions proxify, the twin-retirement
  consent, and the migration runbook execution order. Labs (this one) build the instruments; MAIN
  pulls the levers on the sacred store.
- **This lab stays DESIGN** until P5's report exists; nothing in it touches :8080/:443/:4096/:4100
  live services.

---

## Appendix A — probe log (read-only, 10-30)

- `GET :4096/session?limit=1000` → 249; `GET :4100/session` → 362 (221 `[V06]`, all archived).
- sqlite ro (`file:…opencode.db?mode=ro`): 16 `[LAB]` rows, ids/titles/time_updated listed §0;
  post-import writes on :4096 = 9 rows (1 lab + 8 e2e junk).
- Deterministic twin check: all 16 `[LAB]` twins present in `~/.local/share/yggdrasil/session/`.
- MAIN: only in the :4100 store (318 msgs); absent from :4096 sqlite.
- No POSTs, no DELETEs, no restarts, no store writes. The mission's no-live-service-changes
  constraint is honored end-to-end.
