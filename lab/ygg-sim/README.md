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
cargo run -q --release -- matrix    # the scenario matrix + board (~8 min with the app family)
cargo run -q --release -- matrix --only bridge.voice   # any name substring
cargo run -q --release -- cycle     # matrix + evolution rule + digest → report/cycles/cycle-N.json
```

Env: `YGG_SIM_SEED` (wire RNG, default 0xc0ffee), `YGG_SIM_SPEACHES` (voice
lane, default :8000/v1 — absent speaches ⇒ voice scenarios SKIP loudly),
`YGG_SIM_DEBUG=1` (breadcrumb watchdog), `YGG_SIM_YGG_BIN`/`YGG_SIM_BRIDGE_BIN`.
App family: `YGG_SIM_ADB` / `ANDROID_HOME` (default `~/Android/Sdk`, from
`pwa/android/setup-sdk.sh`), `YGG_SIM_AVD` (default `ygg-sim` — booted as the
sim's own child when no emulator is up, shut down gracefully at matrix end),
`YGG_SIM_EMU_PORT` (5580), `YGG_SIM_APK`. Voice edge: `YGG_SIM_STT_PY`
(python with onnx-asr; default the voice-lab venv), `YGG_SIM_STT_MODEL`,
`YGG_SIM_STT_QUANT`.

## The matrix (30, sim 0.5.0)

- `rest.*` (9) — text roundtrip · abort-mid-run · refresh-reread ·
  marathon-rollup · upstream-down · tool-loop · parallel-sessions ·
  abort-mid-tool · anthropic-dialect
- `bridge.*` (15) — auth · data-roundtrip · prompt-run-done (KNOWN) ·
  handsfree-round · poor-network-turn · link-flap · nat-rebind (BREAK-OK) ·
  multi-device · mode-switch · abort-mid-turn · reconnect-after-switch ·
  tts-paragraphs · bandwidth-starved (BREAK-OK) · paced-uplink-starved ·
  **tool-loop** (v5: the agent tool loop over the data channel + op liveness)
- `voice.*` (1) — **stt-inprocess** (v5: STT inside the voice edge vs the
  speaches service, same Opus-decoded mic audio; the v0.6.2 gate's shape)
- `app.*` (5) — **chrome-mic-origin** (v5: Android Chrome mic per origin) ·
  install-pair · push-notification · background-audio · hot-reload (live
  since v5: the bifrost shell APK, `pwa/android`)

Every latency can carry an SLO budget (src/slo.rs): a PASS over budget is a
FAIL — green means within budget, not just finished. Targets (product
goals) show the gap on the board without failing the run.

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
- `src/runner.rs` — board + report (M1+), cycle + evolution rule (v2/v3).
- `src/slo.rs` — the SLO budget table (v5).
- `src/app.rs` — adb driver, the sim's own AVD, the page server the shell
  loads (v3/v5); `android/chrome-mic-origin.mjs` — zero-dep CDP probe of
  Android Chrome.
- `src/stt.rs` + `voice/stt_edge.py` — the STT seam: service vs in-process
  (v5).

## Honest limits

- Determinism: the wire's decision function is pure and seeded (m0 checks it),
  but the live wire is wall-clock threaded — runs are statistically
  reproducible; scenario pass bands absorb residual jitter.
- HTTP shaping is request-granularity (RTT draw + drop/retry), not per-packet.
- The mock upstream speaks OpenAI + Anthropic dialects (v4).
- The app family runs on an emulator: virtual mic (zeros), no OEM battery
  policy, stock Chrome/WebView — the owner's phone closes that gap.
- `app.chrome-mic-origin` loads the tailnet origins (:443 live page, :8443
  sandbox) read-only; the hostname is discovered at runtime and redacted in
  reports.
