# Trust + viral — how Veraldar/Bifrost gains and keeps trust in the AGI era

Status: directive deliverable (user, due 10-03 morning). **Research: Claude
Code (Opus)** via `claude -p` delegation, 10-02, reading the repo + brand book
+ launch kit. **Orchestration + editing: LAUNCH session.** Editor verified
Opus's repo-state claims against HEAD before publishing this file (see Part A).
Nothing here changes product scope silently: repo fixes are handed to the
product session, not made by LAUNCH.

---

## Part A — editor's note (LAUNCH session)

### Verified vs unverified (checked 10-02 against HEAD `3b021dc`+)

| Opus claim | Verdict |
|---|---|
| README clone command mismatch (`clone veraldar/bifrost.git && cd yggdrasil-bifrost`) | **CONFIRMED** — README line 113 |
| "One-click install (self-host)" heading over manual steps | **CONFIRMED** — README line 103 |
| Sponsors/OpenCollective "pending" strings | **CONFIRMED** — README lines 161–162 |
| Repo has tags beyond v0.4.0 (v0.5.0, v0.6.0) | **CONFIRMED** — user states **v0.4.0 is the launch tag**; confirm before posting which tag the public sees (posts say v0.4.0) |
| ~165 commits, req-quoted git history | **CONFIRMED** — exactly 165 |
| Hands-free "PASSED 09-30" next to unticked human-only checks in plan.md | **CONFIRMED** — plan lines 65–66 vs unticked boxes above; state exactly what was tested, on which device |
| Install skill URL pins v0.6.0 | **NOT FOUND** in `skills/install/SKILL.md` — treat as unverified; product session should confirm what the skill pins |
| Claude Code ships its own phone remote | **NOT CHECKED** — verify before ever making comparative claims about it; the table is being pulled from public copy anyway (below) |

### Decisions taken on the launch kit (this session, docs/launch/ only)

1. **Competitor comparison table + "they sell you the model" slogan →
   internal-only.** They stay in `positioning.md` as positioning thinking;
   they come OUT of public copy (LLM-rhythm tells, and one claim in the table
   is attackable). Public copy argues architecture facts: self-hosted, local
   speech, tailnet-only, AGPL, agent-native install.
2. **The five drafts in `channels.md` are demoted to BASE TEXT.** Required
   pre-post edits now head that file: author dictates final versions in their
   own voice; flagged lines cut; AI-use disclosure + one real number + skill
   SHA/line-count added. A dictation pass is the fix for "reads AI-written" —
   editing drafts can't be.
3. **"Honest limits:" labels removed from public posts** — limits stated as
   plain checkable sentences. The internal limits list stays.
4. **Lore/manifesto out of launch posts.** One "a Veraldar product
   (veraldar.org)" line per post stays (link policy). Lore page + movie:
   T+60 or later.
5. **Pre-flight repo fixes are a handoff, not my edits** — product session
   owns README/skill/docs; checklist Gate B now blocks T-day on that handoff
   being acknowledged.
6. **T-day rules adopted from this report**: replies human-only (never
   LLM-written), feature freeze T+0–14, pinned known-issues issue, 7-day
   retro with unrounded numbers.

---

## Part B — the research (Claude Code, Opus; lightly edited)

**Short version:** your best trust asset is something the drafts don't use.
Bifrost was built in 9 days, in 165 commits, mostly by agents that you drove
by voice, often through Bifrost itself. The git log quotes your spoken
requests (`req 10-02 'attached the attachment only once, and I see it
twice'`). That is proof of work, and it's the most shareable thing you have.
Your biggest trust risks are things HN will find in the first ten minutes, not
the product: a broken clone command, stale version claims, an install that
asks an LLM to run a remote markdown file, and launch copy whose rhythm reads
as LLM-written. Fix those before you post anything.

### 0. Pre-flight: things in the repo that will cost trust on day one

*(Editor: items 1, 3, 4, 6, 8 verified — see Part A. Owner: product session.)*

| # | Problem | Where | Why it costs trust |
|---|---|---|---|
| 1 | `git clone …/veraldar/bifrost.git && cd yggdrasil-bifrost`: folder name wrong | README manual install | First copier hits an error; every reply after says "did anyone run this?" |
| 2 | Vercel button still points to `veraldar/yggdrasil-bifrost` | README | Same problem, at the top of the page |
| 3 | Vercel path needs `OPENCODE_URL` reachable from Vercel | README | Story is "tailnet-only, opencode has shell access"; the second thing on the page nudges people to expose opencode. Move to "advanced / not recommended" or drop |
| 4 | "One-click install (self-host)" heading above ~12 manual steps | README | Brand book: never imply one-click. Rename "Manual install" |
| 5 | "any Linux box" | README | Say what is tested: Omarchy/Arch/Debian |
| 6 | "opencode Collective pending", Sponsors "(pending activation)" | README Support | Dead donation links read as a cash grab that isn't set up. Remove until live |
| 7 | Posts say v0.4.0; tags go to v0.6.0 | channels/launch kit | People will ask which version is launching. Pick one before posting *(editor: user says v0.4.0 — make the release page and README agree with it)* |
| 8 | Hands-free status contradicts itself | plan.md | "PASSED 09-30 … 'worked as good as it could'" next to unticked human-only checks. State exactly what was tested, on which phone, what wasn't |
| 9 | Comparison table claims Claude Code voice is "none or an afterthought" | positioning.md | Claude Code ships phone remote control; someone posts that within an hour and the table becomes the thread. The difference is self-hosted + local speech + AGPL + harness-agnostic direction. Drop the table from public copy; verify what opencode itself ships before claiming anything |
| 10 | "one-click core is growing" | lore/narration | Vaporware from a launch-day reader's view. Out of launch copy |

### 1. Building trust as a solo AGPL project

**Proof of work beats claims.** In 2026 anyone can generate a polished README
in 30 seconds. Nobody can fake these:

- **A git history linked to your requests.** The `req MM-DD '<your words>'`
  commit convention is unusual and real: a spoken complaint becomes a commit,
  timestamped. Publish one page: "the last 50 things I asked for by voice, and
  the commits that shipped them." Include the failures.
- **An uncut install recording.** Empty folder → paste the link → agent output
  → verdict → phone connects. One take, visible clock. The only convincing
  evidence that agent-native install isn't a claim.
- **Real numbers you measured.** STT/TTS latency for MLX and CPU speaches
  paths, named hardware, round-trip per turn. r/LocalLLaMA trusts tables, not
  adjectives. Put them in the post, not "on request".
- **`npm run verify` on a daily timer, logged in `docs/environments.md`.** Say
  so and link it. "My own box runs the test suite every day, here is the log"
  beats any testimonial.

**Make every claim checkable.**

| Claim | How a skeptic checks it |
|---|---|
| "nothing public" | `deploy/livekit.yaml.example` ICE pinning + `tailscale serve`; one paragraph on the network path |
| "no cloud speech API" | `agent/.env.example`: `SPEACHES_URL` empty = local CPU. Show where speech goes |
| "diagnostics are log-only" | `/api/diag` writes to *your* `pwa/.diag/`. State plainly: **nothing phones home to me** |
| "AGPL" | LICENSE file + the interop line (API use ≠ derivative) |

**Honest limits work as a brand, but only if concrete.** "Honest limits:" as a
label is now an LLM habit; readers treat it as marketing. State limits as
checkable facts:

- Weak: "Hands-free is fresh off a fix — PTT is the battle-tested mode."
  ("Battle-tested" for a 9-day-old feature is itself a false claim.)
- Better: "Push-to-talk is what I use daily. Hands-free works on my Pixel over
  Tailscale; I haven't tested echo on a loud speaker yet."

**Say "I", not "we".** Veraldar is one person. Keep "Veraldar" as the org
name; write prose as "I".

### 2. Keeping trust after the launch spike

The spike lasts 48 hours. Trust is decided by how the third week goes.

**Publish a support policy before launch** (`SUPPORT.md`): one person,
best-effort, a response window you can keep ("I read issues daily; fixes ship
as patch tags"); supported = Omarchy/Arch/Debian + Docker + Node ≥ 22 +
Tailscale + pinned opencode version; not supported = Vercel path, public
exposure, non-opencode harnesses; issue template first line: "Run
`scripts/selfhost-check.sh` and paste the verdict" (paste-safe, no secrets).

**Pin the opencode version.** The likely bugstorm source is opencode changing
its API underneath you, not your own code. Pin it in the install skill, state
it in the README, treat "new opencode broke Bifrost" as a planned event.

**Bugstorm playbook (first 14 days):**

1. Feature freeze — fixes and docs only.
2. One pinned "Known issues" issue, updated daily in brand voice
   (`install skill fails on Debian 12 w/o docker group — fixed in v0.6.1`).
3. Patch tags fast; release notes name the reporter.
4. Takedown rule (banner + top HN comment within 1h) stays.
5. **Reply yourself, never with an LLM.** One pasted agent reply turns the
   thread into "the author is a bot". If you used an agent to look something
   up, say so in the reply.

**Roadmap honesty: three words only — shipped / building / specced. Never
dates.** Connectors are "specced"; the delegate skill is "shipped" but is not
a connector — write that sentence before HN reads the README against the post.

**Day-7 retro with real numbers** — stars, clones, failed installs and why,
unrounded. That retro is the second launch post.

### 3. Spreading in a niche that suspects slop

People share things that are visibly real, a little imperfect, and easy to
copy. Ranked:

1. **The 30s demo with the phone's real speaker audio.** "If STT mishears,
   keep it" is the best line in the launch folder. One visible mistake that
   recovers proves the demo isn't staged.
2. **The uncut install run.** The "paste one link + set it up" loop is a
   format others can copy: "here's my install verdict on Debian / on a NUC /
   on a Steam Deck." Make the verdict output screenshot-worthy; ask people to
   post theirs. That spreads person to person.
3. **"I built Bifrost from Bifrost."** Voice request → commit → phone
   screenshot. Being made with agents isn't something to hide; it's the thesis
   demonstrated on itself.
4. **A latency table** for r/LocalLLaMA (Qwen3 MLX vs faster-whisper/Kokoro
   CPU, named hardware).
5. **r/omarchy coming home.** Warmest audience; already the most human draft.

What does NOT carry humanity: the lore, the Norse map, the manifesto, the
movie. A 9-day-old product with four mythological names and a slogan fits the
shape of AI-generated worldbuilding exactly. Keep the lore as a footer link;
out of launch posts. Release the movie after people use the product.

### 4. Risks

**AI-generated-marketing backlash.** The brand book and drafts were written in
agent sessions, and it shows: "They sell X; we give you Y" antithesis; triplets
of fragments ("Nothing public. No cloud speech API. AGPL."); self-labelled
sections ("Honest limits:", "What it is not:"); heavy em-dashes; identical
phrases across all five posts ("fresh off a fix", "battle-tested", "paste one
link… set it up… one manual step"). Cross-posted near-identical text is also
what astroturf looks like.

**Astroturf accusations.** One aged account per platform. Never ask for
upvotes; no friends' accounts; don't link the HN post from X; space the Reddit
posts; post as yourself, not a "veraldar" brand account.

**The "remote markdown runs on my box" attack (biggest technical trust
risk).** "Paste a raw URL into an agent and it clones, mints secrets, starts
docker" is `curl | bash` with an LLM in the middle, plus a prompt-injection
surface. HN will say exactly that. Get ahead of it:

- Pin the skill link to a commit SHA, not a tag.
- "Read the SKILL.md first — it's N lines" (real count).
- State what the agent will and won't do (sudo? check the skill; state truth).
- Manual path stays first-class, not a fallback.

**Disclosing AI help without undercutting the product.** Disclose as thesis,
specifically, without apologizing:

> Most of the code was written by coding agents (opencode, Claude), directed
> by me — a lot of it by voice from my phone, through Bifrost itself. I decide
> what ships, I test every release on my own phone, and the e2e suite runs
> daily. The commit log quotes my original requests.

Then be consistent: only 3 of 165 commits carry a Co-Authored-By trailer;
don't rewrite history (worse); add a short `AI-USE.md` (what is agent-written,
what you verify by hand, trailer going forward). Shorten commit subjects
going forward — the median subject today reads as machine-written.

### 5. 90-day plan, ranked by impact ÷ effort

| Rank | Tactic | Effort | Impact | When |
|---|---|---|---|---|
| 1 | Fix pre-flight items 1–9 | 2h | very high | before launch |
| 2 | Rewrite all five posts yourself: dictate, transcribe, edit lightly | 3h | very high | before launch |
| 3 | Pin skill to SHA + threat-model paragraph + line count | 1h | high | before launch |
| 4 | Record uncut install run + 30s demo (real speaker audio) | 3h | high | before launch |
| 5 | `AI-USE.md` + `SUPPORT.md` + selfhost-check issue template | 2h | high | before launch |
| 6 | Measure + publish latency table (MLX vs CPU, named hardware) | 2h | high (LocalLLaMA) | before launch |
| 7 | Launch day: reply to everything yourself, 3h+, no LLM replies | 1 day | very high | T |
| 8 | Feature freeze T+0–14, daily known-issues post, fast patch tags | ongoing | very high | T+0–14 |
| 9 | 7-day retro, unrounded numbers, as its own write-up | 3h | med-high | T+7 |
| 10 | "Built Bifrost from Bifrost" post (failures included) | 4h | high, most original | T+14–30 |
| 11 | Post in opencode's own community channels | 1h | med-high | T+20 |
| 12 | Users post install verdicts; gather in a Discussion | low | medium, compounds | T+14+ |
| 13 | Lore page and movie | high | low until users exist | T+60+ |
| 14 | Second Show HN — only if a connector actually ships | — | — | T+60–90 |

### Line edits to the drafts (apply via the dictation pass)

- **Show HN:** keep "I built Bifrost because I wanted to talk to my coding
  agent from the couch…". Cut the "What it is not… they sell model quality"
  paragraph (slogan rhythm). Replace "Honest limits:" with plain sentences.
  Add: AI-use disclosure, one real number (round-trip Xs on CPU fallback),
  "the install skill is N lines, pinned to commit abc123 — read it before you
  paste it". Mention how long it took and what broke.
- **X thread:** cut "Your coding agent takes orders by voice now" (generic
  hype), the AGPL triplet, and tweet 5's slogan. Open with the video + one
  plain first-person sentence: "I've been fixing bugs in this app by talking
  to my phone while walking the dog. Here's the actual audio, including when
  it misheard me."
- **r/LocalLLaMA:** drop the "normally means a cloud speech API" setup; lead
  with hardware + numbers table; name actual Qwen3 model sizes; local
  *speech* vs user-chosen LLM distinction up top.
- **r/selfhosted:** delete "The pitch:"; check sub rules on AI-built projects
  and follow disclosure requirements exactly; move the
  opencode-has-shell-access paragraph to the top.
- **r/omarchy:** "Rough edges:" instead of "Limits, honestly:"; add a photo of
  the actual desk and box.
- **Everywhere:** no phrase repeated across posts verbatim; each channel
  sounds like you talking to that room.
