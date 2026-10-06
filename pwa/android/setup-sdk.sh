#!/usr/bin/env bash
# setup-sdk.sh — user-space Android toolchain for the bifrost wrap (no root, no Gradle).
#
# Installs (idempotent) into $HOME, never into the repo:
#   JDK 21 (Temurin)        → ${BIFROST_JDK:-$HOME/.local/share/bifrost-android/jdk-21}
#   Android SDK             → ${ANDROID_HOME:-$HOME/Android/Sdk}
#     cmdline-tools, platform-tools, emulator, build-tools, platforms;android-$API,
#     system-images;android-$API;google_apis;x86_64 (KVM-capable, bundles Chrome)
#   AVD "${AVD_NAME:-ygg-sim}" (headless, used by ygg-sim app.* scenarios)
#
# Env: API (default 36), BUILD_TOOLS (default 36.0.0), SKIP_IMAGE=1 (no emulator image).
set -euo pipefail

API="${API:-36}"
BUILD_TOOLS="${BUILD_TOOLS:-36.0.0}"
AVD_NAME="${AVD_NAME:-ygg-sim}"
ROOT="$HOME/.local/share/bifrost-android"
JDK="${BIFROST_JDK:-$ROOT/jdk-21}"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
CLT_ZIP="commandlinetools-linux-16111833_latest.zip"
mkdir -p "$ROOT" "$SDK"

say() { printf '[setup-sdk] %s\n' "$*"; }

# 1. JDK 21 (the system may only carry a JRE; javac is needed for the shell)
if [ ! -x "$JDK/bin/javac" ]; then
  say "JDK 21 → $JDK"
  tmp="$ROOT/jdk.tar.gz"
  curl -fsSL -o "$tmp" "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
  rm -rf "$JDK.part" && mkdir -p "$JDK.part"
  tar -xzf "$tmp" -C "$JDK.part" --strip-components=1
  rm -rf "$JDK" && mv "$JDK.part" "$JDK" && rm -f "$tmp"
fi
export JAVA_HOME="$JDK" PATH="$JDK/bin:$PATH"
say "javac: $(javac -version 2>&1)"

# 2. cmdline-tools
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  say "cmdline-tools → $SDK/cmdline-tools/latest"
  curl -fsSL -o "$ROOT/$CLT_ZIP" "https://dl.google.com/android/repository/$CLT_ZIP"
  rm -rf "$SDK/cmdline-tools/latest" "$ROOT/clt" && mkdir -p "$SDK/cmdline-tools" "$ROOT/clt"
  (cd "$ROOT/clt" && unzip -q "../$CLT_ZIP")
  mv "$ROOT/clt/cmdline-tools" "$SDK/cmdline-tools/latest" && rm -rf "$ROOT/clt" "$ROOT/$CLT_ZIP"
fi
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"

# 3. packages
yes | "$SDKM" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
pkgs=("platform-tools" "build-tools;$BUILD_TOOLS" "platforms;android-$API")
if [ "${SKIP_IMAGE:-0}" != 1 ]; then
  pkgs+=("emulator" "system-images;android-$API;google_apis;x86_64")
fi
say "sdkmanager ${pkgs[*]}"
"$SDKM" --sdk_root="$SDK" "${pkgs[@]}" | grep -v '^\[=*' || true

# 4. AVD (headless profile; userdata persists across boots)
if [ "${SKIP_IMAGE:-0}" != 1 ] && [ ! -d "$HOME/.android/avd/$AVD_NAME.avd" ]; then
  say "AVD $AVD_NAME (android-$API google_apis x86_64)"
  echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD_NAME" \
    -k "system-images;android-$API;google_apis;x86_64" -d pixel_6 --force >/dev/null
  cfg="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  # small, fast, mic-capable (hw.audioInput stays yes: the virtual mic is the probe surface)
  sed -i -e 's/^hw.ramSize=.*/hw.ramSize=3072/' -e 's/^hw.keyboard=.*/hw.keyboard=yes/' "$cfg" || true
  grep -q '^hw.audioInput' "$cfg" || echo 'hw.audioInput=yes' >> "$cfg"
fi
say "OK — ANDROID_HOME=$SDK JAVA_HOME=$JDK AVD=$AVD_NAME"
