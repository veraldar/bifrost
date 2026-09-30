# 30-second demo — script + shot list

Purpose: one video that proves the hook in half a minute — **phone voice → code
changing on screen**. Vertical 9:16 master (X/Reddit shorts) + 16:9 crop for HN
comment links / YouTube. No music licensing risk: lo-fi or none; the *voice*
is the audio. Record after v0.4.0 gate (real hands-free, post-fix).

## Beat sheet (30s)

| t | shot | on screen | VO / audio |
|---|---|---|---|
| 0–3s | Phone in hand, real sunlight, PWA opening on session `api-fix` | session list → transcript | "This is bifrost — a voice remote for my coding agent." |
| 3–8s | Thumb holds PTT button (green pulse + eq bars) | transcript appends: "add a /health endpoint to the server, with a test" | the actual spoken sentence — let STT caption it live |
| 8–18s | Cut to desktop: opencode working | routes.ts diff typing, health.test.ts created, test run goes 4/4 green | ambience only; keep the diff the star. Speed-ramp 2× if needed |
| 18–24s | Back to phone | agent line lands + TTS speaks through phone speaker: "Health endpoint added, all four tests pass." | the phone's actual speaker audio — audible, not overdubbed |
| 24–30s | Terminal insert, screen capture | paste the SKILL.md link + "set it up" → agent boots layers, prints URL | "Install is one link and two words. Self-hosted, tailnet-private, AGPL." |
| end card 2s | black + pixel logo | repo URL + "nothing public. nothing leaves your tailnet." | silence |

## Rules for authenticity

- **No overdubbed "magic"**: the voice audio is the phone's speaker, recorded
  on a second device. If STT mishears, keep it — captions carry the intent.
- **Real box, real tailnet** — no staging repo. Blur nothing (nothing private
  is visible by design; double-check browser tabs before capture).
- Speed-ramps fine, cuts hard (pixel aesthetic = hard cuts match the brand).
- Captions burned in (many viewers watch muted); pixel-mono caption style.
- End card: no "revolutionary" copy. One line: what it is + repo URL.

## Cutdowns

- **X/Threads**: 0–24s cut (drop terminal insert; put install one-liner in the tweet text instead).
- **HN**: don't embed video in the post; link it in a top-level comment ("30s demo: <link>") — Show HN culture prefers the repo as the main link.
- **Reddit**: native upload beats links out; post the vertical cut natively in r/omarchy + r/selfhosted comments, not as the post body where the sub prefers text.
