"""OpenAI-compatible speech server on MLX (Metal) for the Mac Studio.

Endpoints (subset used by the LiveKit agent):
  POST /v1/audio/speech          {model?, voice?, input, instruct?} -> audio/wav
  POST /v1/audio/transcriptions  multipart(file, model?)             -> {"text": ...}
  GET  /health                                                       -> "OK"

Defaults: TTS = Kokoro-82M (fast), STT = whisper-large-v3-turbo (accurate).
Pass "model" to try others already in the HF cache (e.g. Qwen3-ASR, Qwen3-TTS).
Generation is serialized (MLX single-device semantics).
"""

import os
import tempfile
import glob
import threading
import time


def _warmup() -> None:
    """Pre-load TTS + STT models so first real call is fast."""
    time.sleep(2)
    try:
        out_dir = tempfile.mkdtemp(prefix="mlx_warm_")
        generate_audio(
            text="Hello.",
            model=_cached_model(DEFAULT_TTS),
            output_path=out_dir,
            audio_format="wav",
            join_audio=True,
            verbose=False,
            ref_audio=REF_AUDIO if "base" in DEFAULT_TTS.lower() else None,
            ref_text=REF_TEXT if "base" in DEFAULT_TTS.lower() else None,
        )
        wav = os.path.join(out_dir, "audio.wav")
        if os.path.isfile(wav):
            generate_transcription(model=DEFAULT_STT, audio=wav, format="json", verbose=False)
        print("[warmup] models loaded", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[warmup] failed: {e}", flush=True)

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse

os.chdir(os.path.expanduser("~/voice-stack"))

from mlx_audio.stt.generate import generate_transcription
from mlx_audio.tts.generate import generate_audio

DEFAULT_TTS = "cr2k2/Qwen3-TTS-12Hz-1.7B-Base-fp32"
DEFAULT_STT = "mlx-community/Qwen3-ASR-1.7B-8bit"
DEFAULT_INSTRUCT = "A warm, clear, neutral voice, calm and professional, moderate pace"
REF_AUDIO = os.path.expanduser("~/voice-stack/ref_voice.wav")
REF_TEXT = "I am your coding assistant. All systems nominal."

app = FastAPI()
_lock = threading.Lock()
threading.Thread(target=_warmup, daemon=True).start()

# Voice anchors: a chunk synthesized with the VoiceDesign model can be saved
# here (body: save_anchor=<id>) and later used as a cloning reference
# (body: ref_audio=<id>, ref_text=<transcript>) so every chunk of a message —
# and every message of a session — keeps the SAME speaker, gender and tone.
ANCHOR_DIR = os.path.expanduser("~/voice-stack/anchors")
os.makedirs(ANCHOR_DIR, exist_ok=True)

import base64
import wave as _wave

import numpy as np
import mlx.core as mx

# The Base checkpoint carries the ECAPA speaker encoder — used to verify that
# generated chunks keep the SAME speaker (cosine gate) for the TTS deck.
EMBED_MODEL = "cr2k2/Qwen3-TTS-12Hz-1.7B-Base-fp32"


def _embed_wav(path: str):
    """Unit-normalized speaker embedding of a wav file, or None."""
    try:
        m = _cached_model(EMBED_MODEL)
        if getattr(m, "speaker_encoder", None) is None:
            return None
        with _wave.open(path) as w:
            sr = w.getframerate()
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        e = m.extract_speaker_embedding(mx.array(x), sr=sr)
        v = np.array(e, dtype=np.float32).flatten()
        n = float(np.linalg.norm(v))
        if n <= 0:
            return None
        return v / n
    except Exception as e:  # noqa: BLE001
        print(f"[tts-emb] embed failed: {e}", flush=True)
        return None


# Model cache: generate_audio reloads weights from disk on EVERY call
# ("Fetching 12 files" per request, ~1-2s). Keep loaded modules per repo —
# they're immutable, so caching is safe; the generate lock serializes use.
_model_cache: dict = {}


def _cached_model(name: str):
    key = str(name)
    m = _model_cache.get(key)
    if m is None:
        from mlx_audio.tts.utils import load_model

        m = load_model(model_path=key)
        _model_cache[key] = m
    return m


def _gc_anchors(max_age_s: int = 3600) -> None:
    now = time.time()
    for name in os.listdir(ANCHOR_DIR):
        p = os.path.join(ANCHOR_DIR, name)
        try:
            if now - os.path.getmtime(p) > max_age_s:
                os.unlink(p)
        except OSError:
            pass


@app.get("/health")
def health() -> str:
    return "OK"


@app.post("/v1/audio/speech")
def speech(body: dict):
    text = (body.get("input") or "").strip()
    if not text:
        return JSONResponse({"error": "empty input"}, status_code=400)
    model = body.get("model") or DEFAULT_TTS
    voice = body.get("voice") or "af_heart"
    ref_audio, ref_text = None, None
    if "base" in model.lower():
        ref_audio, ref_text = REF_AUDIO, REF_TEXT
    # explicit cloning reference overrides the default ref voice
    ref_name = str(body.get("ref_audio") or "")[:64]
    if ref_name:
        p = os.path.join(ANCHOR_DIR, "".join(ch for ch in ref_name if ch.isalnum()) + ".wav")
        if os.path.isfile(p):
            ref_audio, ref_text = p, (body.get("ref_text") or "").strip()

    # speaker-embedding gate: when the client sends ref_emb (b64 float32),
    # regenerate until the output's speaker embedding matches it (cosine
    # >= emb_thresh, default 0.9) — sampling makes this model drift between
    # voice registers on some texts; F0 alone does not catch timbre changes.
    ref_emb = None
    ref_raw = body.get("ref_emb")
    if ref_raw:
        try:
            v = np.frombuffer(base64.b64decode(ref_raw), dtype=np.float32)
            n = float(np.linalg.norm(v))
            if n > 0 and len(v) > 8:
                ref_emb = v / n
        except Exception:  # noqa: BLE001
            ref_emb = None
    want_emb = bool(body.get("want_emb")) or ref_emb is not None
    emb_thresh = float(body.get("emb_thresh") or 0.9)

    t0 = time.time()
    out_dir = tempfile.mkdtemp(prefix="mlx_tts_")
    out_path = os.path.join(out_dir, "audio.wav")
    data = b""
    out_emb_b64 = ""
    try:
        max_tries = 3 if ref_emb is not None else 1
        for attempt in range(max_tries):
            with _lock:
                generate_audio(
                    text=text,
                    model=_cached_model(model),
                    voice=voice,
                    instruct=body.get("instruct") or (DEFAULT_INSTRUCT if "voicedesign" in model.lower() else None),
                    ref_audio=ref_audio,
                    ref_text=ref_text,
                    lang_code=body.get("lang_code") or "auto",
                    temperature=float(body.get("temperature") or 0.7),
                    top_k=body.get("top_k"),
                    top_p=body.get("top_p"),
                    repetition_penalty=body.get("repetition_penalty"),
                    output_path=out_dir,
                    audio_format="wav",
                    join_audio=True,
                    verbose=False,
                )
                produced = sorted(glob.glob(os.path.join(out_dir, "audio*")))
                if not produced:
                    produced = sorted(glob.glob(os.path.join(out_dir, "*")))
                if produced:
                    with open(produced[0], "rb") as f:
                        data = f.read()
                # embedding INSIDE the lock: it runs on the same GPU as
                # generation — outside, it contends with parallel chunk
                # requests and stalls the whole pipeline
                out_emb_b64 = ""
                emb = None
                if want_emb:
                    emb = _embed_wav(out_path)
                    if emb is not None:
                        out_emb_b64 = base64.b64encode(emb.astype(np.float32).tobytes()).decode()
            if not data:
                break
            if ref_emb is not None and emb is not None:
                cos = float(np.dot(ref_emb, emb))
                print(f"[tts-emb] attempt={attempt} cos={cos:.3f} thresh={emb_thresh}", flush=True)
                if cos >= emb_thresh:
                    break
                data = b""  # drifted — regenerate with fresh sampling
            elif want_emb and out_emb_b64:
                break  # anchor request: return embedding, no gate
            elif not want_emb:
                break
    finally:
        for p in (out_path, out_dir):
            try:
                os.unlink(p) if os.path.isfile(p) else os.rmdir(p)
            except OSError:
                pass
    if not data:
        return JSONResponse({"error": "tts produced no audio"}, status_code=500)
    print(f"[tts] {time.time()-t0:.2f}s model={model} chars={len(text)} -> {len(data)}b", flush=True)
    headers = {}
    if out_emb_b64:
        headers["X-Spk-Emb"] = out_emb_b64
    return Response(content=data, media_type="audio/wav", headers=headers)


@app.post("/v1/audio/speech_stream")
def speech_stream(body: dict):
    """Raw PCM stream (int16 LE, 24kHz mono) — ONE continuous generation for
    the whole text (stream=True), so the voice is physically constant from
    start to end; pieces arrive every ~streaming_interval of audio."""
    text = (body.get("input") or "").strip()
    if not text:
        return JSONResponse({"error": "empty input"}, status_code=400)
    model = body.get("model") or DEFAULT_TTS
    voice = body.get("voice") or "af_heart"
    t0 = time.time()
    try:
        gen_model = _cached_model(model)
        # pin the RNG: same seed + same text = identical audio. The client
        # keeps one seed per session so the voice never re-rolls.
        if body.get("seed") is not None:
            mx.random.seed(int(body["seed"]) % (2**31))
        results = gen_model.generate(
            text=text,
            voice=voice,
            instruct=body.get("instruct") or (DEFAULT_INSTRUCT if "voicedesign" in model.lower() else None),
            lang_code=body.get("lang_code") or "auto",
            ref_audio=REF_AUDIO if "base" in model.lower() else None,
            ref_text=REF_TEXT if "base" in model.lower() else None,
            temperature=float(body.get("temperature") or 0.3),
            top_k=int(body.get("top_k") or 20),
            repetition_penalty=float(body.get("repetition_penalty") or 1.3),
            stream=True,
            streaming_interval=float(body.get("streaming_interval") or 4.0),
            verbose=False,
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"tts: {e}"}, status_code=500)

    def pcm():
        total = 0
        try:
            for res in results:
                a = np.clip(np.array(res.audio, dtype=np.float32), -1.0, 1.0)
                pcm = (a * 32767).astype(np.int16).tobytes()
                total += len(pcm)
                yield pcm
        finally:
            print(f"[tts-stream] {time.time()-t0:.2f}s model={model} chars={len(text)} -> {total}b", flush=True)

    return StreamingResponse(
        pcm(),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(int(gen_model.sample_rate)), "Cache-Control": "no-store"},
    )


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), model: str = Form(default="")):
    model = model or DEFAULT_STT
    data = await file.read()
    t0 = time.time()
    fd, in_path = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    try:
        with _lock:
            result = generate_transcription(model=model, audio=in_path, format="json", verbose=False)
        if isinstance(result, dict):
            text = result.get("text", "")
        else:
            text = getattr(result, "text", "") or ""
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        try:
            os.unlink(in_path)
        except OSError:
            pass
    print(f"[stt] {time.time()-t0:.2f}s model={model} -> {text[:60]!r}", flush=True)
    return JSONResponse({"text": text.strip()})
