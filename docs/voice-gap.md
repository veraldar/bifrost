# Voice gap report — what the live wrapper can and cannot serve (10-03)

Session: fix/voice-switch · for the voice lab (session [LAB] voice, lab2-p2 +
lab3 calm-picker follow-up) · probe evidence: `lab/voice-switch/probe-results.json`
+ `lab/voice-switch/probe_voices.py` (rerunnable, ~15s, health-checked).

## Headline

The lab's zero-switch recommendation **works on the live wrapper** — but only
under its real name. The lab said "one env var (voice=am_onyx)"; the env var
that actually got set was `onyx`, and that is the whole outage:

- `TTS_VOICE_EN=onyx` (10-03 morning) → auto-speak dead, no error anywhere
  client-side. Reverted to `af_heart` → service restored.
- `TTS_VOICE_EN=am_onyx` (10-03, this session) → auto-speak verified live
  end-to-end through the phone path: 200, 214KB PCM, 0.18s, F0 89.9 Hz.

## The name gap — `onyx` does not exist (and never will)

Kokoro voices are FILES on the Mac: `voices/<name>.safetensors` under the
`prince-canuma/Kokoro-82M` HF cache. Present packs (measured):

| pack | serves? | first sound | F0 med | band |
|---|---|---|---|---|
| `am_onyx` | YES | 0.28s | 87.9 Hz | deep-male (85-115) ✅ |
| `am_michael` | YES | 0.43s | 117.6 Hz | just outside band |
| `bm_george` | YES | 0.27s | 148.1 Hz | mid |
| `am_fenrir` | YES | 0.23s | 140.4 Hz | mid |
| `af_heart` | YES (incumbent) | 0.34s | 195.1 Hz | female |
| `onyx` | **NEVER — OpenAI name, not a Kokoro pack** | 200 + **0 bytes** | — | the outage |

Missing packs auto-download on first use when they exist upstream
(`Fetching 1 files` seen for bm_george/fenrir) — so new Kokoro voices are
drop-in, zero wrapper changes. `onyx.safetensors` exists nowhere upstream.

### The failure mode is the real bug (wrapper-side)

The wrapper calls `generate(stream=True)` inside try/except — but the voice
load raises LAZILY on the generator's first iteration, i.e. AFTER
`StreamingResponse` already sent HTTP 200. Client sees success, receives a
zero-byte body, plays nothing, logs nothing. The phone's "listen-to-you broke"
was exactly this. Fix (one small change in `~/voice-stack/mlx_wrapper.py`,
filed as open-questions 10-03): pre-validate the voice pack before returning
200 (kokoro: check the safetensors file exists / wrap the first `next(results)`
in the except) → 400 naming the bad voice + available packs. Until then the
name law in `docs/tts-voice.md` is the guardrail.

## The Chatterbox gap — deep-male FRENCH has no zero-switch path

Kokoro ships NO deep-male French (`ff_siwis` = French female). The lab's
Chatterbox FR deep male (99.5 Hz, "the FR breakthrough") is **not servable by
the production wrapper**: Chatterbox is a torch engine, today only running on
the lab's isolated venv server (`192.168.50.1:8002`, still up 10-03). What
would enable it, cheapest first:

1. **Second runtime beside the wrapper** (the lab server already speaks the
   exact production API shapes — lab2 P2 §6): keep it on 8002 permanently
   (launchd, isolated venv, torch + chatterbox) and route FR-deep requests to
   it. Cost: one more service to keep warm (~4-5s first audio, per lab bench).
2. **Chatterbox ONNX/CPU port** in the main wrapper (lab P2 "remaining" item):
   kills the torch dependency, but CPU RTF on the Mac is unproven.
3. Do nothing: EN deep male is solved by `am_onyx`; FR stays Elise unless the
   user asks for FR deep male by ear.

## State after this mission

- Live production EN voice = `am_onyx` (pwa/.env.local, lk-pwa restarted,
  e2e verified). User picks by ear; alternates are one env var + restart away:
  `am_michael` / `bm_george` / `am_fenrir` / back to `af_heart`.
- Ear-pass clips: `artifacts/lab5-kokoro-{am_onyx,am_michael,bm_george,
  am_fenrir,af_heart}.wav` + `lab5-e2e-onyx.wav` (the live switched voice).
- Commits: 7c53e66 (M0 probe) · f798c8d (M1 switch + docs) · M2 = this file.
