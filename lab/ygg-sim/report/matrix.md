# ygg-sim matrix report

seed `0xc0ffee` · hermetic world (real yggdrasil + real bifrost-net bridge children, deterministic mock upstream)

| scenario | device | profile | verdict | metrics |
|---|---|---|---|---|
| rest.text-roundtrip | desktop | home | PASS | turn 47ms |
| rest.abort-mid-run | desktop | home | PASS | abort 6ms |
| rest.refresh-reread | phone | phone-cell | PASS | turn 99ms |
| rest.marathon-rollup | desktop | home | PASS | turn-0 2864ms |
| rest.upstream-down | desktop | home | PASS | recovery-turn 36ms |
| bridge.auth | desktop | home | PASS |  |
| bridge.data-roundtrip | phone | phone-cell | PASS | ping-avg 148ms |
| bridge.prompt-run-done | phone | phone-cell | KNOWN | known issue (tracked): bridge run.done starves on the prompt op: wait_run_done's baseline is taken AFTER the blocking POST (bridge.rs), so on fast upstreams the notice only fires via the 120s timeout — turn itself completes (transcript verified). Fix belongs in lab/bifrost-net's lane; this scenario flips PASS when it lands |
| bridge.handsfree-round | phone | phone-cell | PASS | voice-turn 19879ms |
| bridge.poor-network-turn | phone | poor-cell | PASS | voice-turn 19441ms |
| bridge.link-flap | phone | poor-cell | PASS | recover-2s 136ms |
| bridge.nat-rebind | phone | phone-cell | BREAK-OK | breaks as documented: path died on raw NAT rebind (no ICE restart) — documented; product path is reconnect, see bridge.reconnect scenario |
| bridge.multi-device | phone+desktop | phone-cell | PASS |  |
| bridge.mode-switch | phone | phone-cell | PASS | keyboard-cycle 5635ms |
| bridge.abort-mid-turn | phone | phone-cell | PASS | fresh-connect 1071ms |
| bridge.reconnect-after-switch | phone | phone-cell | PASS | reconnect 3ms |
| bridge.tts-paragraphs | phone | phone-cell | PASS | essay-turn 30100ms |

### rest.abort-mid-run

- abort: 6ms
- post-abort-turn: 36ms

### rest.marathon-rollup

- turn-0: 2864ms
- turn-1: 2911ms
- turn-2: 2870ms
- post-rollup-turn: 36ms
- total: 8660ms
- rollups: 2

### rest.upstream-down

- recovery-turn: 36ms
- recover-total: 36ms

### bridge.data-roundtrip

- ping-avg: 148ms
- ping-max: 169ms
- wire-drops: 0

### bridge.poor-network-turn

- voice-turn: 19441ms
- tts-delivered-%: 90
- wire-drops: 53

### bridge.mode-switch

- keyboard-cycle: 5635ms
- ping-keyboard: 166ms
- voice-turn: 20283ms
- ping-after-voice: 151ms
- tts-delivered-%: 98

### bridge.abort-mid-turn

- fresh-connect: 1071ms
- idle-after-death: 1071ms

### bridge.tts-paragraphs

- essay-turn: 30100ms
- received-frames: 502
- delivered-%: 98
