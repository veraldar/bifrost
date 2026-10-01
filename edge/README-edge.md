# edge — bifrost-lite (local voice server)

The phone-only thesis, in one directory: the same Linux userspace serves STT and
TTS locally with the exact API shapes the livekit agent already consumes, so
`LOCAL=1` is an env change, not a code change. Repo-level rationale:
`artifacts/bifrost-on-raw-device.md`.

## What speaks what

| Endpoint | Shape | Consumer |
|---|---|---|
| `POST /v1/audio/transcriptions` | OpenAI-compatible (multipart → `{"text"}`) | agent `openai.STT(base_url=SPEACHES_URL)` (agent.py:232) |
| `POST /v1/audio/speech` | OpenAI-compatible (json → wav) | agent `openai.TTS(...)` (agent.py:234) |
| `POST /v1/audio/speech_stream` | MLX-wrapper-compatible (raw PCM int16 + `X-Sample-Rate`) | PWA listen deck (`/api/tts/stream`) |

One dependency for everything: **sherpa-onnx** (wheels for x86_64 and aarch64;
1.13.8 also exposes `from_moonshine_v2` and `from_qwen3_asr` — the quality
upgrade path, not yet wired). Models: whisper tiny.en int8 (STT), piper
siwis-low FR + lessac-low EN (TTS), silero VAD (fetched, not wired yet). All
MIT/Apache. ~200MB, fetched by `get_models.sh`, never committed.

## Run (this box)

```bash
uv venv edge/.venv --python 3.13 && uv pip install --python edge/.venv/bin/python -r edge/requirements.txt
bash edge/get_models.sh
EDGE_PORT=8100 edge/.venv/bin/python -m uvicorn --app-dir edge voice_server:app --host 127.0.0.1 --port 8100
edge/.venv/bin/python edge/verify_edge.py http://127.0.0.1:8100
```

`LOCAL=1` wiring = `agent/.env`: `SPEACHES_URL=http://127.0.0.1:8000/v1`
(server defaults to port 8000; `EDGE_PORT` overrides).

## Run (spare Android phone, Termux)

F-Droid Termux → `pkg install git` → `bash edge/termux-setup.sh`. No root, no
ROM, no store app. Then point a copy of the agent (or just test the server) at
`127.0.0.1:8000`.

## Measured (x86_64 dev box, 5700U, CPU-only, 2 threads)

- STT whisper tiny.en int8: RTF **0.29** — full-sentence round-trip with punctuation
- TTS piper low (fr + en): RTF **0.26-0.37** — first audio ~1s
- `verify_edge.py`: 7/7 PASS

## Honest limits (spike scope)

- **French STT is absent** — the known gap (report: no good small open streaming
  fr ASR). Next steps: sherpa `from_moonshine_v2` (no fr yet) or `from_qwen3_asr`
  (fr yes, bigger), or whisper-small multilingual (~250MB).
- Voice quality is piper-tier, below Mac Elise/Qwen3 by design — this tier buys
  offline resilience, not the best voice.
- x86 numbers ≠ phone numbers: the RTF/battery measurement on real arm64 silicon
  is the remaining half of the spike (needs the physical phone).
- No NPU paths here (CPU only) — see `artifacts/going-lower-voice-stack.md` for
  the QNN/ANE ladder.
