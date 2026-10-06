#!/usr/bin/env bash
set -euo pipefail
cd /home/dweeb_xyz/Work/bifrost-sandbox/mobile
[ -d node_modules ] || npm install --no-audit --no-fund 2>&1 | tail -1
[ -d android ] || npx cap add android 2>&1 | tail -2
M=android/app/src/main/AndroidManifest.xml
grep -q RECORD_AUDIO $M || sed -i 's|<uses-permission android:name="android.permission.INTERNET" />|<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n    <uses-permission android:name="android.permission.CAMERA" />|' $M
grep -q usesCleartextTraffic $M || sed -i 's|<application|<application android:usesCleartextTraffic="true"|' $M
grep -c 'uses-permission' $M
grep -o 'usesCleartextTraffic="true"' $M
echo "android project ready"
