# ygg-sim — findings

**Mission**: [LAB] flight simulator for bifrost — simulated clients fly against
the REAL stack (yggdrasil + bifrost-net bridge, both as real child processes)
over a shaped wire, through a deterministic scenario matrix. One command, a
pass/fail board.

**Date**: 10-04 · **Session**: YGG-SIM · **Verdict: DELIVERED — M0 3/3 GREEN, MATRIX 17 scenarios × 2 runs GREEN (15 pass / 1 break-as-documented / 1 known-issue / 0 FAIL)**

---

## What was built

```
lab/ygg-sim/
├── src/wire.rs        shaped wire — netem in-binary: latency/jitter/loss/dup/
│                      reorder/bandwidth/blackout/NAT-rebind per direction,
│                      seeded xorshift decisions, SDP candidate stripping so
│                      the wire owns ALL reachability (no path can bypass)
├── src/client.rs      SimClient — phone/desktop-class str0m peer: token-gated
│                      signaling, `app` data channel, Opus mic (TTS fixture),
│                      device-scaled jitter buffer (15↔60 packets)
├── src/mockup.rs      the ONLY simulated server piece: deterministic upstream
│                      LLM (OpenAI SSE+JSON, roll-up summary, "reply with
│                      exactly:", "sleep N", "slow", essay, /control failure
│                      injection, /calls counters)
├── src/world.rs       spawns the REAL binaries (release builds of
│                      ../yggdrasil + ../bifrost-net) on ephemeral ports,
│                      temp data dir, mints device tokens per the PWA's
│                      camelCase contract, health-probes both
├── src/scenarios/     the matrix: rest.* (proxy view) + bridge.* (WebRTC path)
├── src/runner.rs      board + report (matrix.md / matrix.json)
└── src/m0.rs          seam proof (run first): shaper determinism, shaped
                        str0m echo byte-exact under 25% loss + 500ms tunnel,
                        real-yggdrasil turn under the phone profile
```

One command: `cargo run --release -- matrix` → the board, ~3 min, exit code =
verdict. `--only FILTER` runs a slice. `YGG_SIM_SEED` pins the wire RNG.
`YGG_SIM_SPEACHES` points the voice lane elsewhere; absent speaches → voice
scenarios SKIP loudly, never fake.

## What the sim caught in the REAL stack (the point of the exercise)

1. **bridge run.done starvation (KNOWN, unfixed — bifrost-net's lane)**:
   `wait_run_done` in `lab/bifrost-net/src/bridge.rs` takes its assistant-count
   baseline AFTER `oc.prompt()` — but the prompt POST **blocks until the run
   ends** (yggdrasil's opencode contract, main.rs:443). On any fast upstream
   the baseline already includes the reply, `count > before` never fires, and
   the `run.done` notice only escapes via the 120s timeout. Data-channel
   prompts (`op:"prompt"`) starve the lifecycle notice; voice turns are fine
   (their baseline is taken before the POST). Caught by
   `bridge.prompt-run-done`; tracked as the matrix's KNOWN verdict — flips
   PASS automatically when fixed. Note: same file's voice_pipeline does it
   right; the fix is one move of one line.
2. **Device tokens are camelCase on the wire** (`tokenHash`): the bridge's
   serde `rename_all = "camelCase"` means snake_case token files parse to zero
   valid devices → every offer 401s. The PWA's real file (pwa/.devices.json)
   uses camelCase; bifrost-net's own bridge_test writes snake_case and would
   fail against its own bridge today. ygg-sim's world writes the real
   contract.
3. **str0m frame-mode reorder hold** (not a bug — a law to engineer against):
   default 15 packets / 1s timeout holds media through gaps; the bridge writes
   the whole TTS burst unpaced, so on lossy links the tail outruns the
   lifecycle notice and lossy bursts deliver late (client jitter buffer helps;
   real fix is bridge-side pacing/RTX — a v0.9 note, not a lab action).
4. **Raw NAT rebind kills the path (BREAK-OK, documented)**: rotating the
   client's source port mid-session never recovers — no ICE-restart story in
   the bridge. The product path is re-signal (PWA reconnect), which
   `bridge.reconnect-after-switch` proves works in ~4ms signaling + session
   continuity. If mobile handover is ever wanted mid-stream, that's bridge
   work.
5. **What held up (proof, not just absence of failure)**: token revocation
   lands ≤1.6s; 2s blackouts recover in ~140ms on a live channel; 4s tunnels
   survive; a dead phone mid-turn wedges nothing (fresh device connects in
   ~1s, yggdrasil returns to idle on schedule); sessions survive
   reconnect-and-continue; aborts leave clean state; roll-up fires and the
   session keeps working; upstream 500s surface loudly and don't brick.

## Honest limits

- Determinism: the wire's decision function is pure + seeded (m0 checks it);
  the live wire is wall-clock threaded, so runs are statistically
  reproducible — pass bands absorb residual jitter (two full-matrix runs
  green back-to-back).
- HTTP shaping is request-granularity (RTT draw + drop/retry), not per-packet.
- Mock upstream speaks the OpenAI dialect only (yggdrasil's default); no
  tool-loop scenarios yet (the mock never calls tools) — a matrix v2 item.
- `--live` mode against :4100 intentionally not built: the hermetic world
  already runs the real binaries; live-data runs would burn real upstream
  tokens and break determinism.
- Voice lanes need speaches (:8000 local, or YGG_SIM_SPEACHES); without it
  they SKIP loudly rather than fake.

## Milestones (playbook shape)

- **M0** — shaper + real-stack seams GREEN 3/3 (committed 4625e53).
- **M1** — SimClient + bridge world + first board: found the token contract.
- **M2** — voice pipeline through chaos: hands-free round, poor-network turn,
  link flap, NAT rebind, multi-device.
- **M3** — full mission matrix (17): marathon/roll-up, upstream-down, mode
  switch, abort-mid-turn, reconnect-after-switch, essay TTS + runner report.
