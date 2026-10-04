# ygg-sim — the flight simulator for bifrost

[LAB] scenario simulator: simulated clients (str0m, in-binary) fly against the
**real** stack — the real `yggdrasil` binary and the real `bifrost-net bridge`
binary, spawned as children on ephemeral ports — over a **shaped wire**
(netem-in-binary: latency, jitter, loss, reorder, duplication, bandwidth,
blackouts, NAT re-binds), driven through a deterministic scenario matrix.
One command runs the matrix and prints a pass/fail board with metrics.

The ONLY simulated server-side component is the upstream LLM (deterministic
in-binary mock honoring yggdrasil's own mock contract) — and, when speaches is
absent, voice scenarios SKIP loudly instead of pretending.

## Run

```bash
cargo test                          # unit tests (rng, wire decision fn, mock plan, strip)
cargo run -q --release -- m0        # seam proof: shaper + shaped WebRTC echo + real yggdrasil turn
cargo run -q --release -- matrix    # the scenario matrix + board (~3 min)
cargo run -q --release -- matrix --only bridge.voice   # any name substring
```

Env: `YGG_SIM_SEED` (wire RNG, default 0xc0ffee), `YGG_SIM_SPEACHES` (voice
lane, default :8000/v1 — absent speaches ⇒ voice scenarios SKIP loudly),
`YGG_SIM_DEBUG=1` (breadcrumb watchdog), `YGG_SIM_YGG_BIN`/`YGG_SIM_BRIDGE_BIN`.

## The matrix (17)

- `rest.*` — text roundtrip · abort-mid-run · refresh-reread ·
  marathon-rollup (the 400K-token mechanism) · upstream-down
- `bridge.*` — auth (incl. revocation) · data-roundtrip · prompt-run-done
  (tracks the known bridge bug) · handsfree-round · poor-network-turn ·
  link-flap · nat-rebind (break-as-documented) · multi-device · mode-switch ·
  abort-mid-turn · reconnect-after-switch · tts-paragraphs (essay)

Reports land in `report/matrix.{md,json}`. Findings: `FINDINGS.md`.

Binaries it spawns (must be built first):

- `../yggdrasil/target/release/yggdrasil` (YGG_SIM_YGG_BIN overrides)
- `../bifrost-net/target/release/bifrost-net` (YGG_SIM_BRIDGE_BIN overrides)

Never touches the live services (:4096 opencode, :4100 live yggdrasil) — the
sim world is hermetic: ephemeral 127.0.0.1 ports, temp data dir, wiped on exit.

## Layout

- `src/wire.rs` — the shaped wire (per-client): profiles (home / phone-cell /
  poor-cell), blackouts, rebinds, stats; SDP candidate stripping so the wire
  owns all reachability.
- `src/mockup.rs` — deterministic upstream LLM (OpenAI SSE + JSON, roll-up
  summary, "reply with exactly:", "sleep N", "slow" mode, /control failure
  injection, /calls counters).
- `src/world.rs` — spawns the real binaries + health checks + temp dirs.
- `src/httpc.rs` — turn-level shaped HTTP for REST/scenario traffic.
- `src/m0.rs` — the seam proof (run first; matrix assumes it green).
- `src/scenarios/` — the scenario matrix (M1+).
- `src/runner.rs` — board + report (M1+).

## Honest limits

- Determinism: the wire's decision function is pure and seeded (m0 checks it),
  but the live wire is wall-clock threaded — runs are statistically
  reproducible; scenario pass bands absorb residual jitter.
- HTTP shaping is request-granularity (RTT draw + drop/retry), not per-packet.
- The mock upstream speaks the OpenAI dialect only (yggdrasil's default).
