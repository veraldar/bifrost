# Android software lab — consumer path proven without a real phone

Status: **working** (2026-10-03). Verdict **PASS 6/6** — PWA opens in real Chrome
on a headless Android 14 emulator (Mac Studio), session created, text round-trip
lands, screenshot evidence at every step. No product code was touched.

## Why

The phone is the only untested consumer device. This lab replaces it in
software: an ARM64 Android emulator driven by Playwright's android (adb)
module, opening the **live** bifrost PWA. Everything a release would touch —
manifest, service worker, Next proxy, opencode round-trip — runs for real.

## Topology

```
omarchy (this box)                     Mac Studio (M3 Ultra, headless via ssh)
┌───────────────────────────┐   ssh -R 18080:127.0.0.1:8080   ┌──────────────────────────┐
│ PWA  127.0.0.1:8080  ─────┼────────────────────────────────►│ Mac loopback :18080      │
│ opencode 127.0.0.1:4096   │                                 │   └ adb reverse tcp:8080 │
└───────────────────────────┘                                 │       └ Chrome (AVD)     │
                                                              │ AVD bifrost-lab          │
                                                              │ Android 14, arm64        │
                                                              │ emulator -no-window      │
                                                              └──────────────────────────┘
```

- Device-side URL is `http://localhost:8080` — a **secure context** on Android
  Chrome, so service worker + install machinery are exercised for real.
- Why not the tailnet URL: `tailscale ping` omarchy→Mac works (9 ms) but **all
  TCP Mac→omarchy tailnet IPs is dropped** (ACL-shaped: tailscale ping is
  ACL-exempt, payload is not; ICMP and every port time out). The tailnet ACL
  lives in the admin console and cannot be fixed from this repo. The ssh -R
  tunnel over LAN is the stand-in; the mission allows "tailnet or LAN".
- The Mac already runs its **own** bifrost PWA instance on :8080
  (`~/yggdrasil-bifrost` clone + livekit-server + node) — the tunnel binds
  :18080 on the Mac to avoid it.

## Reproduce from zero

Prereqs: `ssh mac` works (key in docs/local.md), JDK on the Mac (Temurin
already present), ~12 GB disk on the Mac.

```bash
scripts/android-lab/01-mac-setup.sh            # SDK cmdline-tools + platform-tools + emulator + android-34 google_apis arm64 image + AVD (idempotent)
ssh mac 'nohup bash < 02-boot-avd.sh …'        # boot headless AVD + wait boot + seed Chrome --no-first-run
scripts/android-lab/03-run-consumer-flow.sh    # tunnel + node/playwright bootstrap + 04-consumer-flow.mjs + pull evidence
```

`03` is fully idempotent: reuses the tunnel if up, installs node via tarball
(no sudo, brew is broken on the Mac — see findings), installs playwright with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, runs the flow, pulls screenshots +
`report.json` into `artifacts/android-lab/`.

## The flow (04-consumer-flow.mjs)

1. `open-pwa` — Chrome on the AVD opens the PWA, heading `Bifrost` visible.
2. `install-behavior` — probes manifest fetch, service-worker registration,
   secure-context, display-mode, `beforeinstallprompt`.
3. `create-session` — new session → create & open → URL `/session/<name>`.
4. `text-send` — fills `message…`, clicks send, optimistic `(you)` appears.
5. `text-roundtrip` — waits for the agent reply (up to 15 min; see
   congestion finding), asserts `pong` + `(agent)` label + busy cleared.
6. `device-screen` — raw `adb` screencap of the real device frame.

Evidence lands in `artifacts/android-lab/`: `01-home.png` … `06-device-screen.png`
+ `report.json` (verdict PASS/FAIL, timings, install probe results).

## Results (final run 2026-10-03 23:36)

| step | ms |
|---|---|
| open-pwa | 343 |
| install-behavior | 4206 |
| create-session | 552 |
| text-send | 5376 |
| text-roundtrip | 9543 |
| device-screen | 113 |

`05-reply.png` is the whole proof in one frame: real Chrome at
`localhost:8080/session/android-lab-muswvahv`, `(you) → Reply with exactly:
pong`, `(agent) → pong`, plus the PWA's own honest error box and the push
notification permission prompt.

## Findings (lab output, no product changes made)

1. **Install is blocked by icon size.** `manifest.json` ships only a
   16x16/32x32 favicon icon. Chrome's installability criteria want a ≥192px
   icon, so `beforeinstallprompt` never fires (`installPromptOutcome:
   "not-fired"`, reproducible). Manifest, SW registration and secure context
   are all fine — the icon is the single blocker to "installable PWA" on
   Android. Fix is product-side (add a 192/512px PNG icon).
2. **Transcript container can cover the send button.** At the emulator's
   viewport, `div.min-h-0.flex-1…overscroll-contain` intercepts pointer events
   at the send button's center (Playwright hit-test evidence; retry loop
   logged). The lab force-clicks; a finger may or may not hit the same spot.
   Viewport-height sensitive — worth a look when touch issues are next
   reported.
3. **Slow-run liveness (matches the open `wedge-fix` claim).** With the model
   congested (3 concurrent agent sessions during the lab), replies landed
   server-side (`/api/session/<id>/messages` shows `{"text":"pong","done":true}`)
   1–9 min after send, while the live page sometimes failed to re-render them
   in-session; a reload always rendered the full transcript. Run 2 (quiet box)
   rendered live in 9.5 s. The flow recovers exactly like a consumer: wait,
   then reload, then assert.
4. **Unreachable LiveKit fails honestly.** The session page auto-connects the
   voice room; with the ts.net LiveKit unreachable from the Mac, the PWA shows
   `voice connect failed: signal timeout (12s)` with fix/dismiss actions and
   text flow is unaffected (send POSTs independently). Correct degradation —
   no fake success.
5. **Reply latency is model-bound, not path-bound.** Identical flow: 9.5 s on
   a quiet box, up to ~9 min with three heavy agent sessions running. Any
   consumer demo should budget for this.

## Stretch — voice round-trip: NOT POSSIBLE, documented honestly

Emulator mic passthrough forwards the **host's** audio input into the AVD.
`system_profiler SPAudioDataType` on the Mac Studio lists output devices only
(`Mac Studio Speakers`, `Default Output: Yes`) and **no input device** — the
Mac Studio has no microphone hardware. There is no host capture device to
pass through, and no product microphone loop can be exercised. A USB mic
plugged into the Mac + `emulator` without `-no-audio` would be the next
attempt; until then the verdict stands: **voice cannot be proven in this
lab**. The full voice path (LiveKit STT/TTS) was already e2e-tested outside
this lab (pwa/e2e, `uv run agent.py console`).

## Infra notes (hit during setup, none blocking)

- **brew on the Mac hangs** fetching casks (zero bytes moved, stale lock
  processes). All installs here bypass brew with direct Google/nodejs.org
  downloads. Worth a manual `brew cleanup` session someday.
- **Chrome first-run sheet** ("notifications make things easier") covers the
  page on a fresh AVD. `02-boot-avd.sh` seeds
  `/data/local/tmp/chrome-command-line` with `--no-first-run` via `adb root`
  (google_apis images are rootable); the flow also taps the sheet's
  "No thanks" spot defensively before navigation.
- `adb root`/`unroot` mid-flight can wedge adbd (`emulator-5554 offline`).
  Kill the emulator and re-run `02-boot-avd.sh` — userdata persists.
- Do not bind the tunnel to Mac :8080 (occupied by the Mac's own PWA).
- Do not run `sdkmanager` package ids with `google-apis`; the repo id is
  `google_apis` (underscores).

## Files

- `scripts/android-lab/01-mac-setup.sh` — SDK + image + AVD (runs on the Mac)
- `scripts/android-lab/02-boot-avd.sh` — headless boot + first-run seed
- `scripts/android-lab/03-run-consumer-flow.sh` — orchestrator (runs here)
- `scripts/android-lab/04-consumer-flow.mjs` — the Playwright flow
- `artifacts/android-lab/` — screenshots + `report.json` of the last run

## Screen-off mic probe (native-app-eval Rung 0) — `05-screen-off-probe`

Resolves the eval's Android TO-VERIFY ("Chrome stops WebRTC mic shortly after
screen-off") without a human. Its RED/GREEN is a Rung A trigger **input**: an
emulator RED alone never fires Rung A (needs the owner's S22 data too).

**Asserts:** Chrome launched with `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream` (no real mic on the Mac; this checks that the track
stays **live**, not that audio sounds right). It opens a fresh session, taps the mic
(hands-free), and takes its own `getUserMedia({audio:true})` track (the minimal proxy).
Then `input keyevent 26`, 60 s off, `keyevent 224` on. An init script records every
WebSocket, RTCPeerConnection and audio track with timestamped lifecycle events, so the
verdict is based on what happened *during* the window, not only the final state. A drop
followed by LiveKit's auto-reconnect still counts as a death.

| exit | line | meaning |
|---|---|---|
| 0 | `PROBE RESULT: PASS reason=…` | every audio track live and never `ended`; the LiveKit signal WS and peer connections up at screen-off never closed or dropped, no reconnect, room still connected |
| 1 | `PROBE RESULT: RED reason=track-ended:…\|room-died:…` | either one died |
| 2 | `PROBE RESULT: INCONCLUSIVE reason=…` | the lab couldn't establish the precondition (room never connected, screen never went off, setup failed). Never read as RED. |

`warn=` flags are recorded but don't change the verdict: `hands-free-not-entered`,
`muted:<i>` (track muted while off), and `no-mic-bytes-while-off` (publisher sent 0 audio
bytes during the window).

**Run:** `scripts/android-lab/05-screen-off-probe.sh` (`OFF_MS` overrides the 60 s,
`PWA_PORT` probes a privately served build instead of live :8080). Evidence lands in
`artifacts/android-lab/screen-off/`: `report.json` (pre/during/post snapshots,
events), `01-before-off.png`, `02-after-on.png`, and `diag.log` (this slug's
`pwa/.diag` lines).

**Routing LiveKit to the AVD** (new compared with 03, which only reaches the PWA):
- Signal: `ssh -R 18443 → omarchy tailscale-serve :443`, `adb reverse tcp:18443`, and
  Chrome `--host-resolver-rules=MAP omarchy.tail5435b1.ts.net 127.0.0.1:18443`. Only
  DNS is rewritten, so SNI and the cert still match. **Works**: signal connects.
- Media: LiveKit advertises `192.168.50.2` / `100.104.229.17` on `:7881` TCP and
  `:50000-50100` UDP. The Mac can't open TCP to omarchy on either path: the LAN
  firewall blocks it too, alongside the tailnet ACL from the topology section. The
  probe DNATs both TCP candidates inside the (rooted) AVD to `127.0.0.1:17881`, then
  `adb reverse` → `ssh -R` → omarchy `:7881`. Plain TCP through that chain works,
  including from Chrome's uid 10147. UDP can't ride an ssh tunnel.

**Recorded result (2026-10-04 20:33): INCONCLUSIVE (track half GREEN, room half unproven).**
- Screen went off for real (`mWakefulness=Asleep`, back to `Awake`). The probe's fake-mic
  track stayed `live`, unmuted, and had no `ended`/`mute` events across 60 s off,
  sampled every 15 s *while off*. Finding: `document.visibilityState` stayed `visible`
  during screen-off on this Chrome 113 AVD, so a `bvl` diag keyed on `visibilitychange`
  would not fire for screen-off on this build.
- The room never reached `connected`, before or after: the signal WS opened, the PC sat
  in `connecting`, and LiveKit closed the participant after 15 s (`removing participant
  without connection`; only UDP pairs listed, all `failed`, with no ICE-TCP pair even
  though Chrome's SYNs hit the DNAT rules). So the PWA's own hands-free mic never got
  published, and only the probe track was asserted.
- That run targeted the on-disk build served privately on :8097. **Live :8080 was
  broken at the time:** `.next` had been rebuilt at 19:47 without restarting `lk-pwa`,
  so the running server's HTML pointed at a session chunk that no longer exists
  (`ChunkLoadError`, the chunk returns 400). Every session page failed, phone included.
  This was left alone because a parallel e2e run was in flight.

**Remaining run step (to get a full PASS/RED):** give the AVD a working media path. In
order of cost:
1. Debug ICE-TCP: `tcpdump -i lo port 7881` on omarchy during a run, to see whether
   Chrome's STUN-over-TCP reaches LiveKit's TCP mux.
2. Or open UDP `50000-50100` + TCP `7881` on omarchy's LAN firewall for `192.168.50.1`
   only. Then the DNAT goes away and UDP host candidates connect directly.
3. Or a TURN/TCP relay on the Mac.

Then rerun `05-screen-off-probe.sh` against live :8080 (after `lk-pwa` is restarted
onto the current build). The probe is READY: the exit semantics and evidence are
final, only the media path is missing.
