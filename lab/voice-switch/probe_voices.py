#!/usr/bin/env python3
"""M0 probe: which voices does the LIVE Mac MLX wrapper (:8001) actually serve?

Hits POST /v1/audio/speech_stream exactly like the live PWA route
(pwa/app/api/tts/stream/route.ts EN branch) does. Per candidate:
  HTTP status, TTFB (first byte ≈ first streaming audio), total bytes,
  first-sound offset in the PCM, F0 median (calm-deep band check 85-115 Hz).
Clips are saved as 24 kHz 16-bit mono WAV for the ear pass.
Short inputs only — the wrapper serializes generation with a global lock,
probes must not hold the production voice hostage.
"""

import json
import struct
import subprocess
import sys
import time
import wave

BASE = "http://192.168.50.1:8001/v1"
MODEL = "mlx-community/Kokoro-82M-bf16"
TEXT = "All systems nominal. I am here, and I will keep watch while you rest."
SR = 24000

CANDIDATES = [
    ("af_heart", "a"),    # incumbent control — must pass
    ("onyx", "a"),        # what broke live (OpenAI-style name, likely no pack)
    ("am_onyx", "a"),     # lab pick: deepest (86.9 Hz in lab bench)
    ("am_michael", "a"),  # lab alternate (115.9 Hz)
    ("bm_george", "b"),   # British male candidate
    ("am_fenrir", "a"),   # low male alternate
]


def f0_median(pcm: bytes, sr: int = SR) -> float | None:
    """Median F0 via frame autocorrelation on voiced frames. Light numpy-free."""
    n = len(pcm) // 2
    if n < sr:  # need >=1s
        return None
    x = struct.unpack(f"<{n}h", pcm[: n * 2])
    step = 3  # 8 kHz effective
    xs = [x[i] / 32768.0 for i in range(0, n, step)]
    frame = 800  # 100 ms at 8 kHz
    hop = 400
    lag_min, lag_max = int(8000 / 300), int(8000 / 70)  # 70–300 Hz
    meds = []
    for start in range(0, len(xs) - frame, hop):
        f = xs[start : start + frame]
        energy = sum(v * v for v in f)
        if energy < 0.05:  # silence gate
            continue
        best, best_lag = 0.0, 0
        for lag in range(lag_min, lag_max):
            c = sum(f[i] * f[i + lag] for i in range(frame - lag))
            c /= energy
            if c > best:
                best, best_lag = c, lag
        if best > 0.5 and best_lag:
            meds.append(8000 / best_lag)
    if len(meds) < 5:
        return None
    meds.sort()
    return meds[len(meds) // 2]


def first_sound(pcm: bytes) -> float:
    """Seconds until first sample above ~0.008 full scale."""
    n = len(pcm) // 2
    thr = 260
    for i in range(n):
        s = struct.unpack_from("<h", pcm, i * 2)[0]
        if abs(s) > thr:
            return i / SR
    return -1.0


def probe(voice: str, lang: str) -> dict:
    body = {
        "model": MODEL,
        "voice": voice,
        "lang_code": lang,
        "temperature": 0.2,
        "top_k": 20,
        "repetition_penalty": 1.3,
        "streaming_interval": 4.0,
        "input": TEXT,
    }
    pcm_path = f"/tmp/opencode/probe-{voice}.pcm"
    t0 = time.time()
    r = subprocess.run(
        [
            "curl",
            "-sS",
            "-m",
            "90",
            "-w",
            "\\n%{http_code} %{time_starttransfer} %{time_total} %{size_download} %{exitcode}",
            "-o",
            pcm_path,
            "-X",
            "POST",
            f"{BASE}/audio/speech_stream",
            "-H",
            "Content-Type: application/json",
            "-d",
            json.dumps(body),
        ],
        capture_output=True,
        text=True,
    )
    ttfb = total = dl = 0.0
    code = curl_exit = 0
    try:
        out = r.stdout.rsplit("\n", 1)[-1].split()
        code = int(out[0])
        ttfb = float(out[1])
        total = float(out[2])
        dl = int(out[3])
        curl_exit = int(out[4])
    except Exception:
        pass
    res = {
        "voice": voice,
        "lang": lang,
        "http": code,
        "ttfb_s": round(ttfb, 2),
        "wall_s": round(total, 2),
        "downloaded_b": int(dl),
        "curl_exit": curl_exit,
    }
    try:
        pcm = open(pcm_path, "rb").read()
    except FileNotFoundError:
        pcm = b""
    if code == 200 and curl_exit == 0 and len(pcm) > SR * 2 and len(pcm) == dl:
        wav_path = f"artifacts/lab5-kokoro-{voice}.wav"
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm)
        res["bytes"] = len(pcm)
        res["first_sound_s"] = round(first_sound(pcm), 2)
        f0 = f0_median(pcm)
        res["f0_med"] = round(f0, 1) if f0 else None
        res["clip"] = wav_path
    else:
        res["error"] = (
            f"stream dead/broken: body={len(pcm)}b != downloaded={dl}b, curl_exit={curl_exit}"
            if code == 200
            else (r.stdout or r.stderr).strip()[:300]
        )
    return res


def main() -> None:
    subprocess.run(["mkdir", "-p", "/tmp/opencode"], check=True)
    health = subprocess.run(["curl", "-sS", "-m", "5", "http://192.168.50.1:8001/health"], capture_output=True, text=True)
    print(f"health pre: {health.stdout.strip()}")
    rows = [probe(v, l) for v, l in CANDIDATES]
    health2 = subprocess.run(["curl", "-sS", "-m", "5", "http://192.168.50.1:8001/health"], capture_output=True, text=True)
    print(f"health post: {health2.stdout.strip()}")
    print(json.dumps(rows, indent=1))
    with open("lab/voice-switch/probe-results.json", "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    sys.exit(main())
