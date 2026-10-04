# Video plan — cold-start (official) + 30s cutdown

v3. Wave 1 ships two artifacts: the **cold-start video** (official, per the
adopted ladder — it is the proof of the agent-native install) and the **30s
demo** (hook for X/embeds). Both: no overdubs, no cuts where a cut would
hide a failure, captions burned in, end card = repo URL + "a Veraldar
product" + AGPL-3.0. Record on T-1 against the v0.7.0 tag.

## A. Cold-start video (60–90s, one take, visible clock)

The trust-viral thesis: the uncut install is the only convincing evidence
that "paste one link + set it up" isn't a claim.

1. 0s: clock starts on screen. Empty folder, prompt ready.
2. Paste the pinned SKILL.md link + `set it up` into the agent (show the
   whole line; it's one line).
3. Let it run — clone, prereqs, secret minting, layer-by-layer boot + verify.
   2× speed only while nothing fails; every failure or retry stays at 1×.
4. Verdict prints (terse, versions, timings — make it screenshot-worthy).
5. Cut to phone: open URL, hold-to-talk, one real turn, agent speaks back.
6. End card: repo URL + "a Veraldar product" + AGPL-3.0.

Rules: real box, real tailnet; blur nothing (nothing private visible by
design — check tabs first). If it fails on camera, that take SHIPS — narrate
the fix, re-run. An install that recovers on camera outproves a clean one.

## B. 30-second demo (hook)

Purpose: prove the hook in half a minute — **phone voice → code changing on
screen**. Vertical 9:16 master (X/Reddit) + 16:9 crop (HN comment/YouTube).
No music licensing risk: lo-fi or none; the *voice* is the audio. Lead with
PTT (the daily-driver mode).

## Beat sheet (30s)

| t | shot | on screen | VO / audio |
|---|---|---|---|
| 0–3s | Phone in hand, real sunlight, PWA opening on session `api-fix` | session list → transcript | "This is bifrost — a voice remote for my coding agent." |
| 3–8s | Thumb holds PTT button (green pulse + eq bars) | transcript appends: "add a /health endpoint to the server, with a test" | the actual spoken sentence — let STT caption it live |
| 8–18s | Cut to desktop: opencode working | routes.ts diff typing, health.test.ts created, test run goes 4/4 green | ambience only; keep the diff the star. Speed-ramp 2× if needed |
| 18–24s | Back to phone | agent line lands + TTS speaks through phone speaker: "Health endpoint added, all four tests pass." | the phone's actual speaker audio — audible, not overdubbed |
| 24–30s | Terminal insert, screen capture | paste the SKILL.md link + "set it up" → agent boots layers, prints URL | "One link, two words. Your box, your keys, your words — AGPL." |
| end card 2s | black + pixel logo | repo URL · "a Veraldar product" · AGPL-3.0 | silence |

## Rules for authenticity

- **No overdubs**: the voice audio is the phone's speaker, recorded
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
