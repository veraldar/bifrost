"""stt_edge.py — speech-to-text INSIDE the voice edge process (sim v5 seam).

Stands in for the decision "STT moves in-process": the Python voice agent
imports onnx-asr and keeps the model resident — no speaches hop, no separate
service. (The Rust bridge later: sherpa-onnx in-process, same seam.)

Protocol (stdin/stdout, one JSON object per line — the sim's SttEngine seam):
  → ready line on start:  {"ready": true, "model": ..., "load_ms": N, "rss_mb": N}
  ← request:              {"id": K, "rate": 48000, "pcm16": "<base64 mono s16le>"}
  → reply:                {"id": K, "text": "...", "ms": N, "audio_ms": N}
  ← EOF                   → exit 0

Env: YGG_SIM_STT_MODEL (default eschmidbauer/parakeet-redux-onnx — the
lab6 duel's CPU winner: WER 5.3%, RTF 0.224, 398MB fp32; English-only),
YGG_SIM_STT_QUANT (e.g. int8). Multilingual candidate for the French half of
the v0.6.2 gate: nemo-parakeet-tdt-0.6b-v3.
"""

import base64
import json
import os
import resource
import sys
import time

t0 = time.time()
try:
    import numpy as np
    import onnx_asr
except Exception as e:  # the sim reports this as a loud SKIP
    print(json.dumps({"ready": False, "error": f"import: {e}"}), flush=True)
    sys.exit(3)

MODEL = os.environ.get("YGG_SIM_STT_MODEL", "eschmidbauer/parakeet-redux-onnx")
QUANT = os.environ.get("YGG_SIM_STT_QUANT") or None  # e.g. "int8" (edge-size path)
try:
    model = onnx_asr.load_model(MODEL, quantization=QUANT)
except Exception as e:
    print(json.dumps({"ready": False, "error": f"load {MODEL}: {e}"}), flush=True)
    sys.exit(3)
# warm-up: first inference pays graph init; the edge does it at boot, not on the user's turn
model.recognize(np.zeros(16000, dtype=np.float32), sample_rate=16000)
rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
print(json.dumps({"ready": True, "model": MODEL + (f" ({QUANT})" if QUANT else ""), "load_ms": int((time.time() - t0) * 1000), "rss_mb": rss_mb}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rate = int(req.get("rate", 16000))
    pcm = np.frombuffer(base64.b64decode(req["pcm16"]), dtype=np.int16).astype(np.float32) / 32768.0
    t = time.time()
    try:
        text = model.recognize(pcm, sample_rate=rate)
        err = None
    except Exception as e:
        text, err = "", str(e)
    print(
        json.dumps({"id": req.get("id"), "text": text, "ms": int((time.time() - t) * 1000),
                    "audio_ms": int(len(pcm) * 1000 / rate), "error": err}),
        flush=True,
    )
