# Native Android/iOS for bifrost — evaluation + decision (NATIVE-EVAL, 10-04)

Owner question (ses_f28e2fdf 10-04): *"would a native android/ios app help"* → *"if native app fit better in
the scenario then we go there, it's agis call"*. This is that call.

## Verdict

**PWA-only through v1.0 — no re-sequencing. Then a *voice-native shell*, Android first, only on a trigger.**

1. **Now (inside the ladder, ~1 build-day, no new lane):** fix the PWA-side pains that native would *not* be needed
   for (push urgency, keep-awake during hands-free, honest lock-screen known-limit) and **instrument** background
   voice loss + push delivery so the next rung fires on data, not taste.
2. **Rung A — Android voice shell (sideload, owner-only):** Capacitor shell that renders the *same* PWA UI, plus a
   native voice plugin (LiveKit Android SDK + Telecom/ConnectionService + foreground mic service). Fires when the
   trigger below hits, **not before v0.9.0 is tagged** (transport + S1 tokens frozen). Parallel lab lane, never gates.
3. **Rung B — iOS voice shell (TestFlight, internal testers):** same shape with LiveKit Swift + CallKit. Fires only on
   the layman-gate ledger or inbound-ask bar below. Public App Store: post-v1.1 at the earliest, never gates a wave.
4. **Rejected:** plain Capacitor wrap (voice still runs in the webview = the same browser stack, and on iOS a
   WKWebView cannot hand its WebRTC audio to CallKit); full React Native/Swift/Kotlin rewrite (re-implements the
   frozen v0.6.0 design twice for zero voice gain over the shell).

Why this shape: the one pain only native fixes is **screen-off / pocket / car hands-free + call-like UX** — and it is
an iOS-hard, Android-soft problem. Everything else the owner actually complained about lives server-side or in PWA
code we control.

> Ladder note: the mission text says "v0.8 gate"; plan.md (2b46049) merged v0.8 into **v0.9.0**. The girlfriend-iPhone
> gate is now the layman-release exit (v0.9.0/v1.0 per plan row) and re-runs at v1.0. Triggers below key on *that gate*,
> whatever its version label. **Tag scope flag (roadmap reconcile, 10-04): this repo has no tags above v0.3.1 —
> "v0.9.0 tagged" means the tag on whichever repo releases are cut from; confirm before treating any rung as armed.**

## Requirements evidence (opencode store, 178 sessions — owner's words)

| need | evidence (session · date · phrase) |
|---|---|
| reply notifications | ses_f2d393db 09-24 "Need browser notification when thinking done"; ses_f2aef95d 09-25 "**never receive notifications**" |
| hands-free in real life (car) | ses_f0f5bbcd 09-30 "back to hands free … with **Tesla**" |
| mic hygiene (OS indicator off) | ses_f2bc5115 09-24 "microphone should not be used anymore by browser"; ses_f11f5692 09-29 "turn it off when I leave" |
| turn-taking, mic muted during playback | ses_f1bb7a0c 09-28 "mic muted as long as [playback]"; ses_f125944a 09-29 "mic came back while the agent was working" |
| noisy rooms | ses_f16d4ccd 09-28 "some people around me speaking too" |
| one-button app for others | ses_f28e2fdf 09-26 "pwa app people can install on android / ios so they push a btn"; 09-27 "3. android app one btn ready" |
| layman gate | ses_f28e2fdf 10-03 "girlfriend … iPhone … with the auto setup" |

Field data (`pwa/.diag/`): all phone traffic is Android (Chrome reduced UA "Android 10" ≈ owner's S22/Android 16);
**zero iPhone sessions ever logged** — iOS behavior is untested by us. 13 unique `ctx state → suspended` events
(18 raw; per-tab double-logging, verified) confirm the WebAudio-on-lock failure already documented in
`docs/tts-voice.md` (fixed by native `<audio>` playback). Push-send failures are NOT yet observable — the 2 unique
client `GET /api/push` timeouts in diag are net-fail, not delivery evidence; that is exactly why Rung 0 builds
delivery-ratio instrumentation. `pwa/lib/push.ts:66` sends `{ TTL: 3600 }` with **no `urgency: 'high'`** → normal priority,
batched under Doze. *(Counts amended per the Sonnet verification read — `native-app-eval-verify.md`.)*

## Fix / no-fix per pain per platform

| pain | PWA today | Capacitor wrap (webview voice) | voice-native shell |
|---|---|---|---|
| **Mic, screen locked / backgrounded — iOS** | ✗ installed web apps lose mic in background ([WebKit 226620](https://bugs.webkit.org/show_bug.cgi?id=226620), 2024 comment); tracks end after ~30s bg | ✗/contested: WKWebView mic mutes in bg even with entitlements ([Apple forum 689182](https://developer.apple.com/forums/thread/689182), [WebKit 241480](https://bugs.webkit.org/show_bug.cgi?id=241480)); WebKit dev says `UIBackgroundModes audio` fixes it (226620) — **TO-VERIFY on device** | ✓ LiveKit Swift + `audio` background mode ([LiveKit Swift audio](https://www.mintlify.com/livekit/client-sdk-swift/guides/audio-management)) |
| **Mic, screen off — Android** | ⚠ Chrome reported to stop WebRTC mic/playback shortly after screen-off ([W3C log 2020](https://lists.w3.org/Archives/Public/public-webrtc-logs/2020Mar/0129.html)) — **TO-VERIFY on S22/Chrome 2026** | ⚠ same Chromium WebView unless a foreground service holds the process — TO-VERIFY | ✓ `microphone` foreground-service type ([Android FGS types](https://developer.android.com/guide/components/fg-service-types)) |
| **Reply playback, screen locked** | ✓ native `<audio>` survives (measured, `docs/tts-voice.md`) | ✓ | ✓ |
| **Push — iOS** | ✓ only when installed to Home Screen, 16.4+; iOS 26: every Home-Screen site opens as web app, workerless push ([summary](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide), [mjtsai](https://mjtsai.com/blog/?p=49472)) | ✓ APNs | ✓ APNs |
| **Push — Android** | ⚠ rides FCM via Chrome; we send normal priority → Doze batching ([FCM priority](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority)). **Fix in PWA first** (`Urgency: high`) | ✓ FCM high | ✓ FCM high; OEM killers still apply to apps ([firebase blog](https://firebase.blog/posts/2025/04/fcm-on-android)) |
| **Echo cancellation** | ⚠ WebRTC AEC in browser; iOS Safari self-response reports ([OpenAI forum](https://community.openai.com/t/realtime-api-echo-cancellation-bug-on-ios-safari/1075890)) | ⚠ same; WKWebView gives no AVAudioSession control ([Apple forum 685268](https://developer.apple.com/forums/thread/685268)) | ✓ iOS Voice-Processing I/O (AEC+NS+AGC); Android `VOICE_COMMUNICATION` + platform AEC — TO-VERIFY per OEM |
| **"HER" call UX** (lock-screen call, BT/car HFP routing, answer from watch) | ✗ | ✗ CallKit cannot own webview audio | ✓ CallKit ([LiveKit CallKit guide](https://www.mintlify.com/livekit/client-sdk-swift/platforms/callkit-integration)); Android Telecom — LiveKit ships no ConnectionService, app wires `core-telecom` — TO-VERIFY |
| **Agent-initiated "call"** (agent rings you) | ✗ | ✗ | ✓ but iOS: every VoIP push MUST report a CallKit call or the app is killed and pushes stop ([Apple forum](https://developer.apple.com/forums/thread/117939?page=2)) — design constraint, not a blocker |
| **Storage eviction (token, heard-watermark)** | ✓ Home-Screen apps have their own use counter, no 7-day ITP wipe ([WebKit storage note](https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519)); Safari *tab* is evicted after 7 idle days | ✓ Keychain/Keystore | ✓ Keychain/Keystore |

Honest read: for **echo**, bifrost is half-duplex by owner requirement (mic muted during playback, 09-28) — AEC only
becomes load-bearing when barge-in is wanted. Echo is not a current reason to go native.

## What native does NOT fix

- **Latency / first audio** (≈4.3s streaming floor, Mac MLX) — server pipeline.
- **Stutter** — Mac single-generation reset (stutter-fix lane), not the client.
- **Stuck/wedged runs, lost sends, session confusion** — the bulk of the owner's 09-24→10-02 complaints were PWA/proxy
  logic, all fixed in web code.
- **Noisy rooms / other speakers** (09-28) — AEC removes *our* playback, not other people; that is VAD/diarization.
- **Box asleep / unreachable, pairing, NAT** — transport (v0.9.0 bifrost-net), identical for every client.
- **Android OEM battery killers** — they kill native apps too; a call-type FGS survives better, nothing is immune.
- **Install friction for the layman** — a store page is easier than "Add to Home Screen" only once it exists; TestFlight
  adds an invite + TestFlight app step. Not a v1.0 win.

## Costs (what does not compress)

| item | Android | iOS |
|---|---|---|
| account | Play $25 once — **not needed** for sideload | $99/yr Apple Developer Program, mandatory even for TestFlight |
| distribution w/o review | APK sideload; **developer verification** (ID + registered package/key) required from 2026-09-30 in 4 countries, **global 2027**; unverified = ADB/24h "advanced flow" ([THN](https://thehackernews.com/2026/06/google-sets-sept-30-deadline-for.html)) | TestFlight **internal** testers (team members, ≤100) skip beta review; external = beta review. No sideload in CH (DMA is EU-only) — TO-VERIFY for owner's residence |
| store review risk | low | **high**: 4.2 "repackaged website" is the top webview rejection ([MobiLoud](https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper)); 2.1 requires a demo account/working backend — a client for *your own box* has none → needs Apple-approved demo mode ([Fliplet](https://help.fliplet.com/providing-a-demo-account-for-apple-app-review/)) |
| build (1 day/slice) | shell + voice plugin + telecom + FCM ≈ 2–3 b | shell + LiveKit Swift + CallKit + APNs ≈ 3–4 b |
| verify (the real cost) | owner's S22 + android-lab (emulator, `adb keyevent 26` screen-off probe) | **real iPhone only** (sim has no lock/CallKit realism); every build = TestFlight processing |
| maintenance | +1 native plugin, Android target-SDK yearly bump | +1 native plugin, Xcode/iOS yearly bump, $99/yr, cert renewal |

The shell keeps UI cost ≈ 0 (the webview renders the box's PWA → brand freeze intact, version follows the box);
the native surface is **voice + push + token storage only**.

## Locked-decision compliance

- **S1:** the shell pairs through the same `/pair` QR, stores the device token in Keychain/Keystore, and calls
  `/api/token` + `/api/*` with the same bearer through the same middleware. No native-only endpoint, no bypass.
- **Ladder:** nothing moves. Rung 0 rides existing v0.9.0/v1.0 polish; rungs A/B are parallel lab lanes (playbook-
  governed) that may *never* gate a release or a wave.
- **Evidence culture:** each rung names its trigger metric (below), like the Windows ≥10-asks bar.
- **Brand:** frozen design rendered unchanged inside the shell.

## Recommended path + triggers

**Rung 0 — PWA hardening + instrumentation (now; rides the current arc, ~1b + 0.5v).**
*[EVAL-RATIFY] Status 10-04: `urgency: 'high'` + `[push] sent`/`shown` ratio LIVE (push.ts, sw.js); wake lock + `bvl`
landing in `page.tsx`. The field-data line "push.ts:66 … no `urgency: 'high'`" describes the pre-Rung-0 baseline.
Still open: Known-limits line, android-lab screen-off probe, layman-gate measurements.*
- `lib/push.ts`: `urgency: 'high'` for reply-done pushes; SW posts `push-shown` to `/api/diag` → **push delivery
  ratio** = shown/sent per device.
- Hands-free holds a Screen Wake Lock (screen stays on, dims) — the honest PWA answer for car/desk use. Support in
  installed iOS web apps — TO-VERIFY.
- New diag event **`bvl`** (background voice loss): hands-free active AND (`visibilitychange→hidden` OR local track
  `ended`/`muted`). Count per device per week.
- Known-limits line (iOS + Android): "hands-free needs the screen on; reply audio keeps playing when locked".
- android-lab: add a screen-off probe (fake mic, `adb shell input keyevent 26`, assert track live after 60s) —
  resolves the Android TO-VERIFY without a human.
- Layman-gate script gains three **recorded measurements, not pass/fail items**: (1) lock iPhone mid-hands-free →
  does the turn survive? (2) backgrounded reply → push arrives < 60s? (3) any self-response/echo loop?

**Rung A — Android voice shell fires when ALL of:** v0.9.0 tagged (tokens + transport frozen) AND ONE of:
(a) owner `bvl` ≥ 3/week on the S22 after Rung 0 (an android-lab screen-off RED only *corroborates* — an emulator RED
alone never fires it), or (b) push delivery ratio < 95% over 7 days with urgency high.
*[EVAL-RATIFY] Trigger regrouped (the amended text's nesting was ambiguous). Counting rules, because the shipped
instrumentation would otherwise fire this falsely: **`bvl` counts only `page hidden while hands-free` and `mic track
ended` lines** — NOT `mic track muted` (hands-free calls `mic(false)` every playback/processing cycle by design,
`page.tsx` ~1565/1581, so `muted` logs on every turn) and NOT `wake-lock acquired/released/denied` lifecycle lines
that share the `bvl` kind. **Delivery ratio** = Σ`[push] shown` ÷ Σ`ok` from `[push] (server · sent)`, valid only with
≥ 20 sends and when `ok` counts the S22 subscription alone (the sent line is aggregated across every subscription,
emulator/stale ones included, with no device id); the SW's post-display `fetch` can fail offline, so a low ratio is a
lower bound — confirm a miss against the owner before firing.* Deliverable: sideloaded
APK on the S22, same `/pair`, e2e green + screen-off probe green.
Graduates to "offered to users" only on ≥ ~10 inbound Android-app asks (Windows bar mirror). Before the global
2027 verification wall, register as a verified developer (one-time, no review).

**Rung B — iOS voice shell fires on EITHER:** the layman gate records a lock-screen voice loss, push miss, or echo
loop on her iPhone that Rung 0 cannot fix, **or** ≥ ~10 inbound iOS asks for screen-off/CallKit after wave 3.
Distribution = TestFlight internal (her + owner on the team) — no review on the path, nothing gated. App Store
submission only after a demo-mode design exists for guideline 2.1, and only post-v1.1.

**Never:** a store review on a launch path; a native-only API; re-sequencing the ladder for native.

## What only the owner decides (validate-at-end)

All of the above is decided. The owner is consulted only where money/identity is required, and only when a rung fires:
1. **Apple Developer Program** ($99/yr, legal name/entity) — needed only if Rung B fires.
2. **Android developer verification** (government ID to Google) — needed before 2027 if Rung A ships beyond his phone.
3. End validation: the lambda test (girlfriend-iPhone + owner hands-free) reads the Rung 0 measurements; that
   ledger, not this document, fires A or B.

## Sources

[WebKit 226620](https://bugs.webkit.org/show_bug.cgi?id=226620) · [WebKit 241480](https://bugs.webkit.org/show_bug.cgi?id=241480) ·
[WebKit 252465](https://bugs.webkit.org/show_bug.cgi?id=252465) · [Apple forum 689182](https://developer.apple.com/forums/thread/689182) ·
[Apple forum 685268](https://developer.apple.com/forums/thread/685268) · [Apple forum 117939 (PushKit/CallKit)](https://developer.apple.com/forums/thread/117939?page=2) ·
[LiveKit Swift audio](https://www.mintlify.com/livekit/client-sdk-swift/guides/audio-management) · [LiveKit CallKit](https://www.mintlify.com/livekit/client-sdk-swift/platforms/callkit-integration) ·
[Android FGS types](https://developer.android.com/guide/components/fg-service-types) · [FCM priority](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority) ·
[FCM on Android](https://firebase.blog/posts/2025/04/fcm-on-android) · [iOS PWA limits](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide) ·
[iOS 26 web apps](https://mjtsai.com/blog/?p=49472) · [Safari 7-day cap](https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519) ·
[Android verification](https://thehackernews.com/2026/06/google-sets-sept-30-deadline-for.html) · [4.2 webview rejections](https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper) ·
[2.1 demo account](https://help.fliplet.com/providing-a-demo-account-for-apple-app-review/) · [Safari AEC report](https://community.openai.com/t/realtime-api-echo-cancellation-bug-on-ios-safari/1075890) ·
[Chrome Android screen-off (2020)](https://lists.w3.org/Archives/Public/public-webrtc-logs/2020Mar/0129.html)

## Ratification (EVAL-RATIFY, 10-04)

- **VERDICT: RATIFIED-WITH-EDITS.**
- **Integrity:** Both amendments hold the decision. The PWA-only verdict to v1.0, the three rungs, the "Never" line,
  and S1/ladder/brand compliance are unchanged. Correcting the push citation removed false evidence without moving a
  rung, because the push trigger always depended on Rung 0 instrumentation, not on the TimeoutErrors. The S22 clause
  tightens Rung A in the right direction. One problem appeared where the amendments meet the shipped Rung 0 code:
  Rung A now rests mainly on `bvl` counts, and as built `bvl` logs a `muted` event on every hands-free turn plus
  wake-lock lifecycle lines. Counted naively, it passes ≥ 3/week in one afternoon. That is the same false-fire the
  verification read flagged, moved from the emulator to the telemetry.
- **Edits applied (2, both tagged `[EVAL-RATIFY]`):** (1) Rung A regrouped into a clear (a)/(b) trigger, with
  exact counting rules for `bvl` (only `hidden` + `ended`) and for the delivery ratio (≥ 20 sends, S22 subscription
  only, a low ratio is a lower bound). (2) Rung 0 status note: what is live, what is landing, what is open. The
  stale push.ts:66 line now reads as the baseline. Suggested for the bvl lane (outside this doc): give lifecycle and
  `muted` lines their own diag kind so the count can't be misread.
- **Safe to hand to the consumer-app decision as-is: YES.** The verdict and rungs are sound, and with these counting
  rules no rung can fire on artifacts of its own instrumentation.

