# Door v3 report: plain words, any provider, a safe back button

*Session DOOR-V3, 2026-10-22. Built from the user's 10-22 door walkthrough (four points).*

**Where:** `~/Work/bifrost-sandbox` (branch `lab/sandbox`, served by `bifrost-sandbox`: :8090 locally,
:8443 on the tailnet, build `3MQOFZCyrrQp2LJ6Hlls7`) and `~/Work/veraldar-site` (deployed to veraldar.org).
The live stack (`lk-pwa`, `lk-agent`) was not touched. `docs/urd/` was not touched.

## What changed, per feedback point

| # | Feedback | Done |
|---|---|---|
| 1 | "Coding plan" was Z.ai-only | **Any provider.** One presets file, `pwa/lib/brain-presets.json`: z.ai (coding plan), openrouter, anthropic, openai, plus **other** (any address, openai or anthropic format) and **your own computer** (a server at home, no key). veraldar.org's brain step uses it (service chips; address and model filled in and editable; a link to where you make a key). The settings block it writes now carries `YGG_UPSTREAM_BASE_URL` / `_STYLE` / `_MODEL` and a key placeholder. The app door names the provider generically ("glm-5.3-flash · at z.ai"). It reads only the base-URL line of yggdrasil's own env file, never the key. |
| 2 | Phone back button | **Every step is a history entry**, on both surfaces. App: `#door=v1.<lang>.<style>&at=<step>`. Site: `#door-step=N`. Back walks the steps, then the tree, then the page that sent you. Coming back from the app lands on the site's **last step** with your address still filled in. The `#door=` answers survive a back-forward cycle, and so does a reload. The film is one more entry, so back closes it. Also fixed: **`veraldar.org/start` was a 404**, and that's the address the door's QR encodes. |
| 3 | Copy too complex ("what is a box?") | "Your computer", never "box". Every name gets a one-line gloss where it first appears: the tree under the first paint, bifrost at the first steps, root at the brain step, main in MAIN. Trunk, branch and yggdrasil sit behind **"why these names?"**: the `$ tree` as rows that wrap on a phone, a spoken version ("hear it", 4 recorded lines) and the film. The site's lore `$ tree` gets the same plain glosses and both buttons. Script v2: 38 lines re-recorded (details below). |
| 4 | The artifact idea | **Built: the tree film** (`pwa/artifacts-builtin/door-tree.html`, about 15 KB, self-contained). It's served by `/api/artifact/door-tree.html`, the same route as every artifact, and copied to `veraldar.org/onboarding/tree.html`. More below. |

**One more bug, found on the way:** the site's install one-liner (`./install.sh --now`) fails on a fresh computer.
`--now` refuses to start until `YGG_UPSTREAM_BASE_URL` is set, and the settings file doesn't exist before the install runs.
The door now gives three honest steps: install, paste your settings, `./install.sh --now`. Also: the site's service worker
served pages cache-first, so a phone stayed on the old door after a deploy. Pages now load network-first (sw v9).

## The artifact: why the tree film

| Candidate | Verdict |
|---|---|
| **Tree metaphor film + try-it** | **Built.** It answers the #1 confusion head-on (the names, "what is this thing"). It's one file for both surfaces and reuses the door's own voice pack. The try-it teaches the mic rule (hold = amber = heard, a tap is not a message) without adding a step to the fast path. |
| "Hold the mic" lesson as its own demo | Folded into the film's try-it. As a separate step it would rehearse right before MAIN's first turn, which is already real (and STT-proven). **Spec:** offer the film's try-it as practice only after two `not_heard` misses in MAIN. |
| "What your tree can do" gallery at "you are in" | **Spec, later.** One screen of 4–6 one-tap prompts that fill the composer, loaded lazily after the first-turn card's "ok". The honesty constraint: tiles must come from what the brain can actually do (yggdrasil's agents and tools), never a marketing list. |

How the film behaves: the tree draws itself, then root (green, the brain), trunk (sky, the private line) and branch =
bifrost (a phone) light up, each with its line in the door's voice. Then you hold the branch: it turns amber (heard).
Let go, and your words travel down to the root, it thinks, and the answer comes back up. Then: "that is the whole trip.
the mic works the same way."

The ~100 ms first-audio budget is untouched: nothing loads until "watch it" is tapped. It's skippable (✕, back, or its
own "back to the door"). With sound off it still works, because every line is on screen. If the browser blocks audio in
a frame, one tap on play fixes it.

## Evidence

| What | Result |
|---|---|
| Door spec `tree-first` (sandbox) | **4/4**: main walk + carried-fr + **back/forward/handoff/reload** + **names → hear → film → try-it → back to the door** |
| Real first voice turn `first-turn-voice` | **1/1**: transcript 1318 ms after release, spoken reply at 6141 ms |
| Site spec `site-door` on the working copy **and on live veraldar.org** | **4/4 both**: plain words, presets → settings (anthropic, other, local, and a skip still gets the preset), back out and back in, `/start/` 200, film |
| Site → app → back, for real (`APP_URL` = sandbox :8443, live site) | **1/1**: fr answers carried, back ×2 lands on the site's last step |
| Greeting first audio / answer confirmation | **63–65 ms / 14 ms** (budget ~100 ms) |
| Voice pack | 38 re-rendered, all transcribed back ≥ 0.8 except `en/in` 0.78 ("any time" heard as "anytime") |
| veraldar.org deploy | 6 files sha-identical to commit `15c80f8`; `/start` → 308 → 200; retired `brain_plan.mp3` → 404 |
| Phone-class repro (another session's harness: Pixel UA, 4× CPU, 4 Mbps/100 ms, cold) | **all PASS**: load 523 ms · tap → amber 20 ms · greeting voice 33 ms · door → MAIN 230 ms · transcript 2.8 s · spoken reply 13.1 s |
| General suite on the sandbox (`PW_BASE_URL=:8090`) | 33 passed / 9 failed / 2 skipped. **0 regressions.** 6 are the known yggdrasil-vs-opencode failures from the 10-19 A/B (`context:8`, `settings:32`, `subs:24/71`, `wedge:16/58`). 2 are other sessions' uncommitted specs that need their own config (`door-repro`: run on its own, all PASS above; `stt-phone`). `base:73` passes when rerun alone (a known shared-load flake). |

## Commits

- **sandbox:** `64fdc04` copy + voice pack · `f466504` the tree film (built-in artifact route) · `e14089a` the door
  (provider-generic brain, history, glosses, names panel, film wiring) · `a39ff3f` e2e + site sync script ·
  `e744cf6` first-turn spec reads the script · `70a8537` site → app → back test. (`git log --oneline 9cb2820..`)
- **veraldar-site:** `15c80f8`. Host backups: `index.pre-door3.bak.html`, `start.pre-door3.bak.html`,
  `sw.pre-door3.bak.js`, `onboarding.pre-door3.bak/`. Rollback = restore those 4 and remove `start/`.
- **Env (sandbox only):** `YGG_ENV_FILE=…/lab/yggdrasil/yggdrasil.env` in `~/.config/bifrost/env/bifrost-sandbox.env`.
  That's how the door names the provider; only the base-URL line is used.

## Test it like a first-timer (4 steps, your phone)

1. **veraldar.org → hold the tree.** It should say "hi. this is bifrost…" in plain words, with no "box" anywhere.
   Tap **why these names?**, then **watch it · 15 s**. The tree draws, the names light up, then hold the branch and let
   go. Press your phone's **back** button: the film closes and you're still in the door.
2. **Walk the door, then press back twice.** You should step back one question at a time, then out to the page, with
   nothing dead. At **who does the thinking?** pick *a cloud service*. Tap **anthropic** or **other** and watch the
   address and model change. On the last step the settings block matches what you picked.
3. **Type your computer's address** (`<computer>.<tailnet>.ts.net:8443`) and tap **open bifrost**. The app's tree says
   "hi again. your answers came with you". Hold it and you land on the brain step, which reads "glm-5.3-flash · at
   z.ai". Now press **back** twice: you're back on veraldar.org's last step, address still there.
4. **Go forward and finish in the app:** continue → "ready. this is main, your main conversation" → hold the mic, say
   anything, let go → the answer → "you are in. talk to your tree any time."

## Assumptions and open items

- **Model ids in the presets are starting points** (editable in the door). glm-5.3-flash is proven on this computer.
  claude-sonnet-5-5 is current. **gpt-6.1-sol comes from a web search (10-22), unverified against OpenAI's API.**
  Check it before the next release.
- The key is never asked in a web page. That's deliberate (brand law: "boring at the consent layer"). The door links
  to the provider's key page instead.
- The film's voice plays only where the v3 pack is served (sandbox :8443, veraldar.org). Copied into the live chat as
  an artifact, it runs silent with captions, because live still has the v2 pack.
- The general suite's door-repro spec (another session's uncommitted file) is only meaningful under its own config.
  Not part of this verdict.
- Already in the working tree and committed with `a39ff3f`: a one-line comment tweak in `tree-first.spec.ts` that the
  ONBOARD-BUILD report attributed to another session (onb2).
