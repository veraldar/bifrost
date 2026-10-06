# bifrost shell (Android) — the wrap APK

A minimal Android app that loads the bifrost PWA in a WebView and holds the
microphone permission natively. It is a lab build, not a release. It is
driven live by ygg-sim (`lab/ygg-sim`, the `app.*` scenarios) on a headless
emulator on this box.

| piece | what it does |
|---|---|
| `app/src/main/java/net/bifrost/shell/MainActivity.java` | WebView + pairing deep link + mic grant (paired origin only) + `BifrostNative.notify` |
| `app/src/main/AndroidManifest.xml` | INTERNET, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, POST_NOTIFICATIONS; `bifrost://` deep link |
| `app/src/main/res/xml/network_security_config.xml` | HTTPS everywhere; cleartext only for loopback (`adb reverse`) |
| `setup-sdk.sh` | user-space toolchain (no root): JDK 21, SDK, build-tools, android-36 image, AVD `ygg-sim` |
| `build.sh` | hand build, no Gradle: aapt2 → javac → d8 → zipalign → apksigner |

```bash
pwa/android/setup-sdk.sh          # once (~8 GB with the emulator image; SKIP_IMAGE=1 to only build)
pwa/android/build.sh              # → app/build/outputs/apk/debug/app-debug.apk (~21 KB, gitignored)
cd lab/ygg-sim && cargo run -q --release -- matrix --only app.   # boots its own AVD, runs, shuts it down
```

## Contracts

- **Pairing**: `bifrost://pair?token=<raw>&url=<pwa url>&bridge=<bridge url>`.
  The shell stores the pairing and verifies the token natively with
  `POST {bridge}/offer` and a Bearer header. The bridge answers 401 for a
  refused token and 400 for an accepted token (the empty SDP fails after
  auth passes). It then hands the token to the page through the PWA's own
  contract: `localStorage` `bifrost_device` and `bifrost_bridge`
  (`pwa/app/pair`, `pwa/app/bridge`). A native verify also avoids the CORS
  preflight that a page-side fetch to the bridge needs.
- **Mic**: the app holds RECORD_AUDIO. WebView audio capture is granted only
  to the paired origin, and video is never granted.
- **Navigation**: off-origin links open in the browser, so a foreign page
  never sits inside the shell with the mic.
- **Logs**: every step writes one `BIFROST_*` line under the logcat tag
  `BifrostShell`. The sim asserts on these lines.

## What the sim measured (cycle 6, emulator: Android 16, WebView 133)

| scenario | result |
|---|---|
| `app.install-pair` | PASS. Install, then deep-link pair, then the real bridge accepts (400), the page gets the token, and a wrong token reads 401 |
| `app.hot-reload` | PASS. A new bundle on the box reaches the app on its next start (~1.7 s), and pairing survives |
| `app.push-notification` | BREAK-OK. WebView has no `PushManager` and no `Notification`, so the PWA's Web Push cannot reach a wrapped app. The native notify bridge does post |
| `app.background-audio` | BREAK-OK. At screen-off, Android silences the shell's recorder (`RECORD_AUDIO` is while-in-use). The page cannot see it: the track stays live and unmuted while frames keep counting zeros. The mic comes back on wake |

## Design note — the app's path to "more control on bifrost-net" (not built)

The two BREAK-OKs above are what a plain wrap cannot fix. The v0.8 rung
(docs/STABLE.md, "bridge + app") adds two native pieces behind the same
WebView UI:

1. **A foreground service of type `microphone`.** Declare
   `FOREGROUND_SERVICE_MICROPHONE`, and start the service while the app is
   visible: Android 14+ refuses a mic FGS that starts from the background.
   The service owns capture (`AudioRecord`, source `VOICE_COMMUNICATION`,
   platform AEC and NS) and posts an ongoing "bifrost is listening"
   notification with mute and stop actions. Hands-free then survives
   screen-off and pocket use.
   *Sim gate:* `app.background-audio` flips BREAK-OK → PASS when
   `RecordActivityMonitor` shows `silenced:false` through a 20 s screen-off.
2. **A native bifrost-net client inside that service (the v0.8 transport).**
   This is the client half of `lab/bifrost-net`: str0m WebRTC, the `app`
   data channel and the device token, compiled for Android with
   `cargo-ndk` and exposed through uniffi/JNI. The service holds the bridge
   connection, and the WebView becomes a view that calls the service over a
   JS interface (`prompt`, `transcript`, `voice state`) instead of opening
   its own peer connection. That gives the app the control the browser
   never had:
   - **Network changes**: `ConnectivityManager` callbacks trigger a
     re-signal or ICE restart on Wi-Fi/cell handover. This fixes the
     `bridge.nat-rebind` BREAK-OK at the client.
   - **Pacing**: client-side Opus pacing and bitrate per network class.
     This is the sim's no-BWE law (`bridge.bandwidth-starved` vs
     `paced-uplink-starved`).
   - **Token storage**: the token lives in the Android Keystore and never
     touches page `localStorage`. Revocation means the next request fails
     and the app re-pairs.
   - **Notices while active**: `run.done` and `voice.reply` arrive on the
     service's data channel and become native notifications. When the app
     is closed, push needs FCM, or UnifiedPush for a self-hosted, no-Google
     setup.

   *Sim gate:* a new `app.bridge-native` scenario. The service pairs, then
   holds the data channel to the sim's bridge with the screen off, and a
   prompt's tool loop completes. That is `bridge.tool-loop`, run from the
   phone side.
3. **Order**: after the v0.8 bridge gates. These are the native-app-eval's
   Rung A pieces (docs/reviews/native-app-eval.md). Each piece lands with
   its sim scenario first.

## What an emulator cannot prove

The real mic and AEC, OEM battery and Doze policies (Samsung One UI),
Bluetooth/car routing, and the owner's Chrome profile (a saved "Never allow"
on an origin is per origin, port included). The owner's S22 closes that gap,
and the same probes can run on it over adb.
