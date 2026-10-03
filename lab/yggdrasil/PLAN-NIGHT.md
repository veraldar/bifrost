# PLAN-NIGHT — build through the night, report at dawn (2026-10-03 → 10-04)

Orders consolidated (three driver messages, one controlling): THE PACKAGE by
morning = yggdrasil binary (slices 1-4+6a stand) + bifrost-net M0+ (access
point: boringtun mesh, two nodes, str0m WebRTC relay, one binary,
country-of-server as config) + THE ONBOARDING (HER-style first-run,
text-first install, local voice after, QR for the phone). Qualities held
throughout: SAFETY (no hand-rolled crypto, secrets 0600, no public
surface), TRANSPARENCY (manifest of every file written and every network
call, provenance), QUALITY (verify.sh green end-to-end), PERFORMANCE
(static binary, fast first sound). Local + free preferred at every step
where quality allows.

## Locked design decisions (driver reviews on user's behalf)

1. **Onboarding is text-first, voice-after.** install.sh itself: terminal
   only, no mic access, no voice capture (no legal trap). Voice enters after
   minimal install, via a local onboarding page the user opens from the
   phone (QR on screen → phone browser → phone mic/speaker → edge voice
   server on the box). Nothing public: LAN/tailnet address only.
2. **Voice = the existing edge server** (bifrost `edge/voice_server.py`,
   sherpa-onnx, CPU, no docker, OpenAI-compatible API shapes). The installer
   ships a COPY into the package (`install/edge/`) with its own systemd user
   unit + env; bifrost product code untouched. Provenance noted in manifest.
3. **The brain choice, plain language, in this order**: LOCAL FREE (edge
   voice always free; for text brain: Ollama/local if present) → OpenRouter
   (pay per use, flexible incl. AGI-class, data per provider) → CODING PLAN
   (cheapest, vendor sees data). Data trade-offs stated in one sentence
   each. Default = cheapest/free available. GLM 5.3 Flash is the tuned
   default brain; assistant discloses its model in its first reply
   (YGG_SYSTEM_PROMPT default).
4. **bifrost-net rides the same binary** as a subcommand (`yggdrasil net ...`)
   — one package, one unit story. boringtun for the mesh (WireGuard, no
   hand-rolled crypto), str0m for WebRTC relay. `country` is a config field
   the node publishes about itself (transparency, not geo-blocking).
5. **Manifest**: every installer run writes/prints what it did — files
   placed, units enabled, env keys set (names only, never values), network
   calls made. Saved to `~/.local/share/yggdrasil/install-manifest.txt`.

## Milestones (sequential, commit each)

- **M1 — close slice 6a** (harness PASS already): redo the independent
  tool-execution check (my last two attempts killed their own shell via
  pgrep self-match — process hygiene fixed), commit 6a.
- **M2 — slice 6b: context roll-up** (the life requires it: 148k-token
  marathons, opencode's `summary` marker found in real data). Opus builds,
  I verify (forced threshold, one extra upstream call, green round-trip,
  summary visible), commit.
- **M3 — bifrost-net M0a**: two nodes, boringtun handshake on localhost,
  traffic through the tunnel (curl through peer IP). New module, same
  binary. Opus builds, I verify two-process handshake, commit.
- **M4 — bifrost-net M0b: str0m WebRTC relay** (STRETCH — honest skip
  allowed if M0a consumed the night; M0a alone = "access point" floor).
- **M5 — THE ONBOARDING**: `yggdrasil onboard` mode + install.sh rewrite:
  minimal install → manifest → onboarding page + QR + edge voice unit →
  conversation flow (language → voice style → provider + data trade-offs →
  brain connect self-test → done) → GLM disclosure first reply. Verified by
  a scripted onboarding walk (curl drives the state machine end-to-end;
  audio round-trip proven against the edge server with a generated wav).
- **M6 — dawn report**: shipped / not shipped / honest why. Live phone
  flip (OPENCODE_URL → yggdrasil on 4100) is a service restart on the live
  box — executed at dawn unless the driver says otherwise.

## Fallback law

A milestone that fails twice is written up in the morning report as
not-shipped with the reason — never silently dropped, never blocking later
milestones. verify.sh stays green at every commit; if a change breaks green,
the change waits.
