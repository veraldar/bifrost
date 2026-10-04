#!/usr/bin/env bash
# FIX 2 receipt: /api/tts/stream with multi-paragraph reply, PROPERLY built JSON.
# The pass-1 failure was the harness (shell -d with raw newlines); this proves
# or refutes the production path with correct JSON, then asserts audio bytes.
set -euo pipefail
URL=${1:-http://192.168.1.89:8082/api/tts/stream}
python3 - "$URL" <<'PY'
import json, sys, urllib.request
url = sys.argv[1]
text = ("Here's one effective tip: **Put your phone away 30\u201360 minutes before bed.**\n\n"
        "The blue light from screens suppresses melatonin (the hormone that makes you sleepy) 😴\n\n"
        "If you want more tips — just ask.")
req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(),
                             headers={"content-type": "application/json"})
audio = urllib.request.urlopen(req, timeout=90).read()
ok = len(audio) > 10000 and not audio.lstrip().startswith(b'{')
print(f"multi-paragraph TTS: {len(audio)} bytes, audio={ok}")
assert ok, audio[:120]
PY
echo "FIX-2 PASS"
