# Outside critique — bifrost roadmap + go-to-market (2026-10-02)

Read: plan, vision, roadmap-proposal, launch/{positioning,channels,checklist}, brand, comms/channels, README.

Headline: the plan is internally rigorous and externally untested. Eight weeks of ladder, zero users. The biggest risk is not sequencing, it is that the first-run experience on the default install path is slower and clunkier than your own docs admit, and the docs have not been reconciled with v0.6.

---

## 1. SEQUENCING

**POSITION:** Right shape, wrong order at both ends. Launch is correct to do first, but v0.7 is padded, and v0.9 should not gate v1.0.

**REASONING**
- v0.7 bundles wedge-fix, mictap, voice knobs, *and* the voice-lab P2 remainder (CPU bench, FR corpus, streaming STT) plus a P3 winner spec. Only wedge-fix and the free `streaming_interval` win (1.19s → 0.19s first audio) are launch-relevant. The rest is research dressed as polish. 5–8d will be 3 weeks.
- Your own voice-models table says the default no-Mac, docker path (faster-whisper 5.5s wall + Kokoro CPU 1.6–5.3s) is 7–10s per turn. Your hands-free gate is "<2s round-trip". The edge sherpa server (7/7 PASS, rtf 0.29/0.26) is the fix, and it is parked in v0.8 as a *Windows* feature. It is the *Linux default* fix. HN will try the CPU path, not your Mac Studio.
- The README hardware section is a Mac Studio M3 Ultra. The launch demo will be shot on it. The viewer's box will not be.
- Windows-before-switcher is defensible on effort, but both are consumer moves. For a terminal audience, WSL2 is a real segment (many HN devs are on Windows+WSL) and is cheap (0.5–1d validation, bootstrap unchanged). Switcher is 2–3 weeks for a "TV PC" story that no enthusiast has asked for.
- v1.0 is gated on the switcher purely because onboarding phase 2 "shares a seam". That is an engineering coupling being promoted to a product gate. Consumer v1.0 needs QR pairing and Android proof; it does not need N backends.

**RECOMMENDATION**
1. Cut v0.7 to: wedge-fix, mictap, `streaming_interval` knob, **edge voice as the Linux no-docker default**, refreshed known-limits. Everything else from voice-lab moves to background.
2. Launch wave 1 on that tag.
3. v0.8 = WSL2 one-click only (validation + PS wrapper), 1 week. Do not wait for a "real Windows box" to be a blocker: borrow one for 2 days or run a Windows VM; if neither exists, ship WSL as "experimental, tested on X".
4. v0.9 = QR `/pair` onboarding + android-lab green. This *is* the consumer gate. Ship v1.0 on that.
5. Switcher → v1.1, driven by wave-1 evidence (your own "evidence-triggered" rule, applied consistently). The TV/media skill is a demo, not a release; it can be a video using two PWAs in two tabs.
6. Cut from the ladder entirely: native no-WSL Windows, VoxCPM2 emotion tier in v1.0 (the 35.6Hz identity spread is a taste gamble), yggdrasil Rust lab and hardwar as anything the public ever hears about. Labs that "feed" nothing should not appear in a release table.

---

## 2. GO-TO-WORLD

**POSITION:** Channel mix is fine. The missing move is a *proof asset*, and the wave-1 timing assumes a brand that does not exist yet.

**REASONING**
- Highest-leverage underweighted move: **a single unedited, timed, cold-start screen recording of "paste link → agent installs → phone talks back" on a clean VM, with a real clock, on the CPU path.** Not a 30s vertical cut. The install-by-agent claim is your hook, but it is also the thing HN will not believe. Showing it fail-safe (agent verifies each layer, prints verdict) is the credibility.
- Your demo-script is 30s with burned captions. Fine for X. HN needs the 3-minute honest one linked from the first comment.
- Zero presence means zero first-hour votes. Show HN works on ranking velocity; a new account with no history and the title "Bifrost – ..." that tells nothing about the hook will land on /shownew and die. The title should lead with the hook: *"Show HN: Paste a link into your coding agent and it installs a phone voice remote"* beats the product-name title.
- The channels file is still gated on **v0.4.0** and says hands-free is "fresh off a fix". v0.6.0 is out and the human pass passed. Posts, checklist Gate A, and README clone URLs (`veraldar/yggdrasil-bifrost`) all describe a product that no longer exists. Launch is blocked by stale docs, not by code.
- Sequencing channels at 30-minute intervals by one person is a bandwidth bomb: Show HN needs 3h of attention and r/LocalLLaMA hostility is a second job. Pick **one** primary (HN or LocalLLaMA) per day.
- Launch before Windows: yes. But launch before the *CPU voice path* is fixed: no.

**RECOMMENDATION**
- Day 0: Show HN only, with hook-first title and the 3-min unedited video. X same day, passive. Day +2: r/LocalLLaMA (angle: the measured latency tables, which are genuinely novel). Day +4: r/selfhosted. r/omarchy last or whenever (low stakes).
- Record the demo on the edge/CPU path on a box that costs under $300. If it needs a Mac Studio, say so in the video.
- Seed 5–10 real people (Discord/omarchy forums) *before* day 0 to install it cold and report. Their stumble log is the real Gate B.
- Tuesday–Thursday is fine; do not launch the week of a big model release (check before firing).

---

## 3. BRANDING

**POSITION:** A complexity tax. Ship one name at launch.

**REASONING**
- Three names for one product (Veraldar / Yggdrasil / Bifrost) plus Midgard, roots, and "the warden" is a lore-system with one product in it. The brand book itself admits "Midgard/Asgard are lore-copy only", i.e. you already know it is too much.
- HN and r/selfhosted are allergic to mythology-heavy startups; "What AI can simulate, AI can create." is a manifesto with no product claim. On HN it reads as a pitch deck. Your own tone rules ("terse, honest, terminal-native") contradict the manifesto.
- Namespacing rule "one brand, many products" is premature. The repo is `yggdrasil-bifrost`, docs say `veraldar/bifrost`, the org doesn't exist yet. README ships a `github.com/veraldar/yggdrasil-bifrost` clone URL and the install skill URL; **renaming after launch breaks every pasted install line** (redirects help GitHub but not cached agent skills).
- Loyalty clause is good. It is also unreadable as launch copy and invisible to users. It belongs in a `PRINCIPLES.md`, not the landing.

**RECOMMENDATION**
- Launch name: **bifrost**, one line, "a Veraldar product" in the footer at most. No Yggdrasil in the README until the agent core is a thing you ship (today it is opencode: calling it Yggdrasil is false-ish).
- Rename the repo to `veraldar/bifrost` (or just `bifrost` under a personal account) **before** wave 1 and fix the skill URL once. Do not launch under a slug you plan to change.
- veraldar.org: not at launch. Point everything at the repo. A one-page site is a distraction until stars > 200 or someone asks. If you keep a page, it is the README with a video, no lore.
- Move the lore to `docs/lore.md`, linked once from the footer.

---

## 4. EASE-OF-USE — where the first 100 stumble (ordered by kill-potential)

1. **Voice latency on the CPU path (kills it silently).** faster-whisper small = 5.5s wall; Kokoro CPU up to 5.3s. Users conclude "it doesn't work". *Fix v0.7:* edge sherpa server as default when no Mac/GPU; show measured RTT in the PWA header.
2. **Tailscale HTTPS + mic.** The phone mic needs a secure context. `tailscale serve` needs MagicDNS + HTTPS certs enabled in the admin console, and the *phone* must be on the tailnet. This is a 4-click admin-console detour nobody warns about. *Fix v0.7:* the install skill detects `tailscale serve` failure and prints the exact admin URL; bootstrap ends with a `/selfcheck` page that tests mic permission, WebRTC ICE, and tailnet reachability from the phone.
3. **ICE/LiveKit config.** README step 1 tells users to edit `livekit.yaml` ICE IPs by hand; host-network docker; wrong IP means connect-then-silence. *Fix:* skill writes it, and the PWA shows "media: connected / ICE failed: <reason>", not a spinner.
4. **Agent-install skill reliability.** It runs on whatever model the user's agent has. A weak model skips a verify step. *Fix:* make the skill call one deterministic `scripts/bootstrap.sh --check` and trust its exit code, not prose.
5. **`opencode auth login` ordering.** It is manual and the agent session running the install may itself be using that auth. Say where it goes in the sequence and detect "no provider configured" in the PWA first message.
6. **Hands-free and echo on real phones** (Android battery/notification rules unproven, android-lab unverified). PTT must be the default; hands-free opt-in.
7. **Manual path (README) is 5 terminals.** Many will skip the agent install out of distrust (see §5). Collapse into `scripts/bootstrap.sh` and make the README manual path one command.
8. **Docker not required but README says it is.** Resolve once edge ships.

---

## 5. BLIND SPOTS

**POSITION:** Security story and maintainer load are the two that can end the project; neither is in the launch plan.

**REASONING**
- **"Paste this URL into your agent and say set it up" is a prompt-injection / supply-chain pattern.** An HN top comment will say exactly that, within the hour. The skill fetches from `raw.githubusercontent.com/.../main/` (mutable), clones, runs shell. No pin, no checksum, no signed tag. The installed system is an *agent with shell access, reachable by phone*. The README's Vercel button text says `OPENCODE_URL` must be reachable from the deployment: i.e. it nudges people toward exposing a shell-capable server. The threat model is absent from every launch doc.
- Tailnet-only is a good claim, but tailnet = everyone on it (shared nodes, family devices). A stolen unlocked phone = shell on the dev box. Needs: pairing auth on the proxy, a "revoke device" action, permission profile for voice (the TV plan auto-allows media commands: the same mechanism will be asked to auto-allow `rm`).
- **Solo maintainer, AGPL, self-hosted** = every install problem is yours, across distros you cannot test. No issue templates, no `bifrost doctor` output to paste, no support policy. Launch day will produce 40 "doesn't work" reports and you will answer them alone for a week while also writing the wave-2 code.
- **Metrics**: stars/clones/karma (comms metrics.md) measure attention. The only metric that matters: *installs that reached a successful voice turn.* There is no telemetry (good, brand-consistent) so you need an opt-in "it worked / it didn't" `bifrost report` command, or a GitHub Discussion template. Without it the "evidence-triggered" culture is blind: your demand signal is HN comment sentiment.
- **"Honest limits" reads as "toy"** when stated four times in every post, before the value. The honesty move is right; the *ordering* is wrong. Lead with the demo, state limits in one line, put the full block in the first reply. Also: one limit is stale (hands-free fresh-off-fix) and will read as unreliability.
- **Competitive timing**: phone-remote-for-agent is a feature, not a moat. Claude Code, Codex, and Cursor already ship mobile/web handoff or will. Your durable edge is *self-hosted + local speech + your own agent*. The positioning table compares to Cursor/Copilot; the real comparison on HN will be Claude Code remote/mobile, OpenAI voice, Happy/CloudCLI-style OSS remotes. Do a competitor teardown before writing "nobody does this".
- **Doc rot.** launch/ and comms/ still target v0.4.0/v0.5.0, the calendar has a v0.5.0 slot, positioning says "hands-free had a known bug". Three planning docs disagree on what v1.0 contains (plan: QR+android; roadmap: +switcher+TV; comms: QR+android). Source-of-truth drift is how a solo-AI-assisted project ships contradictory claims publicly.
- Smaller: Sponsors/OpenCollective "pending" in README says "every franc" (nobody on HN says franc; reads as odd), remove until live. README architecture lists Mac Studio hardware as a node: reads as "requires a Mac". YouTube weekly cadence for a solo founder is unrealistic; plan for one video per release.

**RECOMMENDATION**
- Write `SECURITY.md` + a threat-model section in the README *before* wave 1: pin the skill to a tag/commit SHA (README line carries the pinned URL), show what the skill will run, add device pairing + revoke, and explain the injection question first.
- Add `bifrost doctor` (paste-able diagnostics) and an issue template that requires it.
- Define success as "N cold installs reached a voice turn", measured via the seeded testers + opt-in report.
- Do a one-page competitor check against Claude Code mobile/remote and OSS agent remotes now.

---

## REVISION BULLET LIST

1. Shrink v0.7 to wedge-fix, mictap, streaming_interval knob, and edge CPU voice as the Linux default; move voice-lab P2/P3 to background.
2. Move the switcher and TV/media skill to v1.1; make QR `/pair` + android-lab green the v1.0 gate.
3. Keep v0.8 as a one-week WSL2-only script; drop native Windows and VoxCPM2-in-v1.0 from the ladder.
4. Rewrite launch Gate A, positioning limits, and all post drafts against v0.6/v0.7 reality; delete the stale "hands-free fresh off a fix" line.
5. Rename the repo once (veraldar/bifrost) and fix README + skill URLs before wave 1; pin the skill URL to a tag.
6. Launch as "bifrost" only: no Yggdrasil/Midgard/manifesto in README; move lore to docs/lore.md; no veraldar.org at launch.
7. Retitle Show HN around the hook (paste a link, agent installs it) and attach an unedited 3-minute cold-install video on the CPU path.
8. Stagger channels over a week (HN → LocalLLaMA → selfhosted), and seed 5–10 cold-install testers before day 0.
9. Add SECURITY.md/threat model, device pairing + revoke, a `bifrost doctor` command, and a selfcheck page covering Tailscale HTTPS, mic, and ICE.
10. Replace star/karma metrics with "cold installs reaching a voice turn", and add a competitor teardown plus a single-source-of-truth ladder (plan.md) that comms/launch docs reference.
