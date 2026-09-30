# Launch positioning — bifrost

Draft v1 (LAUNCH session, 09-30). Nothing here is announced anywhere until the
v0.4.0 gate closes — see `checklist.md`. Coordination contract: product session
marks readiness in `docs/plan.md` (tag `v0.4.0` + hands-free human pass).

## One-liner (primary)

> **Bifrost — talk to your coding agent from your phone. Paste one link, say
> "set it up", and get a private, self-hosted, voice-first remote for the agent
> you already run.**

Alternates by channel:

- Short (X bio / HN title tail): *a self-hosted, voice-first remote for your coding agent.*
- LocalLLaMA slant: *voice-control your coding agent with local speech models — nothing leaves your tailnet.*
- install-first slant: *the install is the demo: paste `<link>` + "set it up" into any agent, get a phone remote.*

## The wedge: what we sell vs what the big dogs sell

Every big AI-coding product sells **model quality** (or access to it). Bifrost
does not sell a model at all — it sells **ownership of the controls**:

| | Cursor / Copilot / Windsurf / Claude Code | bifrost |
|---|---|---|
| What you buy | access to *their* model, in *their* cloud/IDE | control of *your* agent, on *your* hardware |
| Where your code lives | their cloud boundaries | your box; tailnet-private, nothing public |
| Voice | none or an afterthought | voice-first: PTT + hands-free, STT/TTS run locally |
| Speech privacy | n/a | local speech models (MLX Qwen3 / speaches CPU fallback) — no cloud speech API |
| Install | signup, IDE extension, subscription | agent-native: one link + "set it up" into opencode/Claude Code/Codex |
| License | proprietary | AGPL-3.0 — copyleft including network use |
| Works with | their stack only | your stack: opencode today; claude-code/copilot connectors on the roadmap |

Positioning sentence: **"They sell you the model. Bifrost gives you the
remote."** Never claim bifrost makes the model smarter — it makes *you* able to
drive it from anywhere, by voice, without handing your code to another cloud.

## Audience line (honest, v0.4.0)

> **Built for people who live in a terminal.** If `git clone` and
> `docker compose up` are things you do without looking them up, bifrost is
> ready for you today. v0.4.0 is the enthusiast release; the one-button
> consumer version is v1.0 (QR pairing, `/pair` onboarding). If that's not you
> yet, star it and come back.

Not: "for everyone", not "replace your IDE", not "AI for non-coders".

## Honest limits — state these in every post, unprompted

1. **One manual install step**: `opencode auth login` — your LLM provider key;
   nothing may mint that for you. Everything else is agent-done.
2. **Requirements**: one Linux box (Omarchy/Arch/Debian tested), Docker for the
   voice stack, Node ≥ 22, your own LLM key. No Mac needed — CPU speech
   fallback ships in the compose; a Mac running MLX models is an optional
   quality upgrade.
3. **The coding model is not ours**: bifrost drives whatever opencode is
   configured with. Speech (STT/TTS) is local; the LLM is yours to choose
   (cloud key or a local model via opencode).
4. **Hands-free had a known bug** (auto-listen restarted per step / stale
   commits). Fixed (`1d34b63`); a full human hands-free pass is the v0.4.0
   release gate. Until that box is ticked in `docs/plan.md`, we say
   "hands-free is fresh off a fix — PTT is the battle-tested mode."
5. **One harness today**: opencode. Claude Code / Copilot connectors are
   specced (`docs/spec-connectors.md`), not shipped — never imply otherwise.
6. **Networking**: default topology is tailnet-only (Tailscale). Vercel PWA
   button exists but is the advanced path; opencode must never be public.

## Boilerplate (50 words, for footers)

Bifrost is an open-source (AGPL-3.0), self-hosted, voice-first remote for your
coding agent. Speak or type from your phone; a LiveKit voice agent bridges you
to a local opencode server and answers back as text and speech. Local speech
models, tailnet-private, installed by your agent from a single link.
