#!/usr/bin/env bash
# boot the bifrost-lab AVD headless and wait for full boot. idempotent.
# runs ON the Mac: ssh mac 'bash -s' < 02-boot-avd.sh
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
export PATH="$SDK/platform-tools:$SDK/emulator:$PATH"
AVD_NAME="${AVD_NAME:-bifrost-lab}"

adb start-server >/dev/null 2>&1 || true

if adb devices | grep -q "emulator.*device$"; then
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    echo "already booted"; adb devices; exit 0
  fi
else
  echo "launching emulator..."
  nohup emulator -avd "$AVD_NAME" \
    -no-window -no-audio -no-boot-anim -no-snapshot \
    -gpu swiftshader_indirect -memory 4096 -cores 6 \
    > "$HOME/Library/Android/sdk/emulator-lab.log" 2>&1 &
fi

adb wait-for-device
for i in $(seq 1 120); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 3
done
[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] || { echo "FATAL: boot timeout"; exit 1; }

echo "== suppress chrome first-run (command-line seed, google_apis is rootable)"
adb root >/dev/null 2>&1 || true
sleep 3
adb wait-for-device
adb shell 'echo "chrome --no-first-run --no-default-browser-check" > /data/local/tmp/chrome-command-line'
adb shell cat /data/local/tmp/chrome-command-line
adb unroot >/dev/null 2>&1 || true
sleep 3
adb wait-for-device
adb reconnect offline >/dev/null 2>&1 || true
sleep 2

echo "booted: $(adb shell getprop ro.build.version.release | tr -d '\r') $(adb devices | grep emulator)"
echo "== chrome check"
adb shell pm list packages | grep -iE "chrome|webview" || echo "NO-CHROME-PACKAGE"
