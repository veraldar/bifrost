"""bifrost-lite: local voice server for the edge spike.

Speaks the exact API shapes the livekit agent already consumes:
  POST /v1/audio/transcriptions   OpenAI-compatible STT (multipart file) -> {"text": ...}
  POST /v1/audio/speech           OpenAI-compatible TTS (json) -> wav bytes
  POST /v1/audio/speech_stream    MLX-wrapper-compatible stream -> raw PCM int16 + X-Sample-Rate
  GET  /v1/models, GET /healthz

Run:  python -m uvicorn voice_server:app --host 127.0.0.1 --port 8000
Then: agent/.env -> SPEACHES_URL=http://127.0.0.1:8000/v1  (LOCAL=1, zero code change)
"""
from __future__ import annotations

import io
import os
import time
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

import sherpa_onnx

MODELS = Path(os.environ.get("EDGE_MODELS", Path(__file__).parent / "models"))
PORT = int(os.environ.get("EDGE_PORT", "8000"))
THREADS = int(os.environ.get("EDGE_THREADS", "2"))

app = FastAPI(title="bifrost-lite voice", version="0.1.0")


def _first(glob: str) -> str:
    hits = sorted(MODELS.glob(glob))
    if not hits:
        raise RuntimeError(f"missing model file: {glob} (run get_models.sh)")
    return str(hits[0])


class _STT:
    _inst = None

    @classmethod
    def get(cls):
        if cls._inst is None:
            d = MODELS / "sherpa-onnx-whisper-tiny.en"
            cls._inst = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=str(d / "tiny.en-encoder.int8.onnx"),
                decoder=str(d / "tiny.en-decoder.int8.onnx"),
                tokens=str(d / "tiny.en-tokens.txt"),
                language="en",
                task="transcribe",
                num_threads=THREADS,
            )
        return cls._inst


class _TTS:
    _inst: dict[str, sherpa_onnx.OfflineTts] = {}

    LANGS = {
        "fr": "vits-piper-fr_FR-siwis-low",
        "en": "vits-piper-en_US-lessac-low",
    }

    @classmethod
    def get(cls, lang: str) -> sherpa_onnx.OfflineTts:
        lang = "fr" if lang.lower().startswith("fr") else "en"
        if lang not in cls._inst:
            d = MODELS / cls.LANGS[lang]
            vits = sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(next(d.glob("*.onnx"))),
                tokens=str(d / "tokens.txt"),
                data_dir=str(d / "espeak-ng-data") if (d / "espeak-ng-data").is_dir() else "",
            )
            cfg = sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=THREADS, provider="cpu"))
            cls._inst[lang] = sherpa_onnx.OfflineTts(config=cfg)
        return cls._inst[lang]


def _lang_of(voice: str | None, lang: str | None) -> str:
    for probe in (voice or "", lang or ""):
        p = probe.lower()
        if p.startswith("fr") or "elise" in p or "siwis" in p:
            return "fr"
        if p.startswith("en") or "heart" in p or "lessac" in p or "amy" in p:
            return "en"
    return os.environ.get("EDGE_TTS_LANG", "fr")


def _to_pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(_to_pcm16(samples))
    return buf.getvalue()


def _decode_audio(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data), "rb") as w:
        rate = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise HTTPException(400, f"unsupported sample width {width}")
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, rate


def _resample(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or len(x) == 0:
        return x.astype(np.float32)
    n = int(len(x) * dst / src)
    idx = np.clip((np.arange(n) * src / dst).astype(int), 0, len(x) - 1)
    return x[idx].astype(np.float32)


@app.get("/healthz")
def healthz():
    return {"ok": True, "models": str(MODELS), "langs": list(_TTS.LANGS)}


@app.get("/v1/models")
def models():
    return {"data": [{"id": "local-zipformer-en-20M"}, {"id": "local-vits-fr-siwis"},
                     {"id": "local-vits-en-lessac"}]}


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), model: str = "local-zipformer-en-20M"):
    data = await file.read()
    t0 = time.perf_counter()
    x, rate = _decode_audio(data)
    x = _resample(x, rate, 16000)
    if x.size == 0:
        return JSONResponse({"text": ""})
    rec = _STT.get()
    stream = rec.create_stream()
    stream.accept_waveform(16000, x)
    rec.decode_stream(stream)
    dt = time.perf_counter() - t0
    dur = len(x) / 16000.0
    return JSONResponse({"text": stream.result.text.strip(),
                         "_rtf": round(dt / max(dur, 1e-3), 3), "_dur_s": round(dur, 2)})


class SpeechIn(BaseModel):
    input: str = ""
    text: str = ""
    model: str = "local-vits"
    voice: str | None = None
    lang: str | None = None
    speed: float = 1.0
    response_format: str = "wav"


@app.post("/v1/audio/speech")
def speech(body: SpeechIn):
    text = (body.input or body.text).strip()
    if not text:
        raise HTTPException(400, "empty input")
    lang = _lang_of(body.voice, body.lang)
    t0 = time.perf_counter()
    audio = _TTS.get(lang).generate(text, sid=0, speed=body.speed)
    gen = time.perf_counter() - t0
    dur = len(audio.samples) / max(audio.sample_rate, 1)
    wav = _wav_bytes(audio.samples, audio.sample_rate)
    return Response(wav, media_type="audio/wav",
                    headers={"X-Gen-Seconds": f"{gen:.2f}", "X-Audio-Seconds": f"{dur:.2f}",
                             "X-Rtf": f"{gen / max(dur, 1e-3):.3f}", "X-Lang": lang})


@app.post("/v1/audio/speech_stream")
def speech_stream(body: SpeechIn):
    text = (body.input or body.text).strip()
    if not text:
        raise HTTPException(400, "empty input")
    lang = _lang_of(body.voice, body.lang)
    audio = _TTS.get(lang).generate(text, sid=0, speed=body.speed)
    pcm = _to_pcm16(audio.samples)
    return Response(pcm, media_type="application/octet-stream",
                    headers={"X-Sample-Rate": str(audio.sample_rate), "X-Lang": lang})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
