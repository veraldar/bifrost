# Channel plan — WAVE 1 techie launch

v3 (10-02 state sync). Reality: v0.6.0 shipped, repo `veraldar/bifrost`,
Wave 1 gates on **v0.7.0 (the reliable voice)** and fires **by the user's
hand only**. Brand voice per `docs/brand/brand.md`; delivery rules per
`trust-viral.md` (the pre-post block below is binding).

**Links:** repo = `https://github.com/veraldar/bifrost` everywhere, primary.
`veraldar.org` mentioned once per post as the org name (it is a stub until
post-v1.0 — never link-sell it). Posts never wait on any site.

**Wave 1 shape (adopted ladder):** hook-first Show HN + cold-start video +
5–10 seeded testers. Order of play on T-day:

1. **Seeded testers** (pre-wave, below) have already installed; their verdicts
   quote into the HN thread organically, never on cue.
2. **Show HN** — hook-first title, cold-start video in top comment.
3. **X** — thread + videos, repo link (never the HN link).
4. **r/LocalLLaMA → r/selfhosted → r/omarchy**, staggered ~30 min.

---

## 0. Seeded testers (before T-day, 5–10 people)

- **Who**: terminal-comfortable people with a Linux box + Android phone;
  drawn from opencode community, omarchy-adjacent friends-of-friends. No
  journalists, no paid amplification.
- **How**: private invite → they run the install themselves (the agent-native
  loop is the test, not me installing for them) → entry ticket is the
  `scripts/selfhost-check.sh` verdict pasted into a shared feedback thread.
- **Ask**: install friction notes (every spot they hesitated), one hands-free
  session, one PTT session, one attachment. Honest verdict quote we may
  publish — with their name, only if they offer.
- **Rules**: they speak freely and post nowhere on cue; if any of them
  comments on HN/Reddit they disclose they had early access. No coordinated
  anything (trust-viral §4 astroturf rules).
- **Pass bar**: ≥5 clean installs by strangers, every friction point triaged
  into v0.7.0 or the known-issues issue.

## BEFORE POSTING — required edits (per trust-viral.md §4–5)

Drafts below are **base text**. Required before any of them goes out:

1. **Dictate, don't polish** — the author dictates each post from base text,
   transcribes, edits lightly. Agent-polished copy reads AI-written.
2. **Cut on sight**: antithesis slogans ("they sell X / you get Y"),
   "Honest limits:"/"What it is not:"/"The pitch:" labels, "battle-tested",
   "fresh off a fix", fragment triplets, em-dash chains.
3. **Show HN adds**: AI-use disclosure (candidate in trust-viral §4); one
   real measured number; "the install skill is N lines, pinned to
   <tag/sha> — read it before you paste it"; how long the build took and
   what broke.
4. **No verbatim phrase in two posts.** First person "I", never "we".
5. Comparative claims only about what we verified.

---

## 1. Show HN (hook-first)

**Title — pick one at fire time (hook first, name after the dash):**
```
Show HN: Voice-control your self-hosted coding agent from your phone
Show HN: Bifrost – talk to your coding agent from your phone (self-hosted, local speech)
Show HN: I drive my coding agent by voice from the couch; the code changes on my own box
```

**Body (first comment, author voice):**

> Hi HN. I built Bifrost because I wanted to talk to my coding agent from the
> couch without my code passing through someone else's cloud.
>
> It's a self-hosted, voice-first remote for opencode. Speak or type on your
> phone (PWA); a LiveKit voice agent bridges your words to a local opencode
> server; the answer comes back as text and speech. Voice turns land in the
> same transcript as text — the LiveKit room name is the opencode session
> slug, so what you said on the couch is what the agent sees at the desk.
> Sub-sessions and input recall came out of using it daily.
>
> Speech never touches a cloud API: STT/TTS run on local models — Qwen3 via
> MLX on a spare Mac if you have one, or a CPU fallback (faster-whisper +
> Kokoro) in the docker compose. One voice mode detail I care about: keyboard
> mode releases the OS mic instantly, so the phone's mic indicator never lies.
> Default topology is Tailscale-only. opencode has shell access, so it never
> gets a public route — the phone talks to a Next.js proxy and that proxy is
> the only seam. Auth is tailnet-gated; SECURITY.md and pinned install tags
> shipped with the last release.
>
> The install took the longest to get right. You paste one link into any
> coding agent (opencode, Claude Code, Codex) plus the words "set it up".
> The agent fetches the install skill, clones the repo, checks
> prerequisites, mints every secret, boots each layer, verifies it, and
> prints the URL. One manual step: `opencode auth login` — your LLM key;
> nothing mints that for you. There's also a delegation skill: your sessions
> can call claude/codex as sub-agents.
>
> Honest state, plainly: I'm one person; most of the code was written by
> coding agents directed by me, a lot of it by voice through Bifrost itself
> — the commit log quotes my requests. Requirements: one Linux box
> (Omarchy/Arch/Debian tested), Docker, Node ≥ 22, your LLM key. CPU voice
> is usable, not premium — MLX is the quality path. Hands-free is tested on
> one device (mine); push-to-talk is what I use daily. One harness today:
> opencode (delegation aside). AGPL-3.0. A Veraldar product — that's a
> one-person org, veraldar.org is a placeholder for now; the repo is the
> whole thing.
>
> Repo: https://github.com/veraldar/bifrost
> Cold-start video (empty folder → talking phone, one take): <link>
> 30s demo (phone speaker audio, no overdubs): <link>
>
> Stack: Next.js 15 PWA, Python livekit-agents, LiveKit, docker compose,
> systemd. Architecture diagram in the README. Architecture, install-skill
> design, and the voice pipeline — ask me anything.

**Notes:** Tue–Thu 07:00–09:00 US Pacific. Author watches replies 3h minimum.
Every reply human-written. "Why not X?" → ownership + voice + local speech,
architecture facts, never "better model".

## 2. X (thread)

**1 (hook, video first):**
```
I've been fixing bugs in this app by talking to my phone while walking the dog.

the diff lands on my own box. tests go green. it speaks the result back.

bifrost — self-hosted, voice-first remote for your coding agent. AGPL-3.0.

actual audio ↓ (including when it misheard me)
```
**2:** cold-start video or 30s demo (phone speaker audio).
**3:** install one-liner + "one manual step: opencode auth login — your LLM key."
**4 (limits, plain sentences):**
```
what it takes today: one linux box (docker + node 22), your LLM key, tailscale.

cpu voice is usable, not premium — mlx on a spare mac is the quality path.
hands-free is tested on one device so far; push-to-talk is my daily driver.
one harness today: opencode. AGPL-3.0.
```
**5:** repo link + "a Veraldar product" line.

## 3. r/LocalLLaMA (text post)

**Title:** `Local STT/TTS voice remote for my coding agent — Qwen3 MLX or whisper/Kokoro CPU, tailnet-only, AGPL`

> Lead with the numbers table (MLX Qwen3-ASR/TTS vs faster-whisper/Kokoro
> CPU, named hardware, round-trip per turn — measured before posting).
>
> Then: phone PWA (PTT + hands-free) → LiveKit → local opencode → answer as
> text + speech, voice turns in the same transcript as text. The coding LLM
> is whatever opencode is configured with — your key or a local model; we
> don't bundle a model. Local *speech*, user-chosen LLM.
>
> Install: paste the SKILL.md link into any coding agent + "set it up"; one
> manual step (`opencode auth login`). Pinned install tags, SECURITY.md.
> Tailnet-only; opencode has shell access so it never gets a public route.
>
> Limits: one Linux box (Docker, Node ≥ 22); CPU voice usable-not-premium;
> hands-free tested on one device; one harness (opencode). AGPL-3.0 — free
> for everyone. A Veraldar product.
>
> Repo: https://github.com/veraldar/bifrost

## 4. r/selfhosted (text post)

**Title:** `Bifrost — voice-control your self-hosted coding agent from your phone (tailnet-only, AGPL)`

> opencode has shell access, so it never gets a public route: the phone talks
> to a Next.js proxy, that proxy is the only seam, auth is tailnet-gated
> (BIFROST_AUTH=tailnet), SECURITY.md + pinned install tags shipped last
> release. Diagnostics are log-only on your own box — nothing phones home.
>
> The rest: phone PWA (PTT + hands-free) → LiveKit → local opencode, answer
> back as text + speech, local speech models (CPU fallback in the compose,
> MLX as the quality path), systemd user units + docker compose, reboots
> self-heal. Install: paste one link into any coding agent + "set it up";
> your LLM key is the only manual step.
>
> Limits: one Linux box (Docker, Node ≥ 22); CPU voice usable-not-premium;
> hands-free tested on one device; one harness (opencode) today. AGPL-3.0.
> A Veraldar product (one person; the org site is a placeholder — the repo
> is the thing).
>
> Repo: https://github.com/veraldar/bifrost

## 5. r/omarchy (text post, casual)

**Title:** `voice remote for my coding agent — runs on my omarchy box, the PWA matches the terminal look, and the agent installs it from one link`

> The box runs everything: opencode, LiveKit + a Python voice agent, pixel
> PWA on the phone (aether/terminus/drift themes now). Hold-to-talk from the
> couch → diff on the monitor → it speaks the result back. Speech is local:
> MLX on my Mac as the quality path, CPU fallback in the compose so one box
> works alone. systemd user units + one docker compose; reboots self-heal.
> Tailnet-only.
>
> Install: paste the repo's SKILL.md link into any coding agent + "set it
> up" — the agent installs it. One manual step: your LLM key.
>
> Rough edges: CPU voice usable-not-premium; hands-free tested on one device
> so far (PTT is my daily); opencode harness only. AGPL-3.0. Photo of the
> actual desk + box attached.
>
> Repo: https://github.com/veraldar/bifrost

## Cross-cutting rules

- Never cross-post identical text; no phrase verbatim in two posts.
- "Local LLM?" misread: correct every time — local *speech*, user's LLM.
- No comparative claims about products we haven't verified.
- Log links + timestamps into `docs/launch/results.md` on T-day.
