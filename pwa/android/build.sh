#!/usr/bin/env bash
# build.sh — hand-built debug APK for the bifrost shell (no Gradle, no network).
#   aapt2 compile/link → javac (JDK 21, --release 11) → d8 → zipalign → apksigner
# Output: app/build/outputs/apk/debug/app-debug.apk (the path ygg-sim's src/app.rs
# looks for). Toolchain: ./setup-sdk.sh (SKIP_IMAGE=1 is enough to build).
# Exit 3 = BLOCKED (a tool is missing; the line names it).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
JDK="${BIFROST_JDK:-$HOME/.local/share/bifrost-android/jdk-21}"
API="${API:-36}"
BT="${BUILD_TOOLS:-36.0.0}"
VERSION_NAME="0.1.0"   # keep in sync with MainActivity.VERSION
VERSION_CODE=1

B="$SDK/build-tools/$BT"
JAR="$SDK/platforms/android-$API/android.jar"
SRC="$HERE/app/src/main"
OUT="$HERE/app/build"
KS="${BIFROST_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"

for t in "$B/aapt2" "$B/d8" "$B/zipalign" "$B/apksigner" "$JAR" "$JDK/bin/javac" "$JDK/bin/keytool"; do
  [ -e "$t" ] || { echo "BLOCKED: missing $t — run $HERE/setup-sdk.sh"; exit 3; }
done
export JAVA_HOME="$JDK" PATH="$JDK/bin:$PATH"

rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/outputs/apk/debug"

"$B/aapt2" compile --dir "$SRC/res" -o "$OUT/res.zip"
"$B/aapt2" link -I "$JAR" --manifest "$SRC/AndroidManifest.xml" -o "$OUT/unsigned.apk" \
  --java "$OUT/gen" --min-sdk-version 26 --target-sdk-version 35 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" --debug-mode "$OUT/res.zip"

mapfile -t SOURCES < <(find "$SRC/java" "$OUT/gen" -name '*.java')
javac --release 11 -nowarn -encoding UTF-8 -cp "$JAR" -d "$OUT/classes" "${SOURCES[@]}"

mapfile -t CLASSES < <(find "$OUT/classes" -name '*.class')
"$B/d8" --debug --min-api 26 --lib "$JAR" --output "$OUT/dex" "${CLASSES[@]}"
(cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex)

"$B/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" \
    -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi
APK="$OUT/outputs/apk/debug/app-debug.apk"
"$B/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out "$APK" "$OUT/aligned.apk"
"$B/apksigner" verify "$APK"
echo "APK $APK ($(stat -c %s "$APK") bytes, versionName $VERSION_NAME)"
