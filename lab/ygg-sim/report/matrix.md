# ygg-sim matrix report

seed `0xc0ffee` · hermetic world (real yggdrasil + real bifrost-net bridge children, deterministic mock upstream)

| scenario | device | profile | verdict | SLO | metrics |
|---|---|---|---|---|---|
| rest.text-roundtrip | desktop | home | PASS | slo 1/1 | turn 51ms |
| rest.abort-mid-run | desktop | home | PASS | slo 2/2 | abort 6ms |
| rest.refresh-reread | phone | phone-cell | PASS | slo 1/1 | turn 99ms |
| rest.marathon-rollup | desktop | home | PASS | slo 3/3 | turn-0 2867ms |
| rest.upstream-down | desktop | home | PASS | slo 1/1 | recovery-turn 36ms |
| rest.tool-loop | desktop | home | PASS | slo 2/2 | one-call 41ms |
| rest.parallel-sessions | desktop×4 | home | PASS | slo 1/1 | turn-0 11ms |
| rest.abort-mid-tool | desktop | home | PASS | slo 2/2 | abort 4ms |
| rest.anthropic-dialect | desktop | home | PASS | slo 2/2 | turn-1 13ms |
| bridge.auth | desktop | home | PASS |  |  |
| bridge.data-roundtrip | phone | phone-cell | PASS | slo 2/2 | ping-avg 149ms |
| bridge.prompt-run-done | phone | phone-cell | KNOWN | slo 0/1 | known issue (tracked): bridge run.done starves on the prompt op: wait_run_done's baseline is taken AFTER the blocking POST (bridge.rs), so on fast upstreams the notice only fires via the 120s timeout — turn itself completes (transcript verified). Fix belongs in lab/bifrost-net's lane; this scenario flips PASS when it lands |
| bridge.handsfree-round | phone | phone-cell | PASS | slo 1/1 tgt 0/1 | voice-turn 17767ms |
| bridge.poor-network-turn | phone | poor-cell | PASS | slo 1/1 tgt 0/1 | voice-turn 18207ms |
| bridge.link-flap | phone | poor-cell | PASS | slo 1/1 | recover-2s 151ms |
| bridge.nat-rebind | phone | phone-cell | BREAK-OK |  | breaks as documented: path died on raw NAT rebind (no ICE restart) — documented; product path is reconnect, see bridge.reconnect scenario |
| bridge.multi-device | phone+desktop | phone-cell | PASS |  |  |
| bridge.mode-switch | phone | phone-cell | PASS | slo 4/4 tgt 0/1 | keyboard-cycle 5626ms |
| bridge.abort-mid-turn | phone | phone-cell | PASS | slo 2/2 | fresh-connect 1047ms |
| bridge.reconnect-after-switch | phone | phone-cell | PASS | slo 1/1 | reconnect 4ms |
| bridge.tts-paragraphs | phone | phone-cell | PASS | slo 1/1 | essay-turn 21480ms |
| bridge.bandwidth-starved | phone | congested-cell | BREAK-OK | slo 1/1 | breaks as documented: bridge bursts TTS unpaced (no BWE/pacing): 64 kbps downlink delivered only 35% of a burst that fits the pipe when paced; channel + notices + recovery unaffected |
| bridge.paced-uplink-starved | phone | congested-uplink | PASS | slo 1/1 | voice-turn 19506ms |
| bridge.tool-loop | phone | phone-cell | KNOWN | slo 4/4 tgt 0/1 | known issue (tracked): tool loop over the channel holds (one-call 181ms, 3 tool parts with real outputs + finals) BUT head-of-line: the bridge serves every op from 2 blocking workers and a prompt op holds one for the whole run — 2 concurrent tool runs stall ping to 4329ms (1 busy: 151ms). Fix belongs in bifrost-net (prompt op async, like its run.done waiter) |
| voice.stt-inprocess | edge | cpu | KNOWN | slo 3/3 tgt 2/2 | known issue (tracked): v0.6.2 gate half-met: English parity (WER 0% vs service 0%, 479ms vs 4881ms per utterance, 10s utterance 1302ms), but FRENCH misses parity in-process: WER 37% vs service 18% (heard 'Bonjour, ouvre la dernière session s'il te plaît.', 'Quelle est la météo azur riche de même à thèse?') with eschmidbauer/parakeet-redux-onnx — the gate needs an in-process model that matches on French (swap via YGG_SIM_STT_MODEL / _QUANT; the scenario stays) |
| app.chrome-mic-origin | android | adb | PASS | slo 2/2 | gum-B-8443 5096ms |
| app.install-pair | android | adb | PASS | slo 2/2 tgt 1/1 | pair-verify 1974ms |
| app.push-notification | android | adb | BREAK-OK | slo 1/1 tgt 1/1 | breaks as documented: WebView has no Web Push (PushManager absent, Notification=undefined) — the PWA's push.ts path cannot reach a wrapped app; the shell's native notify bridge DID post (nonce in dumpsys after 1763ms). Remote push while closed needs FCM in the shell (pwa/android/README.md design note) |
| app.background-audio | android | adb | BREAK-OK | slo 1/1 | breaks as documented: screen off 20s in the WebView shell: OS silenced=true (RECORD_AUDIO is while-in-use), page saw it=false (track stays live/unmuted, frames keep counting zeros: 18 beacons, +194 frames, visibility hidden=true), un-silenced on wake=true — silent mic loss the page cannot detect; fix = microphone foreground service (pwa/android/README.md design note) |
| app.hot-reload | android | adb | PASS | slo 1/1 tgt 1/1 | relaunch-to-v2 1651ms |

### rest.text-roundtrip

- turn: 51ms (budget ≤500ms ✓)

### rest.abort-mid-run

- abort: 6ms (budget ≤250ms ✓)
- post-abort-turn: 35ms (budget ≤500ms ✓)

### rest.refresh-reread

- turn: 99ms (budget ≤500ms ✓)

### rest.marathon-rollup

- turn-0: 2867ms (budget ≤6000ms ✓)
- turn-1: 2911ms
- turn-2: 2871ms
- post-rollup-turn: 36ms (budget ≤500ms ✓)
- total: 8665ms (budget ≤18000ms ✓)
- rollups: 2

### rest.upstream-down

- recovery-turn: 36ms (budget ≤500ms ✓)
- recover-total: 36ms

### rest.tool-loop

- one-call: 41ms (budget ≤500ms ✓)
- two-call: 85ms (budget ≤1000ms ✓)
- total: 126ms

### rest.parallel-sessions

- turn-0: 11ms
- turn-1: 12ms
- turn-2: 12ms
- turn-3: 10ms
- wall-4-parallel: 18ms (budget ≤500ms ✓)

### rest.abort-mid-tool

- abort: 4ms (budget ≤250ms ✓)
- post-abort-turn: 37ms (budget ≤500ms ✓)

### rest.anthropic-dialect

- turn-1: 13ms (budget ≤500ms ✓)
- turn-2: 98ms (budget ≤1000ms ✓)
- anthropic-calls: 7

### bridge.data-roundtrip

- ping-avg: 149ms (budget ≤300ms ✓)
- ping-max: 166ms (budget ≤600ms ✓)
- wire-drops: 0

### bridge.prompt-run-done

- run: 20002ms (budget ≤5000ms ✗)

### bridge.handsfree-round

- voice-turn: 17767ms (budget ≤45000ms ✓, target ≤8000ms ✗)
- tts-delivered-%: 100
- stt-hits: 3

### bridge.poor-network-turn

- voice-turn: 18207ms (budget ≤45000ms ✓, target ≤10000ms ✗)
- tts-delivered-%: 88
- stt-hits: 2
- wire-drops: 56

### bridge.link-flap

- recover-2s: 151ms (budget ≤3000ms ✓)
- survive-4s: 1

### bridge.mode-switch

- keyboard-cycle: 5626ms (budget ≤17000ms ✓)
- ping-keyboard: 166ms (budget ≤600ms ✓)
- voice-turn: 13049ms (budget ≤30000ms ✓, target ≤8000ms ✗)
- ping-after-voice: 136ms (budget ≤600ms ✓)
- tts-delivered-%: 98

### bridge.abort-mid-turn

- fresh-connect: 1047ms (budget ≤3000ms ✓)
- idle-after-death: 1048ms (budget ≤3000ms ✓)

### bridge.reconnect-after-switch

- reconnect: 4ms (budget ≤500ms ✓)

### bridge.tts-paragraphs

- essay-turn: 21480ms (budget ≤56000ms ✓)
- received-frames: 504
- delivered-%: 98

### bridge.bandwidth-starved

- voice-turn: 17985ms
- post-burst-ping: 196ms (budget ≤5000ms ✓)
- tts-delivered-%: 35
- stt-hits: 1
- rev-drops: 169

### bridge.paced-uplink-starved

- voice-turn: 19506ms (budget ≤100000ms ✓)
- tts-delivered-%: 98
- stt-hits: 3
- uplink-drops: 15

### bridge.tool-loop

- one-call: 181ms (budget ≤1000ms ✓)
- two-call: 196ms (budget ≤1000ms ✓)
- ping-1-tool-busy: 151ms (budget ≤1500ms ✓)
- ping-2-tools-busy: 4329ms (budget ≤60000ms ✓, target ≤500ms ✗)
- tool-parts: 3
- msgs-with-role: 4

### voice.stt-inprocess

- stt-utterance: 479ms (budget ≤4000ms ✓, target ≤1000ms)
- model-load: 2354ms (budget ≤30000ms ✓)
- service-utterance: 4881ms
- stt-10s-utterance: 1302ms (budget ≤10000ms ✓, target ≤2000ms)
- service-10s-utterance: 6075ms
- wer-inproc-%: 0
- wer-service-%: 0
- wer-10s-inproc-%: 0
- wer-fr-inproc-%: 37
- wer-fr-service-%: 18
- edge-rss-mb: 607
- audio-ms-median: 2140
- audio-ms-long: 10200

### app.chrome-mic-origin

- gum-B-8443: 5096ms (budget ≤15000ms ✓)
- gum-A-443: 6515ms
- probe-wall: 42638ms (budget ≤90000ms ✓)
- A-gum-ok: 1
- B-gum-ok: 1
- C-mediaDevices-undefined: 1
- D-gum-ok: 1
- B-perm-inherited-from-A: 0

### app.install-pair

- pair-verify: 1974ms (budget ≤5000ms ✓, target ≤3000ms)
- token-in-page: 2955ms (budget ≤8000ms ✓)
- verify-status: 400

### app.push-notification

- notify-visible: 1763ms (budget ≤8000ms ✓, target ≤3000ms)
- web-push-api: 0
- web-notification-api: 0
- service-worker-api: 1

### app.background-audio

- gum-live: 3614ms (budget ≤10000ms ✓)
- js-beacons-off: 18
- mic-frames-off: 194
- os-silenced-off: 1
- page-saw-loss: 0
- recovered-on-wake: 1

### app.hot-reload

- relaunch-to-v2: 1651ms (budget ≤6000ms ✓, target ≤3000ms)
