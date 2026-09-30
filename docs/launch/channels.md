# Channel plan — first public push

Draft v1 (LAUNCH session). **Nothing is posted until the v0.4.0 gate closes**
(tag exists + hands-free human pass ticked in `docs/plan.md`). Every post
carries the honest-limits line — see `positioning.md`. One person, one account,
posts; replies within the first 2 hours matter more than polish.

Order of play on launch day (all within ~2h of the GitHub release + tag):

1. **Show HN** — anchor post. Everything else references it.
2. **X** — thread + demo video, link to repo (not HN; HN punishes vote rings).
3. **r/LocalLLaMA** — local-speech angle, text post.
4. **r/selfhosted** — self-host angle, text post.
5. **r/omarchy** — homecoming post; it runs on omarchy and looks like omarchy.

---

## 1. Show HN

**Title:**
```
Show HN: Bifrost – self-hosted, voice-first remote for your coding agent
```

**Body (first comment, by the author — plain, first person, no marketese):**

> Hi HN — I built bifrost because I wanted to talk to my coding agent from the
> couch without my code passing through anyone else's cloud.
>
> It's a self-hosted, voice-first remote for opencode: speak or type on your
> phone (PWA), a LiveKit voice agent bridges your words to a local opencode
> server, and the answer comes back as text and speech. STT/TTS run on local
> models (Qwen3 via MLX, or a CPU whisper/Kokoro fallback in the compose) — no
> cloud speech API. The default topology is Tailscale-only: nothing public.
>
> The install is the part I'm proudest of. You paste one link into any coding
> agent (opencode, Claude Code, Codex) plus the words "set it up", and the
> agent fetches an install skill, clones the repo, checks prerequisites, mints
> every secret, boots the stack, verifies each layer, and prints the URL. One
> manual step remains: `opencode auth login` — your LLM key, which nothing
> should mint for you.
>
> What it is not: it doesn't make the model smarter. The big AI-coding tools
> sell model quality; bifrost gives you ownership of the controls — your box,
> your models, your network, AGPL-3.0.
>
> Honest limits: v0.4.0 is for terminal-comfortable users (one Linux box,
> docker, Node ≥ 22). Hands-free mode is fresh off a bug fix — push-to-talk is
> the battle-tested mode. One harness today (opencode); Claude Code/Copilot
> connectors are on the roadmap. The one-button consumer version is v1.0.
>
> Repo + 30s demo: <links>. Stack: Next.js 15 PWA, Python livekit-agents,
> LiveKit, docker compose, systemd. Happy to answer architecture questions.

**Notes:** post Tue–Thu, 07:00–09:00 US Pacific. Reply to every comment in the
first 3 hours. If asked "why not just use X": the answer is ownership + voice +
local speech, never "better model".

## 2. X (thread)

**Tweet 1 (hook, with vertical demo video):**
```
Your coding agent takes orders by voice now.

I built bifrost: paste one link into opencode/Claude Code/Codex, say
"set it up", and your phone becomes a private, self-hosted voice remote
for the agent on your own box.

Nothing public. No cloud speech API. AGPL.

demo ↓
```
**Tweet 2:** the 30s video (phone PTT → code changing → agent speaking back).
**Tweet 3:** install one-liner screenshot + "one manual step: your LLM key. everything else the agent does."
**Tweet 4 (honesty):** "limits, stated up front: terminal-comfortable users only today (Linux box, docker, Node≥22). hands-free is fresh off a fix — PTT is the proven mode. opencode harness only for now. v1.0 gets one-button onboarding."
**Tweet 5:** repo link + architecture one-liner + "they sell the model; this is the remote."

## 3. r/LocalLLaMA (text post)

**Title:** `I built a self-hosted voice remote for my coding agent — local STT/TTS, nothing leaves my tailnet`

> Voice-control for coding agents normally means a cloud speech API. I wanted
> the speech local too, so bifrost runs Qwen3-ASR/TTS via MLX on a Mac Studio
> (optional upgrade), with a fully-CPU fallback (faster-whisper + Kokoro) that
> ships in the docker compose — so one Linux box works with no GPU at all.
>
> Flow: phone PWA → LiveKit voice agent → local opencode → answer as text +
> speech. Same transcript for voice and text; voice turns land in the session.
> The LLM itself is whatever opencode is configured with (your key or a local
> model — your choice, not ours).
>
> Install is agent-native: paste the SKILL.md link into any coding agent + "set
> it up" — it mints secrets, boots the stack, verifies each layer.
>
> Honest limits: hobby/enthusiast release. Linux box + docker + Node 22. LLM
> is not bundled (speech is local; the coding model is yours). Hands-free
> mode is fresh off a fix — PTT is the reliable path today. AGPL-3.0.
>
> Repo: <link>. Happy to share MLX latency numbers on request.

## 4. r/selfhosted (text post)

**Title:** `bifrost — voice-control your self-hosted coding agent from your phone (tailnet-only, AGPL)`

> The pitch: your coding agent is already on your box — bifrost is the remote.
> Phone PWA (push-to-talk + hands-free) → LiveKit → local opencode. Answer comes
> back as text and speech; speech models run locally (CPU fallback ships, MLX is
> the upgrade path). systemd units + docker compose, reboots self-heal, frontend
> diagnostics are log-only.
>
> Privacy model: default topology is Tailscale-only. opencode has shell access,
> so it never gets a public route — the phone talks to a Next.js proxy, and
> that's the only seam. Nothing needs to be public, ever.
>
> Install: paste one link into opencode/Claude Code/Codex + "set it up". The
> agent does the rest; your LLM key is the only manual step.
>
> Honest limits: enthusiast release (v0.4.0) — Linux box, docker, Node ≥ 22.
> Hands-free fresh off a bug fix, PTT is the proven mode. One harness
> (opencode) today. AGPL-3.0. Repo: <link>

## 5. r/omarchy (text post, casual)

**Title:** `made a voice remote for my coding agent — it runs on my omarchy box and the PWA ships the same dark pixel look`

> This box runs the whole thing: opencode on the desktop, LiveKit + a Python
> voice agent, and a pixel-art PWA on my phone — same dark aesthetic as the
> terminal. Hold-to-talk from the couch: "add a /health endpoint with a test"
> → diff on the monitor → it speaks the result back. STT/TTS are local models
> (CPU fallback works, my Mac runs MLX as the quality path).
>
> Everything is systemd user units + one docker compose, so reboots self-heal.
> Tailnet-only — nothing public.
>
> Install is the fun part: paste the repo's SKILL.md link into any coding agent
> + "set it up" and the agent installs it for you. One manual step: your LLM key.
>
> Limits, honestly: enthusiast release — hands-free is fresh off a fix (PTT is
> solid), opencode harness only for now. AGPL. Repo: <link>
>
> If the mods prefer, happy to move to a showcase thread.

## Cross-cutting rules

- Never cross-post identical text; each channel gets its own angle + voice.
- Never claim "local LLM" — local *speech*, user's LLM. This distinction will
  be the #1 nitpick; answer it before it's asked.
- Never argue "our model is better" — we don't have one; that's the point.
- Every thread: pin the honest-limits line in the first 10 lines.
- Log links + timestamps back into `docs/launch/` after posting (a
  `results.md` gets created on launch day).
