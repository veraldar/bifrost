# TTS voice pipeline — what works, what failed

State: 2026-09-27. Production: streaming deck « speak last reply » in the PWA.
French voice = Elise. English voice = base clone of `ref_voice.wav`.

## Production setup (works)

- Mac wrapper `deploy/mlx_wrapper.py` (live at `~/voice-stack/mlx_wrapper.py`,
  launchd `com.opencode.mlxvoice`, port 8001):
  - `POST /v1/audio/speech_stream` — ONE continuous generation per message
    (`stream=True, streaming_interval=4`), yields raw PCM int16 LE 24kHz mono.
    Single pass = speaker constant; there are no chunk boundaries to drift across.
  - `POST /v1/audio/speech` — non-streaming whole-clip WAV (used by livekit agent).
  - Model cache `_cached_model()` — weights load once per repo (per-request
    reload cost ~1-2s otherwise).
  - `mx.random.seed(body.seed)` pinned before generate (see limits below).
- Models:
  - French: `thaddeusk/Qwen3-TTS-12Hz-1.7B-Elise-v2` — CustomVoice fine-tune,
    single speaker `elise`, `french` in supported languages.
  - English: `cr2k2/Qwen3-TTS-12Hz-1.7B-Base-fp32` — voice clone of
    `ref_voice.wav` (English speaker; fine for English, unusable for French).
  - Do NOT use `mlx-community/Qwen3-TTS-*-MLX-4bit` variants for image/other —
    for TTS the `mlx-community` bf16 CustomVoice/VoiceDesign work; the
    `Qwen-Image` MLX ports are diffusers-incompatible (silent noise output).
- Sampling: `temperature 0.3, top_k 20, repetition_penalty 1.3`.
- Proxy `pwa/app/api/tts/stream/route.ts`: PCM pass-through + X-Sample-Rate.
- Client `pwa/lib/speech.ts`: fetch stream → PCM → 6s WAV blobs
  (silence-trimmed ±120ms edges) → double-buffered native `<audio>` playlist.
  Pause = el.pause; seek = piece index + currentTime; speed = playbackRate.
- Deck UI: `pwa/app/session/[slug]/page.tsx` (icon-button toggle, loading
  card, seek bar, ⏸/▶, speed, ■ stop above the deck).
- env (pwa/.env.local): `SPEACHES_URL`, `TTS_MODEL`, `TTS_MODEL_FR`,
  `TTS_VOICE_FR`, `TTS_LANG_FR`.

## Root causes found (each broke the voice at some point)

- `lang_code` defaults to `"en"` in mlx_audio generate — French must be passed
  explicitly (`french`), else English phonology. Wrapper default is now `auto`.
- `mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-*`: invents a RANDOM speaker
  per request (instruct ≠ identity) — voice changes every chunk. Never use for
  multi-part text.
- Base model for French: clones the English reference speaker → English accent
  regardless of text language.
- WebAudio playback: phones suspend the AudioContext ~4s after screen-lock or
  tab-hide → silent playback while UI shows "playing". Native `<audio>` keeps
  playing in background — use it.
- Stale module state: timeline offset (`nextStart`) must reset when the audio
  context is recreated, else the first piece is scheduled tens of seconds in
  the future (silence).
- Sampling drift: temp 0.7 / top_k 50 (model defaults) wanders between voice
  registers (~115-265Hz F0 measured on same text). temp 0.3 / top_k 20 holds
  the register; top_k=1 and temp ≤0.15 degenerate into repetition loops
  (max_tokens exhaustion), mitigated by repetition_penalty 1.3.
- Small first chunk (first sentence only): sounded different from the rest and
  starved the pipeline at the start (pause after chunk 1). Uniform chunks beat
  tiny-first for consistency.
- Long generations (240c+) drift more than short ones — kept chunks ~110-150c
  in the deck era; superseded by streaming (no chunks at all).
- Franglais texts: client detects language ONCE per message and forces the
  model/lang; per-segment auto-detection flips pronunciation mid-message.

## Measurements (M3 Ultra, streaming, French)

- RTF ~0.27: 33s of audio synthesized in 12s; 5s pieces yielded every ~1.3s.
- First audio ≈ 4.3s (streaming_interval 4s) — the floor with this pipeline.
- Speaker-embedding cosine (base-model ECAPA encoder), vivian/serena tests:
  cross-paragraph 0.98-0.99; same text replay 0.99-0.997 (temp 0.2).
- Sampling has NO exploitable seed: `mx.random.categorical` + lazy streaming
  eval makes replay non-deterministic even with `mx.random.seed`. Same-seed
  replays vary slightly in prosody (speaker identity holds, ~0.99).
- Diag events: `[tts]` timings (wrapper log), `tts: first audio in Xms`,
  `ctx created/resume/state` (AudioContext), `boundary stall` (stream behind
  playback) — all land in `pwa/.diag/`.

## Client playback contract

- Toggle (idle) → `POST /api/tts/stream {text, lang}` → phase loading →
  playing (first PCM piece) → natural end returns to idle.
- ■ stop (active only, above the deck) = the only kill.
- Pause/resume: `AudioContext`-free — `audio.pause()/play()` on the active
  element; position frozen (currentTime).
- Seek: within received audio instant (piece index + currentTime); beyond:
  phase `loading` until the PCM stream reaches the target (PCM is dropped
  before the seek point).
- Speed: `audio.playbackRate` — applies live to the current piece.
- Prebuffer: playback starts after 2 pieces (~20s audio) — absorbs network
  hiccups; later boundary stalls show `synthesizing` and resume in place.
