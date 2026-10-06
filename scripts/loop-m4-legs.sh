#!/usr/bin/env bash
# AGI-LOOP legs: real STT (production Mac MLX) on USER-AGI's voice, real brain turns
# through the sandbox app's own proxy, real TTS receipts of the replies.
set -euo pipefail
cd /tmp/opencode/agi-loop
STT=http://192.168.50.1:8001/v1
APP=http://127.0.0.1:8090
# per-question wavs from the pcm stems
for i in 1 2 3; do
  python3 - "$i" <<'PY'
import wave, sys
i = sys.argv[1]
w = wave.open(f'q{i}.wav','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(open(f'raw{i}.pcm','rb').read()); w.close()
PY
done
MAIN=$(curl -s -X POST $APP/api/session -H 'content-type: application/json' -d '{"title":"agi-loop"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "loop session: $MAIN" | tee loop-metrics.json
echo "{" > loop-metrics.json
i=1
for Q in "What is the capital of France?" "Give me one tip to sleep better tonight." "Say something kind about my day."; do
  T0=$(date +%s%3N)
  TRANSCRIPT=$(curl -s -m 60 -X POST $STT/audio/transcriptions -F file=@q$i.wav 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("text","").strip())' || echo "STT-FAIL")
  T1=$(date +%s%3N)
  RESP=$(curl -s -m 180 -X POST $APP/api/session/$MAIN/messages -H 'content-type: application/json' -d "{\"text\":\"$TRANSCRIPT\"}")
  T2=$(date +%s%3N)
  REPLY=$(echo "$RESP" | python3 -c '
import sys,json
d=json.load(sys.stdin)
def texts(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=="text" and isinstance(v,str): yield v
            else: yield from texts(v)
    elif isinstance(o,list):
        for x in o: yield from texts(x)
import json as j
d2=j.loads(json.dumps(d))
print((d2.get("text") if isinstance(d2,dict) else None) or " ".join(texts(d2))[:600])' 2>/dev/null || echo "REPLY-PARSE-FAIL")
  T3=$(date +%s%3N)
  curl -s -m 90 -X POST $APP/api/tts/stream -H 'content-type: application/json' -d "{\"text\":\"$REPLY\"}" -o reply$i.raw 2>/dev/null || true
  echo "{\"turn\":$i,\"question\":\"$Q\",\"stt_text\":\"$TRANSCRIPT\",\"stt_ms\":$((T1-T0)),\"brain_ms\":$((T2-T1)),\"reply\":\"$REPLY\",\"tts_ms\":$((T3-T2))}," >> loop-metrics.json
  echo "turn $i: stt=${TRANSCRIPT:0:40} | reply=${REPLY:0:60}"
  i=$((i+1))
done
sed -i '$ s/,$//' loop-metrics.json && echo "}" >> loop-metrics.json
python3 -c "import json;json.load(open('loop-metrics.json'));print('metrics JSON valid')"
