#!/usr/bin/env bash
# idempotent headless Android SDK install for the bifrost android-lab.
# runs ON the Mac Studio (or any arm64 macOS box): ssh mac 'bash -s' < 01-mac-setup.sh
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
BIN="$SDK/cmdline-tools/latest/bin"
CLT_ZIP="https://dl.google.com/android/repository/commandlinetools-mac-13114758_latest.zip"
PT_ZIP="https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
IMAGE="system-images;android-34;google_apis;arm64-v8a"
AVD_NAME="${AVD_NAME:-bifrost-lab}"

export JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null)"
[ -x "$JAVA_HOME/bin/java" ] || { echo "FATAL: no JDK (brew install --cask temurin)"; exit 1; }

mkdir -p "$SDK/cmdline-tools" "$SDK/dl"

fetch() {
  local url="$1" out="$2"
  [ -s "$out" ] && { echo "cached: $out"; return; }
  curl -fL --retry 3 --retry-delay 3 -C - -o "$out" "$url"
}

echo "== cmdline-tools"
fetch "$CLT_ZIP" "$SDK/dl/clt.zip"
[ -x "$BIN/sdkmanager" ] || {
  rm -rf "$SDK/dl/clt-x"; unzip -q "$SDK/dl/clt.zip" -d "$SDK/dl/clt-x"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$SDK/dl/clt-x/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$SDK/dl/clt-x"
}

echo "== platform-tools"
fetch "$PT_ZIP" "$SDK/dl/pt.zip"
[ -x "$SDK/platform-tools/adb" ] || unzip -qo "$SDK/dl/pt.zip" -d "$SDK"

echo "== licenses"
yes | "$BIN/sdkmanager" --licenses > /dev/null 2>&1 || true

echo "== emulator + system image ($IMAGE)"
"$BIN/sdkmanager" --install emulator "$IMAGE" 2>&1 | tail -2

echo "== AVD $AVD_NAME"
echo no | "$BIN/avdmanager" create avd -n "$AVD_NAME" -k "$IMAGE" -d pixel_6 --force

"$BIN/avdmanager" list avd | sed -n '1,8p'
echo "== setup DONE: $SDK"
