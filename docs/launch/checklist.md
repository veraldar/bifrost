# Launch checklist — WAVE 1, gated on v0.7.0

Owner: LAUNCH session. Adopted ladder (docs/plan.md, CONDITIONAL GO):
pre-wave → **v0.7.0 the reliable voice** → **WAVE 1 techie launch** (hook-first
Show HN + cold-start video + 5–10 seeded testers) → v0.8.0 federation +
layman onboarding → v0.9 WSL → v1.0 consumer → v1.1 federation deepen.

**All docs/launch/* content is draft — the user publishes everything.**
Status: **ARMED pending the user go-call.** v0.6.0 shipped; v0.6.0-era trust
report delivered (`trust-viral.md`) and its decisions folded in.

## Gate A — product readiness (product session owns; LAUNCH verifies)

- [ ] **v0.7.0 "the reliable voice" tagged and published** — edge sherpa as
      Linux default (the Wave 1 release; nothing fires before this tag)
- [ ] Seeded-tester blockers triaged: every friction point from the feedback
      thread is either fixed in v0.7.0 or listed in the pinned known-issues
      issue
- [ ] Security claims true in copy: S2 (pinned tags + SECURITY.md) ✓ S3
      (BIFROST_AUTH=tailnet) ✓ — S1 device tokens is v0.9, never implied
- [ ] Install skill pin upgraded tag → commit SHA (trust-viral §4: tags can
      move); line count stated in the HN post

## Gate B — assets final

- [x] Positioning (`positioning.md`) — v3, version reality + honest limits
- [x] Channel drafts (`channels.md`) — hook-first HN titles, X thread, three
      subreddits, seeded-tester section, repo-first links
- [x] Video plans (`demo-script.md`) — cold-start (official Wave 1 artifact)
      + 30s cutdown
- [ ] **Dictation pass** on every post (trust-viral tactic #2 — base text is
      agent-written; the dictated human voice is the fix)
- [ ] Pre-flight repo sweep re-run against v0.7.0 (README clone line ✓ fixed
      in v0.6.0; re-verify: Vercel button/position, sponsor strings, "any
      Linux" wording, version consistency repo-wide)
- [ ] Cold-start video recorded: empty folder → paste link + "set it up" →
      verdict → phone talks. One take, visible clock, no cuts
- [ ] 30s demo recorded (phone speaker audio, no overdubs, captions burned)
- [ ] Latency table measured (MLX vs CPU, named hardware) → into LocalLLaMA
      post
- [ ] `AI-USE.md` + `SUPPORT.md` + selfhost-check issue template (product
      session handoff)
- [ ] Every post final-read aloud; repo link tested logged-out; SKILL.md raw
      URL resolves logged-out

## Seeded testers (Gate B hard requirement — 5–10)

- [ ] 5–10 testers invited privately, install via the agent-native loop
      themselves
- [ ] selfhost-check verdicts collected in the feedback thread
- [ ] ≥5 clean installs by strangers; friction list triaged (see Gate A)
- [ ] Tester rules acknowledged: free speech, disclosure if they post, no
      coordinated posting, quotes published only if offered by name

## T-day (the user fires; sequence, all within ~2h)

- [ ] Morning: our own stack healthy — `lk-verify.timer` green, one real
      voice turn (we demo what we run)
- [ ] Show HN 07:00–09:00 US Pacific, Tue–Thu; author watches replies 3h min
- [ ] X thread + videos within the hour (repo link, never the HN link)
- [ ] r/LocalLLaMA → r/selfhosted → r/omarchy staggered ~30 min
- [ ] Every reply human-written — no LLM drafts; agent-assisted lookups
      disclosed in the reply
- [ ] Aged personal accounts only; no upvote asks; no brand account
- [ ] `docs/launch/results.md`: links, timestamps, first impressions

## Post-launch (first two weeks)

- [ ] Feature freeze T+0–14 (product session): fixes + docs only
- [ ] Pinned "Known issues" issue updated daily, brand voice; fast patch
      tags, notes name the reporter
- [ ] "Local LLM?" misread corrected every time (local *speech*, user's LLM)
- [ ] v0.8.0 questions (federation, /pair, iPhone): "specced, on the ladder"
      — link the spec, promise nothing
- [ ] Install-breaking bug → top HN comment within 1h + repo banner same day
- [ ] Day 7: `retro.md` with unrounded numbers (stars/clones/failed installs)
      — that retro is the second launch post
- [ ] Day 14: start trust-viral 90-day tactics #10+ ("Built Bifrost from
      Bifrost" post, opencode community, install-verdict Discussion)
