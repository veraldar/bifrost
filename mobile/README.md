# Bifrost mobile (Capacitor wrap)

The app is a thin native shell over the SERVER — **hot reload**: web/app
changes deploy from the server and reach installed phones with NO reinstall.
The APK only updates when native code (telemetry, plugins) changes.

## What ships

- `android/` — Capacitor Android project (`org.veraldar.bifrost`).
  Remote URL mode: loads `<server>` from `capacitor.config.json`
  (`server.url`, cleartext allowed for LAN; point it at the LAN address or
  the bifrost-net access point when deployed).
- `ios/` — Capacitor iOS project (same remote mode). Generated; needs the
  Mac's Xcode first-launch + the iOS simulator runtime (see iOS below).
- Native telemetry (hard requirement): `MainActivity.java` routes native
  crashes, ANR suspects (main thread >5s), and permission denials into the
  app's own `/api/diag` pipeline — the fleet loop reads them. Web-layer
  errors already flow via `lib/diag.ts`.

## Android — build

```sh
# on a Mac with JDK 17 + Android SDK (android-lab setup):
cd mobile
npm install --legacy-peer-deps   # @capacitor/cli, @capacitor/android
npx cap sync android
cd android && JAVA_HOME=$(".../jdk17/Contents/Home") ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk (~3.7MB)
```

Known trap: the Mac's default JDK (25) breaks Gradle 8.2 ("class file major
version 69") — pin JDK 17.

## Android — test on the android-lab emulator

```sh
adb install -r app-debug.apk
adb reverse tcp:8090 tcp:18081        # emulator → server tunnel
adb shell am start -n org.veraldar.bifrost/.MainActivity
```

The tree door renders; tap → hands-free onboarding (mic audio on the
emulator needs a lab build: `?labmic=1` / the `labmic` localStorage flag
injects USER-AGI's wav — production phones use the real mic).

## iOS — status (documented, not built tonight)

The project is generated (`ios/`, Podfile). Building needs, ON THE MAC, as
the logged-in user (admin auth — cannot be automated over ssh):

1. `xcodebuild -runFirstLaunch` (accepts the license, installs components)
2. `xcodebuild -downloadPlatform iOS` (the simulator runtime; Apple auth)
3. `brew install cocoapods && cd mobile/ios/App && pod install`
4. Sim build: `xcodebuild -workspace App.xcworkspace -scheme App \
   -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' build`
5. Device/TestFlight: add a signing team in Xcode, then archive.

## Server-side lab flag

`?labmic=1` (or the `labmic` localStorage flag, set at onboarding start in
lab builds): the page injects USER-AGI's wav (`/user-agi.wav`) as the
microphone via Web Audio — the deterministic voice-loop driver. Production
phones never set it.
