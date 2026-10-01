#!/usr/bin/env python3
"""Round-trip verification for the bifrost-lite edge server.

Usage: python verify_edge.py [base_url]     (default http://127.0.0.1:8100)
Checks: healthz, models, en TTS->STT round-trip + RTFs, fr TTS, PCM stream shape.
Exit 0 = all green.
"""
import io
import sys
import time
import wave

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8100"
EN_TEXT = "The quick brown fox jumps over the lazy dog"
FR_TEXT = "Bonjour, ceci est un test de synthese vocale locale sur l'appareil."

fails = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    if not ok:
        fails.append(name)


r = requests.get(f"{BASE}/healthz", timeout=5)
check("healthz", r.ok and r.json().get("ok") is True, r.text[:80])

r = requests.get(f"{BASE}/v1/models", timeout=5)
check("models list", r.ok and isinstance(r.json().get("data"), list))

# en TTS
t0 = time.perf_counter()
r = requests.post(f"{BASE}/v1/audio/speech", json={"input": EN_TEXT, "voice": "en"}, timeout=120)
wall = time.perf_counter() - t0
check("en tts", r.ok and r.headers.get("content-type") == "audio/wav",
      f"rtf={r.headers.get('X-Rtf')} gen={r.headers.get('X-Gen-Seconds')}s wall={wall:.1f}s")
wav = r.content
with wave.open(io.BytesIO(wav), "rb") as w:
    rate, frames = w.getframerate(), w.getnframes()
dur = frames / rate
check("en tts duration", dur > 2.0, f"{dur:.1f}s @ {rate}Hz")

# STT round-trip on our own tts output
t0 = time.perf_counter()
r = requests.post(f"{BASE}/v1/audio/transcriptions", files={"file": ("a.wav", wav, "audio/wav")}, timeout=120)
stt_wall = time.perf_counter() - t0
text = r.json().get("text", "").lower()
overlap = len(set(text.split()) & set(EN_TEXT.lower().split())) / len(set(EN_TEXT.split()))
check("en stt round-trip", overlap >= 0.5, f'heard="{text[:60]}" overlap={overlap:.0%} wall={stt_wall:.1f}s rtf={r.json().get("_rtf")}')

# fr TTS (no fr STT in the spike — duration/rate sanity only)
r = requests.post(f"{BASE}/v1/audio/speech", json={"input": FR_TEXT, "voice": "elise"}, timeout=120)
with wave.open(io.BytesIO(r.content), "rb") as w:
    fr_rate, fr_frames = w.getframerate(), w.getnframes()
check("fr tts (elise->siwis)", r.ok and fr_frames / fr_rate > 2.0,
      f"{fr_frames / fr_rate:.1f}s @ {fr_rate}Hz lang={r.headers.get('X-Lang')} rtf={r.headers.get('X-Rtf')}")

# pcm stream shape (PWA deck contract: raw int16 PCM + X-Sample-Rate)
r = requests.post(f"{BASE}/v1/audio/speech_stream", json={"text": FR_TEXT, "lang": "fr"}, timeout=120)
check("speech_stream pcm", r.ok and r.headers.get("X-Sample-Rate") is not None
      and len(r.content) > fr_frames * 2 * 0.5,
      f"{len(r.content)}B @ {r.headers.get('X-Sample-Rate')}Hz")

print()
print("ALL GREEN" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
