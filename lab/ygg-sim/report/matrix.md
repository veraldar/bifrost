# ygg-sim matrix report

seed `0xc0ffee` · hermetic world (real yggdrasil + real bifrost-net bridge children, deterministic mock upstream)

| scenario | device | profile | verdict | metrics |
|---|---|---|---|---|
| rest.text-roundtrip | desktop | home | PASS | turn 47ms |
| rest.abort-mid-run | desktop | home | PASS | abort 6ms |
| rest.refresh-reread | phone | phone-cell | PASS | turn 98ms |
| rest.marathon-rollup | desktop | home | PASS | turn-0 2865ms |
| rest.upstream-down | desktop | home | PASS | recovery-turn 35ms |
| rest.tool-loop | desktop | home | PASS | one-call 41ms |
| rest.parallel-sessions | desktop×4 | home | PASS | turn-0 11ms |
| rest.abort-mid-tool | desktop | home | PASS | abort 4ms |
| rest.anthropic-dialect | desktop | home | PASS | turn-1 12ms |
| bridge.auth | desktop | home | PASS |  |
| bridge.data-roundtrip | phone | phone-cell | PASS | ping-avg 149ms |
| bridge.prompt-run-done | phone | phone-cell | KNOWN | known issue (tracked): bridge run.done starves on the prompt op: wait_run_done's baseline is taken AFTER the blocking POST (bridge.rs), so on fast upstreams the notice only fires via the 120s timeout — turn itself completes (transcript verified). Fix belongs in lab/bifrost-net's lane; this scenario flips PASS when it lands |
| bridge.handsfree-round | phone | phone-cell | PASS | voice-turn 18074ms |
| bridge.poor-network-turn | phone | poor-cell | PASS | voice-turn 19327ms |
| bridge.link-flap | phone | poor-cell | PASS | recover-2s 136ms |
| bridge.nat-rebind | phone | phone-cell | BREAK-OK | breaks as documented: path died on raw NAT rebind (no ICE restart) — documented; product path is reconnect, see bridge.reconnect scenario |
| bridge.multi-device | phone+desktop | phone-cell | PASS |  |
| bridge.mode-switch | phone | phone-cell | PASS | keyboard-cycle 5807ms |
| bridge.abort-mid-turn | phone | phone-cell | PASS | fresh-connect 1048ms |
| bridge.reconnect-after-switch | phone | phone-cell | PASS | reconnect 3ms |
| bridge.tts-paragraphs | phone | phone-cell | PASS | essay-turn 21328ms |
| bridge.bandwidth-starved | phone | congested-cell | BREAK-OK | breaks as documented: bridge bursts TTS unpaced (no BWE/pacing): 64 kbps downlink delivered only 35% of a burst that fits the pipe when paced; channel + notices + recovery unaffected |
| bridge.paced-uplink-starved | phone | congested-uplink | PASS | voice-turn 50739ms |
| app.install-pair | android | adb | SKIP | skip — no adb host: no adb host: install platform-tools locally (YGG_SIM_ADB) or run scripts/android-lab/01-mac-setup.sh |
| app.push-notification | android | adb | SKIP | skip — no adb host: no adb host: install platform-tools locally (YGG_SIM_ADB) or run scripts/android-lab/01-mac-setup.sh |
| app.background-audio | android | adb | SKIP | skip — no adb host: no adb host: install platform-tools locally (YGG_SIM_ADB) or run scripts/android-lab/01-mac-setup.sh |
| app.hot-reload | android | adb | SKIP | skip — no adb host: no adb host: install platform-tools locally (YGG_SIM_ADB) or run scripts/android-lab/01-mac-setup.sh |

### rest.abort-mid-run

- abort: 6ms
- post-abort-turn: 35ms

### rest.marathon-rollup

- turn-0: 2865ms
- turn-1: 2907ms
- turn-2: 2865ms
- post-rollup-turn: 36ms
- total: 8652ms
- rollups: 2

### rest.upstream-down

- recovery-turn: 35ms
- recover-total: 35ms

### rest.tool-loop

- one-call: 41ms
- two-call: 81ms
- total: 122ms

### rest.parallel-sessions

- turn-0: 11ms
- turn-1: 13ms
- turn-2: 12ms
- turn-3: 11ms
- wall-4-parallel: 18ms

### rest.abort-mid-tool

- abort: 4ms
- post-abort-turn: 36ms

### rest.anthropic-dialect

- turn-1: 12ms
- turn-2: 97ms
- anthropic-calls: 7

### bridge.data-roundtrip

- ping-avg: 149ms
- ping-max: 166ms
- wire-drops: 0

### bridge.handsfree-round

- voice-turn: 18074ms
- tts-delivered-%: 99
- stt-hits: 3

### bridge.poor-network-turn

- voice-turn: 19327ms
- tts-delivered-%: 87
- stt-hits: 2
- wire-drops: 51

### bridge.mode-switch

- keyboard-cycle: 5807ms
- ping-keyboard: 166ms
- voice-turn: 12832ms
- ping-after-voice: 151ms
- tts-delivered-%: 96

### bridge.abort-mid-turn

- fresh-connect: 1048ms
- idle-after-death: 1048ms

### bridge.tts-paragraphs

- essay-turn: 21328ms
- received-frames: 502
- delivered-%: 98

### bridge.bandwidth-starved

- voice-turn: 18434ms
- post-burst-ping: 181ms
- tts-delivered-%: 35
- stt-hits: 1
- rev-drops: 168

### bridge.paced-uplink-starved

- voice-turn: 50739ms
- tts-delivered-%: 98
- stt-hits: 2
- uplink-drops: 17
