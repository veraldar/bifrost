# Launch checklist — GATED on v0.4.0

Owner: LAUNCH session. **Hard rule: no public post, page publish, or
"available" wording anywhere until Gate A passes.** Watch `docs/plan.md`
(release ladder) + `git tag` for the product session's readiness signal.

## Gate A — product readiness (owned by the PRODUCT session, we only verify)

- [ ] `git tag v0.4.0` exists and GitHub release published
- [ ] Hands-free human pass ticked in `docs/plan.md` (5-min conversation,
      turn-taking ≤2.5s, no echo, TTS intelligible, <2s round-trip,
      no double-speak, keyboard mode drops OS mic)
- [ ] hf-restart fix confirmed in release notes (`1d34b63`)
- [ ] Known-limits block present in the v0.4.0 release notes
- [ ] "What you need" list in release notes (1 box, docker, Node ≥ 22,
      LLM key, tailscale optional)

If ANY gate fails → hold. Drafts stay drafts. Re-check `docs/plan.md`.

## Gate B — assets final

- [ ] Landing page (`docs/launch/landing.html`) hosted — decide: GitHub Pages
      (zero infra, fits AGPL repo) vs Vercel (already validated for the PWA).
      Default: GitHub Pages. **OPEN DECISION — see open-questions.**
- [ ] Landing page version badge updated to v0.4.0 (currently version-neutral)
- [ ] Landing page "hands-free is fresh off a fix" line re-checked against the
      actual human-pass result — delete it only if the pass was clean AND the
      product session agrees
- [ ] Demo video recorded per `demo-script.md` (30s vertical + 16:9 cut),
      captions burned in, end card has repo URL
- [ ] README front page polish: install one-liner is the FIRST thing after the
      title; honest-limits paragraph present; architecture kept further down
      (draft of front-page edits below — requires product-session merge)
- [ ] All channel posts from `channels.md` final-read aloud once (typos +
      tone); repo link in each post verified in an incognito window
- [ ] Skill raw URL resolves for a logged-out visitor (the HN crowd will paste
      it before cloning)

## Gate C — launch day (T-day)

- [ ] Morning: verify live stack healthy on our own box (we demo what we run:
      `lk-verify.timer` green, PWA up, one real voice turn)
- [ ] Publish landing page
- [ ] Show HN posted (07:00–09:00 US Pacific, Tue–Thu) — author watches
      replies for 3h minimum
- [ ] X thread + video within the hour (link repo, not the HN post)
- [ ] r/LocalLLaMA → r/selfhosted → r/omarchy staggered ~30 min apart
- [ ] Create `docs/launch/results.md`: per-channel links, timestamps, first
      impressions

## Post-launch (first week)

- [ ] Answer every comment; log recurring questions → `docs/launch/results.md`
- [ ] If a channel asks for things v1.0 already plans (QR pairing, more
      harnesses): "on the roadmap, specced" — link the spec, promise nothing
- [ ] Watch for the #1 misread ("local LLM?") and correct gently, every time
- [ ] Takedown rule: if a serious install-breaking bug is found post-launch,
      add a banner to the landing page + top-level comment on HN within 1h
- [ ] After 7 days: write `docs/launch/retro.md` (what channels moved stars/
      clones; keep numbers honest, no vanity rounding)

## README front-page polish (draft — product session merges, LAUNCH never edits product code)

Move to directly under the title:
1. One-liner: "Talk to your coding agent from your phone. Self-hosted,
   voice-first, tailnet-private, AGPL."
2. The install one-liner block (already there — promote above the fold, it is).
3. A 4-line "honest limits" callout (enthusiast release; docker + Node ≥ 22 +
   LLM key; hands-free note per Gate A outcome; opencode harness today).
4. THEN "Easiest install", architecture, env vars as today.
