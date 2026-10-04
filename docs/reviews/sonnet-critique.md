# Outside critique — bifrost roadmap, architecture, security (Sonnet 5.5, 2026-10-03)

Independent review. Did not read docs/reviews/. Evidence: plan/vision/roadmap-proposal/positioning/checklist, `pwa/app/api/*`, backup.sh, SKILL.md, systemd units, `ss -ltn`, `tailscale serve status`.

## 1. SEQUENCING
**POSITION:** The ladder is wrong in two places: the switcher/federation does not gate v1.0, and security debt (S1 device tokens) is sequenced *after* the launch that makes it matter.

**REASONING:**
- v0.7 "reliable voice" bundles wedge-fix, mictap, streaming knob, edge-sherpa default, S3 fix, voice-lab remainder. That is 5–8d of estimate for a solo founder; real is 2–3 weeks. Every week of silence is lost positioning, as the proposal itself admits, then it schedules a week of polish anyway.
- v0.8 Windows-WSL is a *consumer* feature on a roadmap whose wave 1 is explicitly terminal people. Windows users who can run WSL2 + Tailscale + LLM key are not who the HN audience is; you will spend 1 week and need hardware you don't own. The 100 users from wave 1 will mostly be Linux/Mac. Windows is unevidenced demand. Evidence-triggered culture applies here too.
- v0.9 bundles QR pairing, device tokens, push, android-lab, and a *federation spec*. v1.0 "consumer" depends on cross-machine architecture that was invented yesterday. The consumer promise ("one PC, QR, done") needs pairing + auth, not federation. Multi-tree is a power-user feature of a product with zero users.
- The first 100 users will tell you whether anyone has a second PC. You are designing v1.1 on n=1.

**RECOMMENDATION:**
1. Cut v0.7 to: wedge-fix, mictap, S3 fix (auth), SECURITY.md, honest limits. Everything else (voice knobs, edge default, voice-lab P2) moves to post-launch. Ship in ≤1 week.
2. Launch wave 1 immediately after.
3. v0.8 = **pairing + device tokens (S1) + /selfcheck**, not Windows. These are required by every consumer path (Tier 1 hosted, QR, federation) and also fix your worst security hole.
4. Windows WSL only when ≥ N inbound requests in results.md (set N=10). Until then a docs page "WSL2 works, unsupported."
5. v1.0 = single-tree consumer: pair + android-lab green + decision tree. **Federation is v1.1+, evidence-triggered.**

## 2. GO-TO-WORLD
**POSITION:** Channels are fine; the plan is over-engineered for a launch with a handful of unknowns. Highest-leverage move: a 60–90s cold-start video of *a stranger-style, one-take install-by-paste then talking to the agent from a phone*, posted as the HN/X/README top asset.

**REASONING:**
- "Paste one link into your agent and say set it up" is the only hook that is genuinely novel. Voice remote for a coding agent is a category others are filling (Claude Code remote/voice, Happy, Termius+dictation, opencode's own clients). Your durable differentiators are self-hosted + local speech + agent-native install. The demo shows all three in one clip.
- Plan has dictation pass of five posts, seeded cold testers, staggered subreddits — fine, but the checklist still has unchecked pre-flight items that contradict reality (public copy says v0.4.0; v0.6.0 shipped; README clone-path mismatch). Doc rot will be the first HN comment.
- r/omarchy and r/selfhosted are the best-fit audiences; HN is high variance, and a 1-person project with install-by-AI-skill will draw "you want me to pipe a mutable URL into an agent that runs shell?" as the top comment (see §6).

**RECOMMENDATION:** Fix SKILL pin + SECURITY.md **before** posting; film the cold-start; lead the Show HN with the video link in the first comment and the repo as URL. Seed 5 testers *now*, not at day 0, because their friction is your launch-day FAQ.

## 3. BRANDING
**POSITION:** Veraldar / Yggdrasil / Bifrost is a complexity tax at first release. Use one name.

**REASONING:**
- Three nouns plus a lore map (world/tree/bridge/roots) before a single user knows what the thing does. The rule "one lore line at most per post" is an admission it costs comprehension. Users must learn that the PWA is "Bifrost", the agent core is "Yggdrasil", the org is "Veraldar", and the actual runtime is "opencode".
- Repo slug history is already messy: README/SKILL/launch docs reference `veraldar/yggdrasil-bifrost`, git origin says `veraldar/bifrost`. GitHub redirects will work, but pinned URLs in a *shell-running skill* must not rely on redirects.
- veraldar.org as a launch asset is a distraction; as a *trust layer* it signals "company" for a one-person AGPL repo. The "I, not we" rule in the positioning doc is right and contradicts the org framing.

**RECOMMENDATION:** Launch as "Bifrost" only. No Yggdrasil in user-facing text until the Rust core exists. veraldar.org: a one-page static stub with name, contact, security.txt, license; no lore. Decide the slug once (`veraldar/bifrost`), grep and fix every doc/skill URL, pin to tag/SHA.

## 4. EASE-OF-USE — where first 100 users die (kill order)
1. **`opencode auth login` mid-install** — an agent-run skill hits a human-only step; the agent stalls with confusing state. Fix: bootstrap prints a single boxed "DO THIS NEXT" and the skill stops and says it verbatim.
2. **Tailscale HTTPS/MagicDNS not enabled** — `tailscale serve` fails or the PWA is HTTP-only, so mic access (getUserMedia needs secure context) silently fails. Fix: /selfcheck page + bootstrap check for `tailscale serve` + cert; hard error with the admin-console URL.
3. **WebRTC media path** — livekit.yaml `rtc.ips` pinned to detected IPs; wrong on multi-NIC, VPN, laptop/DHCP changes, and colima/macOS (your own SKILL calls it "#1 trap"). Fix: selfcheck does a loopback WebRTC probe from the *phone* ("Test audio path" button) and prints which candidate failed.
4. **Docker + Node ≥ 22 + uv + speaches model download (GBs)** — first run looks hung. Fix: progress output and an explicit size/time estimate; edge-sherpa default (the v0.7 item worth keeping) removes docker for most.
5. **iOS Safari PWA** — mic, background audio, push all behave differently; the plan has Android lab and one tested device. Fix: state iOS status in README line one of limits; test on one iPhone before launch.
6. **Wedged/silent runs** — you had a 15-min no-reply corpse. Keep wedge-fix as the v0.7 core.
7. **Hands-free echo/VAD on other devices** — label experimental.

## 5. BLIND SPOTS
- **Maintainer load:** 100 users × a 6-moving-part stack (opencode, LiveKit, speaches/sherpa, agent, Next, Tailscale) = issues you can't triage. Set a support budget (e.g. 3h/week), a `/selfcheck` that emits a pasteable report, and an issue template requiring it.
- **Upstream dependency:** you drive `opencode serve` whose API you've already seen break (variants dropped in v1.18 forced the model-name hack in `session/[id]/route.ts`). A minor opencode release can brick all users. Pin and test against a supported version range; surface the version in selfcheck; contract tests exist, run them in CI against `latest`.
- **No metrics:** "demand signal" is the stated measurement but there's no telemetry and no plan. Count GitHub clones, stars, install-skill fetches (via release asset download count), selfcheck reports. Decide the three numbers that would make you build Windows/federation *before* launch.
- **Doc rot / process sprawl:** 20+ docs including phase-log, MERGE-NOTES, claims.md, journal; checklist still says v0.4.0. The "session claims" process is overhead for one person. Public-facing truth = README + SECURITY + KNOWN-LIMITS; everything else is notes.
- **Competitive timing:** first-party vendors ship mobile/voice for their own agents on a monthly cadence. Your moat is not features; it's "self-hosted, any agent, auditable." Don't spend weeks on voice quality (VoxCPM2 emotion tier) while that is unproven to matter.
- **Labs as roadmap:** yggdrasil (Rust core), dreaming, TV skill, connectors, SIP are specs with no users. Park them in one `ideas.md`.
- **AI-written everything:** the checklist itself notes agent-polished copy "costs the launch." Same applies to README/SKILL; read them aloud.
- **Telemetry in `.diag` / console logs:** diag logs on disk contain page URLs and session slugs (§6).

## 6. SECURITY
**POSITION:** "Tailnet-only, so no auth" is a defensible v0.x posture *for one user's tailnet*, but it is sold as more than it is, one footgun (`IS_VERCEL_PREVIEW=true`) already negates the guard, and several items are real defects.

**Findings, ranked:**

1. **HIGH — Install skill supply chain.** SKILL.md clones `main` of a GitHub repo and runs `bootstrap.sh` (curl, docker, installs opencode, writes systemd units) autonomously under an agent with shell access. Mutable ref + redirecting slug + no signature. Anyone who takes over the org/repo/redirect owns the user's box and LLM key. *Fix:* pin to tag and commit SHA, verify `git rev-parse HEAD`, publish SHA256 of bootstrap.sh in the release notes, print script before run, drop auto-install-opencode curl-pipe or pin its hash. Say this in SECURITY.md before HN does.
2. **HIGH — Guard bypass.** `pwa/.env.local` sets `IS_VERCEL_PREVIEW=true`, and `token/route.ts` allows if `NODE_ENV==='development' || IS_VERCEL_PREVIEW==='true'`. The comment "THIS API ROUTE IS INSECURE" is therefore disabled on the production `next start`. Anyone who can reach port 8080/the serve URL (any tailnet device, a shared node, a compromised tailnet peer, or Tailscale Funnel by mistake) mints a 15-min LiveKit JWT with `canPublish` and agent dispatch for **any room name**, joins the voice session of any session, and—because the agent bridges speech to opencode—*drives the coding agent*. Dispatch also creates agent jobs on demand: free resource exhaustion. *Fix:* delete the env bypass; replace with a real check (device token, §below). Never ship `IS_VERCEL_PREVIEW=true` from bootstrap.
3. **HIGH — The real RCE surface is /api/session + token.** The PWA proxy exposes create/prompt/delete on opencode with whatever permission mode it runs in (agents commonly run with auto-allow for voice use). Tailnet membership = shell on the box. On a personal tailnet that's accepted; on a shared tailnet (family, work, shared nodes, tagged CI) it isn't. *Fix:* device-token middleware on every `/api/*`, plus documented threat model: "anyone on your tailnet can run commands as you; use ACLs to restrict to your phone".
4. **MED-HIGH — Artifact serving.** `/api/artifact/[name]` serves `.html` as `text/html` same-origin with no CSP/`X-Content-Type-Options`/`Content-Security-Policy: sandbox`. Inline chat uses `sandbox=""` iframes (good: no scripts), but the same URL opened as a top-level navigation (tap "open", the `/artifacts` gallery link, shared link) runs agent- or prompt-injected-authored JS in the PWA origin: it can `fetch('/api/token')`, `/api/session/*` (drive opencode), read `/api/diag`, and subscribe push. A prompt-injected web page that makes the agent write an HTML artifact is a plausible chain to RCE. *Fix:* send `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:` and `X-Content-Type-Options: nosniff` on every artifact response; or serve html as `text/plain` unless fetched with `sec-fetch-dest: iframe`; ideally serve artifacts from a separate origin (distinct port/host).
5. **MED — LiveKit exposure.** `ss` shows `*:7880` and `*:7881`, `bind_addresses: 0.0.0.0` in the example. Anything on the LAN/VPS public IP reaches the signalling API and RTC TCP. Key ID is the literal `devkey` (bootstrap line 58); only the secret is minted, so security rests on secret strength and `.env.local` perms. `pwa/.env.local` is mode 0644 (verified), holding LiveKit secret and VAPID private key; any local user can read it. On a VPS install (planned Tier 1) this is public. *Fix:* bind to tailscale IP/127.0.0.1 (rtc ports need LAN only if desired), random key *ID*, `chmod 600` all generated env files, firewall note in bootstrap.
6. **MED — Backups ship plaintext secrets to another machine** (`backup.sh` deliberately includes `.env*`, `~/.config/opencode` incl. `auth.json` LLM tokens, VAPID, the whole opencode DB with all session contents/code, systemd units) over SSH to the Mac, 14 hardlinked snapshots, unencrypted, plus the Mac's own backups (Time Machine/iCloud?) multiply copies. Also `rm -rf` prune via ssh. *Fix:* encrypt (restic/borg/age), separate secrets set with its own retention; or exclude `.env`/auth.json and rely on re-mint; ensure destination is FileVault'd. And it is a script in the public repo suggesting users do the same: ship it as personal ops, not product.
7. **MED — /api/diag and /api/push unauthenticated.** diag POST appends up to 500 events × 2KB per request to disk with no size/rate limit (disk-fill DoS, log injection with newlines in `msg`); GET returns the last 32KB of logs containing page URLs/session slugs/error bodies ("net-fail captures error bodies" — may include prompts or tokens). push POST accepts arbitrary subscription objects → server-side requests to attacker-chosen endpoints (SSRF-ish) when notifications fire; DELETE lets anyone drop subscriptions. *Fix:* auth, size limit, strip newlines, allowlist push endpoint hosts (fcm.googleapis.com, web.push.apple.com, *.push.services.mozilla.com, wns).
8. **LOW-MED — Room-name trust.** Room = sanitized client string; identity `user_<room>`. No binding between a device and a session. Fine until multi-user.
9. **LOW — opencode on 127.0.0.1** is correct; Next binds 127.0.0.1:8080 behind `tailscale serve`, correct. Keep. But `speaches` on `:8000` and Mac speech on `192.168.x:8001` are plain HTTP on LAN: STT audio and TTS text cross the LAN unencrypted.

**Auth the seam needs, by stage:**
- **Now/before launch:** remove bypass; static per-install bearer secret (minted by bootstrap, stored in PWA localStorage via QR/URL fragment) checked by middleware on all `/api/*`. Cheap (1d) and kills findings 2, 3, 7 for non-tailnet-trusted callers.
- **/pair (v0.8):** one-time pairing code → per-device token (hashed server-side, revocable, listable, rotatable, scoped: `chat`, `voice`, `admin`). Token → LiveKit JWT room-bound to the session the device may access.
- **Vercel-hosted PWA (Tier 1):** it is a different trust model. The hosted origin must never hold the LiveKit secret or proxy to a box; the box must expose an authenticated endpoint and LiveKit must be reachable from the public internet → needs TLS, auth, rate limiting, and an abuse threat model. Do not call this "self-hosted" or "private" in copy. Also the PWA code is served by a third party: a compromised Vercel account = code execution in the user's origin (which drives their agent). I would defer Tier 1 until you can state a clean threat model.
- **Federation:** peer auth with mTLS or signed tokens bound to peer identity and Tailscale node identity (verify via `tailscale whois` on the source IP), not a copied bearer secret; per-peer scopes; deny-by-default.

## 7. FEDERATION PIVOT
**POSITION:** Unified federation is the wrong *first* multi-tree architecture; it is a good v2 idea and the user "won" the argument against a straw man. Do the dumbest thing first (per-bridge list, grouped), and decide on evidence.

**REASONING:**
- **Solo-founder complexity:** it needs peer discovery (tailscale API/mDNS-over-tailnet?), a peer trust model, server-to-server fan-out, aggregation, pagination/ordering across trees, label scheme, push routing, version-skew handling. That is a distributed system with a security boundary per hop; your single-instance seam isn't even authenticated yet.
- **Failure modes you didn't write down:** partial availability (one PC asleep → list hangs or session vanishes: need per-peer timeouts and a "stale" state, not a spinner); version skew (peer on v0.9 returns a shape the aggregator on v1.1 doesn't parse; you need a versioned peer API and capability negotiation); identical session names across trees (`room = slug` is used as LiveKit room, JWT identity, and opencode session id; collisions across trees are guaranteed: namespace as `tree/slug` everywhere including the token route); voice: which instance holds the LiveKit room and speech stack for a federated session? "Server-to-server relay" for audio implies either LiveKit hops or the phone connecting directly to the owning tree, which breaks "one seam".
- **Blast radius:** a federated hub that can drive every tree means compromise of the phone's instance = compromise of all PCs. The switcher keeps the phone as the sole credential holder per bridge; federation centralizes it on a server.
- **Notifications:** push is registered per instance (VAPID keys per box). In a federated view, tree B's completion must route via tree A's push or each tree pushes itself under a different service worker scope — unresolved.
- **What consumers want:** "which PC am I talking to" is not a nuisance, it's safety. "Run the delete" going to the wrong machine is a worse failure than an extra tap. Most consumers have one PC; the TV scenario is a *named* device ("Living room"). A unified list is wanted by power users with 3+ machines, i.e. nobody yet.
- **Gates:** it moves federation out of the v0.9 gate (good, your plan already does), but v0.9 still lists "federation spec signed off" — remove it; a spec is a cost without evidence.

**RECOMMENDATION:** Keep the vision, defer the build. Step 1 (cheap, forward-compatible): add `tree` as a first-class field in session IDs, tokens, and rooms now (`tree/slug`), per-device tokens, and a versioned `/api/v1/*`. Step 2 (when ≥ N users report >1 PC): client-side multi-bridge — the phone holds N (base_url, device token) pairs and fans out *itself*, merges into one list with tree chips. This gives you the unified view with no server-to-server trust, no peer discovery, and failures isolated per bridge. Federation proper only if cross-tree actions (move session, share context) are demanded.

---

## REVISION BULLET LIST
1. Delete `IS_VERCEL_PREVIEW` from the token guard and from every generated/ live `.env.local`; add middleware auth on all `/api/*` before launch.
2. Add CSP `sandbox` + `nosniff` headers (or separate origin) to `/api/artifact/*`; test top-level navigation of malicious HTML.
3. Pin the install skill to a tag + commit SHA; publish bootstrap.sh hash; write SECURITY.md with the "tailnet = shell" threat model.
4. Bind LiveKit to tailscale/loopback, randomize the API key ID, `chmod 600` generated env files.
5. Encrypt or de-secret `backup.sh` output; label it personal ops, not product.
6. Auth + size-limit + newline-strip `/api/diag`; allowlist push endpoint hosts.
7. Cut v0.7 to wedge-fix, mictap, auth, limits; launch within a week of it.
8. Replace v0.8 Windows with pairing + device tokens + /selfcheck; Windows only on measured demand.
9. Decouple v1.0 from federation/switcher; namespace sessions as `tree/slug` now; build client-side multi-bridge on evidence, not server federation.
10. Launch under the single name "Bifrost" with a cold-start install video; fix the slug, version and README drift first; define three success metrics and a support budget.
