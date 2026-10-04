# ygg-sim matrix report

seed `0xc0ffee` · hermetic world (real yggdrasil + real bifrost-net bridge children, deterministic mock upstream)

| scenario | device | profile | verdict | metrics |
|---|---|---|---|---|
| rest.text-roundtrip | desktop | home | PASS | turn 47ms |
| rest.abort-mid-run | desktop | home | PASS | abort 6ms |
| rest.refresh-reread | phone | phone-cell | PASS | turn 99ms |
| rest.marathon-rollup | desktop | home | PASS | turn-0 2864ms |
| rest.upstream-down | desktop | home | PASS | recovery-turn 36ms |
| rest.tool-loop | desktop | home | PASS | one-call 41ms |
| rest.parallel-sessions | desktop×4 | home | PASS | turn-0 11ms |
| bridge.auth | desktop | home | PASS |  |
| bridge.data-roundtrip | phone | phone-cell | PASS | ping-avg 150ms |
| bridge.prompt-run-done | phone | phone-cell | KNOWN | known issue (tracked): bridge run.done starves on the prompt op: wait_run_done's baseline is taken AFTER the blocking POST (bridge.rs), so on fast upstreams the notice only fires via the 120s timeout — turn itself completes (transcript verified). Fix belongs in lab/bifrost-net's lane; this scenario flips PASS when it lands |
| bridge.handsfree-round | phone | phone-cell | PASS | voice-turn 23334ms |
| bridge.poor-network-turn | phone | poor-cell | PASS | voice-turn 22718ms |
| bridge.link-flap | phone | poor-cell | PASS | recover-2s 136ms |
| bridge.nat-rebind | phone | phone-cell | BREAK-OK | breaks as documented: path died on raw NAT rebind (no ICE restart) — documented; product path is reconnect, see bridge.reconnect scenario |
| bridge.multi-device | phone+desktop | phone-cell | PASS |  |
| bridge.mode-switch | phone | phone-cell | PASS | keyboard-cycle 5663ms |
| bridge.abort-mid-turn | phone | phone-cell | PASS | fresh-connect 1069ms |
| bridge.reconnect-after-switch | phone | phone-cell | PASS | reconnect 3ms |
| bridge.tts-paragraphs | phone | phone-cell | PASS | essay-turn 28046ms |
| bridge.bandwidth-starved | phone | congested-cell | BREAK-OK | breaks as documented: bridge bursts TTS unpaced (no BWE/pacing): 64 kbps downlink delivered only 35% of a burst that fits the pipe when paced; channel + notices + recovery unaffected |

### rest.abort-mid-run

- abort: 6ms
- post-abort-turn: 36ms

### rest.marathon-rollup

- turn-0: 2864ms
- turn-1: 2920ms
- turn-2: 2864ms
- post-rollup-turn: 36ms
- total: 8664ms
- rollups: 2

### rest.upstream-down

- recovery-turn: 36ms
- recover-total: 36ms

### rest.tool-loop

- one-call: 41ms
- two-call: 81ms
- total: 122ms

### rest.parallel-sessions

- turn-0: 11ms
- turn-1: 12ms
- turn-2: 12ms
- turn-3: 10ms
- wall-4-parallel: 18ms

### bridge.data-roundtrip

- ping-avg: 150ms
- ping-max: 167ms
- wire-drops: 0

### bridge.handsfree-round

- voice-turn: 23334ms
- tts-delivered-%: 98
- stt-hits: 3

### bridge.poor-network-turn

- voice-turn: 22718ms
- tts-delivered-%: 88
- stt-hits: 2
- wire-drops: 61

### bridge.mode-switch

- keyboard-cycle: 5663ms
- ping-keyboard: 151ms
- voice-turn: 15702ms
- ping-after-voice: 136ms
- tts-delivered-%: 98

### bridge.abort-mid-turn

- fresh-connect: 1069ms
- idle-after-death: 1069ms

### bridge.tts-paragraphs

- essay-turn: 28046ms
- received-frames: 503
- delivered-%: 98

### bridge.bandwidth-starved

- voice-turn: 23375ms
- post-burst-ping: 181ms
- tts-delivered-%: 35
- stt-hits: 1
- rev-drops: 171
