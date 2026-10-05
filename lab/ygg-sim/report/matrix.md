# ygg-sim matrix report

seed `0xc0ffee` · hermetic world (real yggdrasil + real bifrost-net bridge children, deterministic mock upstream)

| scenario | device | profile | verdict | metrics |
|---|---|---|---|---|
| rest.text-roundtrip | desktop | home | PASS | turn 47ms |
| rest.abort-mid-run | desktop | home | PASS | abort 6ms |
| rest.refresh-reread | phone | phone-cell | PASS | turn 99ms |
| rest.marathon-rollup | desktop | home | PASS | turn-0 2869ms |
| rest.upstream-down | desktop | home | PASS | recovery-turn 36ms |
| rest.tool-loop | desktop | home | PASS | one-call 41ms |
| rest.parallel-sessions | desktop×4 | home | PASS | turn-0 11ms |
| bridge.auth | desktop | home | PASS |  |
| bridge.data-roundtrip | phone | phone-cell | PASS | ping-avg 149ms |
| bridge.prompt-run-done | phone | phone-cell | KNOWN | known issue (tracked): bridge run.done starves on the prompt op: wait_run_done's baseline is taken AFTER the blocking POST (bridge.rs), so on fast upstreams the notice only fires via the 120s timeout — turn itself completes (transcript verified). Fix belongs in lab/bifrost-net's lane; this scenario flips PASS when it lands |
| bridge.handsfree-round | phone | phone-cell | PASS | voice-turn 19071ms |
| bridge.poor-network-turn | phone | poor-cell | PASS | voice-turn 16760ms |
| bridge.link-flap | phone | poor-cell | PASS | recover-2s 1148ms |
| bridge.nat-rebind | phone | phone-cell | BREAK-OK | breaks as documented: path died on raw NAT rebind (no ICE restart) — documented; product path is reconnect, see bridge.reconnect scenario |
| bridge.multi-device | phone+desktop | phone-cell | PASS |  |
| bridge.mode-switch | phone | phone-cell | PASS | keyboard-cycle 5674ms |
| bridge.abort-mid-turn | phone | phone-cell | PASS | fresh-connect 1048ms |
| bridge.reconnect-after-switch | phone | phone-cell | PASS | reconnect 4ms |
| bridge.tts-paragraphs | phone | phone-cell | PASS | essay-turn 20126ms |
| bridge.bandwidth-starved | phone | congested-cell | BREAK-OK | breaks as documented: bridge bursts TTS unpaced (no BWE/pacing): 64 kbps downlink delivered only 35% of a burst that fits the pipe when paced; channel + notices + recovery unaffected |
| app.install-pair | android | adb | SKIP | skip — app scenarios live when: wrap not built (parallel lane): no APK at /home/dweeb_xyz/Work/bifrost/lab/ygg-sim/../../pwa/android/app/build/outputs/apk/debug/app-debug.apk (YGG_SIM_APK overrides) |
| app.push-notification | android | adb | SKIP | skip — app scenarios live when: wrap not built (parallel lane): no APK at /home/dweeb_xyz/Work/bifrost/lab/ygg-sim/../../pwa/android/app/build/outputs/apk/debug/app-debug.apk (YGG_SIM_APK overrides) |
| app.background-audio | android | adb | SKIP | skip — app scenarios live when: wrap not built (parallel lane): no APK at /home/dweeb_xyz/Work/bifrost/lab/ygg-sim/../../pwa/android/app/build/outputs/apk/debug/app-debug.apk (YGG_SIM_APK overrides) |
| app.hot-reload | android | adb | SKIP | skip — app scenarios live when: wrap not built (parallel lane): no APK at /home/dweeb_xyz/Work/bifrost/lab/ygg-sim/../../pwa/android/app/build/outputs/apk/debug/app-debug.apk (YGG_SIM_APK overrides) |

### rest.abort-mid-run

- abort: 6ms
- post-abort-turn: 36ms

### rest.marathon-rollup

- turn-0: 2869ms
- turn-1: 2918ms
- turn-2: 2878ms
- post-rollup-turn: 36ms
- total: 8681ms
- rollups: 2

### rest.upstream-down

- recovery-turn: 36ms
- recover-total: 36ms

### rest.tool-loop

- one-call: 41ms
- two-call: 83ms
- total: 125ms

### rest.parallel-sessions

- turn-0: 11ms
- turn-1: 13ms
- turn-2: 12ms
- turn-3: 11ms
- wall-4-parallel: 18ms

### bridge.data-roundtrip

- ping-avg: 149ms
- ping-max: 166ms
- wire-drops: 0

### bridge.handsfree-round

- voice-turn: 19071ms
- tts-delivered-%: 99
- stt-hits: 3

### bridge.poor-network-turn

- voice-turn: 16760ms
- tts-delivered-%: 89
- stt-hits: 2
- wire-drops: 59

### bridge.mode-switch

- keyboard-cycle: 5674ms
- ping-keyboard: 166ms
- voice-turn: 12357ms
- ping-after-voice: 121ms
- tts-delivered-%: 98

### bridge.abort-mid-turn

- fresh-connect: 1048ms
- idle-after-death: 1048ms

### bridge.tts-paragraphs

- essay-turn: 20126ms
- received-frames: 490
- delivered-%: 95

### bridge.bandwidth-starved

- voice-turn: 16674ms
- post-burst-ping: 197ms
- tts-delivered-%: 35
- stt-hits: 1
- rev-drops: 167
