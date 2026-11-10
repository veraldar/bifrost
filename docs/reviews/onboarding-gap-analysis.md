# Onboarding gap analysis — closing the v0.7 row "first conversation with the root"

*Decision doc, 2026-10-19. Docs only: no product code, services or env touched.
House convention: every open question carries a default, and the default is taken unless vetoed.
Facts that need a live run are marked **TODO-VERIFY**. Secrets, LAN IPs and hostnames are left out on purpose (`docs/local.md` holds them).*

Scope: this doc owns the **gaps** and the **decision**. The fixes belong to the three
dispatches named in `docs/urd/tests.md:27` (onboarding-flow, voice-stt-sandbox, sim-gap).
None of the three has a line in `docs/claims.md`. The sandbox tree-first scope is still held by
the open `yggdrasil-sandbox` claim (`docs/claims.md:68`). §6 maps each gap to its owner.

---

## 0. Answer first

1. **STT was not "slow". It was dead twice over, and it still is today.** (a) The sandbox build
   turns on its emulator fake-mic for *every* device that taps the tree, so the phone sent a
   looping lab WAV instead of the user's voice. (b) The sandbox voice agent asks the Mac for an
   STT model the Mac can't load, so every call returns HTTP 500. Both are confirmed in logs (§1).
   Each fix is size S.
2. **The greeting took ≈21 s because the brain wrote it live and TTS then read it live.** A
   pre-recorded greeting removes both steps: target ≤ 1 s.
3. **The flow was unclear because the answers change nothing.** The voice choice is never
   applied, and the brain choice is only words in a message. Ask only questions whose answer
   changes something on screen.
4. **Recommendation:** a composition, phased. **v0.7.0 = option C done right**: a scripted
   in-app door with pre-recorded lines in the app's own voice, both STT kills removed, the first
   brain turn as the last step. **v0.8 = options A + B**: veraldar.org's door speaks the same
   asset pack, the install line carries the answers to the box, and one-time QR pairing hands
   them to the phone. **Post-V1** (`docs/spec-onboard.md`): VPS bootstrap, public edge, store apps.
5. The row closes on one measured re-test (§5): tree visible ≤ 1.5 s, greeting audio ≤ 1 s,
   10/10 English utterances transcribed ≤ 2 s, and 4/4 "yes" on flow clarity.

**Correction to the brief.** "STT in-process since v0.6.2" is not the repo state. v0.6.2 never
shipped. The only releases are `20261006-2138-c6a1b2d-wip…` and `20261006-2221-232b25c`
(`~/.local/share/bifrost/releases/`). `docs/STABLE.md:110,119-126` holds v0.6.2 until a French
model passes. Both voice agents still call an STT *service*: `openai.STT(base_url=SPEACHES_URL…)`
at `agent/agent.py:255` (trunk/live) and `lane2-merge/agent/agent.py:326` (sandbox agent).

---

## 1. What the user actually hit — the 10-14 run, reconstructed

Source: sandbox PWA diag `~/Work/bifrost-sandbox/pwa/.diag/diag-2026-10-14.log` (device
`6e64dd78`, Android Chrome 154, 360×780) + `journalctl --user -u lk-agent-ygg`. The run ends at
11:11:39Z, six minutes before the URD FAIL commit `746e439` (13:16 +0200). The URD row is dated
10-06; the run the logs show is 10-14. **TODO-VERIFY** that `6e64dd78` is the user's phone and
not the ygg-sim AVD (the human-like taps and the timing say phone).

| t (UTC 10-14) | +s | event | reading |
|---|---|---|---|
| 11:10:08.391 | — | `[load] domContentLoaded 2533ms, load 3396ms` | cold open; home renders **nothing** until hydration (`bifrost-sandbox/pwa/app/page.tsx:467` `if (tf === null) return null`) — ≈502 KiB raw JS for `/` |
| 11:10:13.166 | 0.0 | first tap on the tree | — |
| 13.507 / 13.840 / 16.340 | 0.3–3.2 | **three more taps** | the pulse wasn't read as "working"; the code forces a 1.2 s wait before navigating (`components/tree-door.tsx:28`), then loads the session page (≈1.6 MiB raw JS) |
| 11:10:13.546 | 0.4 | `POST /api/onboard` 377 ms | session created; the onboarding prompt is sent to the brain (`app/api/onboard/route.ts:108`) |
| 11:10:16.905 | 3.7 | `mic permission: prompt` | — |
| 11:10:20.850 | 7.7 | voice room connected | token 731 ms + signal/room ≈3.2 s |
| **11:10:21.292** | 8.1 | **`GET /user-agi.wav`** | **the lab fake-mic is live on this phone** (R1a) |
| 11:10:24.952 | 11.8 | brain's greeting message lands | the greeting is **composed by the LLM** (`lib/tree-first.ts:52`) |
| 11:10:28.130 | 15.0 | `POST /api/tts/stream` 2782 ms | — |
| **11:10:34.435** | **21.3** | `tts: first audio in 9087ms` | first sound ≈ **21 s after the tap**; the TTS step alone is 9.1 s (timer starts at `lib/speech.ts:384`) |
| 13:10:50 (+02) | 37 | agent: `failed to recognize speech … Error code: 500 … ModelDimensions.__init__() missing 10 required positional arguments` | **the speech server can't load the STT model** (R1b) |
| 13:10:58 (+02) | 45 | agent: `empty or absent user turn, skipping` | — |
| 11:10:49 / 11:11:32 | 36 / 79 | user taps "send what you said" twice | — |
| 11:11:35.761 | 83 | user taps **cancel** (`abort … after 46s`) | the user gave up |

### Root causes

**R1 — STT dead. Two independent kills; either one alone is enough.**
- **R1a, the fake mic in product code.** `bifrost-sandbox/pwa/app/page.tsx:446` runs
  `localStorage.setItem('labmic','1')` inside `startOnboarding()` for every device, and `:458`
  adds `&labmic=1` to the link. `lib/labmic.ts:8-21` then replaces `getUserMedia` with a looping
  `/user-agi.wav` (`public/user-agi.wav`, 508 KB). Added by `b496703` (10-06) for headless
  emulator loops. **The flag sticks:** the same device fetched the WAV again **today**
  (10-19 07:31Z on `/session/main`). Even a code fix leaves this phone broken unless the stored
  key is cleared.
- **R1b, a model the sandbox agent can't use.** `~/.config/systemd/user/lk-agent-ygg.service` sets
  `STT_MODEL=Systran/faster-whisper-small` against the Mac MLX speech server. The Mac returns 500
  on every call: 19 on 10-06, 4 on 10-14, **15 so far on 10-19**. The live agent uses
  `STT_MODEL=mlx-community/Qwen3-ASR-1.7B-8bit` (release env `live-agent.env`). **TODO-VERIFY**
  whether any sandbox STT call ever succeeded; I found no success line in the journal, but I may
  not have the right pattern.
- **Why the sim was green anyway.** Sandbox commit `7657f92` records "STT exact,
  first-sound 1248ms", which hides both kills. That is the **sim-gap** dispatch's question, not
  this doc's.

**R2 — the greeting is slow by design.** It costs three live steps in a row, all after the
tap: navigation + room join (7.7 s) → the LLM writing a greeting (to 11.8 s; sandbox `d67e877`
measured `firstDelta` 4906 ms on the zai path) → TTS (9.1 s). The TTS route also lets only one
generation run on the Mac at a time (`pwa/app/api/tts/stream/route.ts:20-38`, FIFO lock,
30 s cap), so any other speaker on the box delays the greeting further.

**R3 — slow load and slow tree click.** The page is blank before hydration (`page.tsx:467`).
The tap's feedback is a pulse plus a forced 1.2 s wait, then navigation to a heavy page. The mic
prompt only appears 3.7 s after the tap.

**R4 — the flow is unclear.**
- **The answers do nothing.** They are written to localStorage `bifrost-onboard`
  (`app/session/[slug]/page.tsx:1547`) and into MAIN's first message (`lib/tree-first.ts:103-111`).
  The voice choice can't take effect, because the TTS voice is fixed per release env
  (`pwa/app/api/tts/stream/route.ts:87-92`). The brain choice is only words. The brand rule
  "every claim shown must be true of the shipped system" (`docs/brand/narration.md:128`) breaks
  here.
- **Turn-taking.** Hands-free only commits when the user says "over"
  (`lane2-merge/agent/agent.py:318-319`). The rule is taught once, inside a greeting that arrives
  21 s late.
- **Landing.** After setup the user lands in MAIN with the corner door, and nothing says what to
  do next.
- **Brand drift.** The sandbox says "tap the tree" (`components/tree-door.tsx:52`) where the canon
  is "hold the tree to begin" (`docs/brand/tree-door.md:13`). The prompt asks for "one warm
  sentence" and "got it" (`lib/tree-first.ts:52,63`) where the brand says terse, "the tree states
  facts" (`docs/brand/brand.md:104-117`, `tree-door.md:6-7`).

---

## 2. Gap analysis per option

### Option A — web onboarding brand-identical to veraldar.org, in the app voice, pre-recorded

**What exists**

| piece | where | state |
|---|---|---|
| the door: hold-to-start, 6 steps (welcome · language · voice · style · brain · install), EN/FR, re-runnable | `veraldar-site/index.html:383-560` (site `a61afa1`, 10-04) | **live**: deployed veraldar.org has the door markup; service worker v7 = local repo |
| the door's voice | `index.html:405-430` — browser `speechSynthesis`, gender guessed from OS voice names | **a different voice on every phone; never af_heart/Elise** |
| answers | site's own localStorage `bifrost-onboarding` / `bifrost-onboarded` (`index.html:546`) | stay on the veraldar.org origin; **never reach the box or the app** |
| handoff | personal `.env` block (`envBlock()`) + install line per OS + `qr-start.png` → `/start` | only the `YGG_UPSTREAM_*` lines are real config; language, voice and style are a **comment line** that nothing reads |
| `/start` | `veraldar-site/start.html` | **contradicts itself**: "LINUX — DIRECT (recommended)" shows the docker command (`start.html:27` = `:29`); the page body says `docker compose up -d` (`index.html:279`) while the door says `install.sh --now` (`index.html:399-400`) |
| app voice | EN `mlx-community/Kokoro-82M-bf16` voice `af_heart` lang `a`; FR `thaddeusk/Qwen3-TTS-12Hz-1.7B-Elise-v2` voice `elise` (release `live-pwa.env`, sandbox `.env.local` — identical) | served only by the box → the Mac; **the public site can't call it** |
| brand tokens | `docs/brand/tokens.md` (`--oz-*` roles, aether theme `#080810`) | shared by site and app |

**What's missing**
1. **A pre-recorded asset pack in the app voice.** The site has no box behind it. Live TTS
   would need a public TTS endpoint, which breaks "nothing goes public, ever"
   (`docs/brand/narration.md:49`). Pre-recorded files are the **only** way the site can speak in
   the app voice.
2. **One script source** (lines + step order) read by both the site (vanilla JS) and the app
   (Next). Today there are two hand-written copies with different steps.
3. **One answer schema.** The site has `{lang, vgender f|m, style terse|warm, brain plan|openrouter|local}`;
   the app has `{voice woman|man|null, style short|detailed, brain local|openrouter|plan}`
   (`lib/tree-first.ts:32-36`).
4. **`/start` and the install line fixed** to the path that actually ships.
5. **A parity check.** "Exactly the same" needs a referee: a screenshot per step on the site
   and in the app (Playwright).
6. **Honesty fix.** The door says `docker compose logs` → "this same site, now wired to your box"
   (`index.html`, `logs:` string). That isn't true: the app is a different app on a different origin.

**Effort: M.** The pack is S once a generator exists, the shared script M, the site voice swap
S, the parity test S–M.
**Risks:**
- "Exactly the same" forces one design to win: the site's 6 steps or the app's 3 questions.
- Publishing renders of the Elise-v2 fine-tune on a public site: **TODO-VERIFY** that the model's
  license allows redistributing its outputs (Kokoro-82M too, including the MLX port).
- The site can't *apply* anything. Its answers only matter if the install reads them (→ B).
- The public site repo drifts again without a sync step.

### Option B — QR → download the app, onboarding already done (or done in-app after install)

**What exists**

| piece | where | state |
|---|---|---|
| trunk `/pair` | `pwa/app/pair/page.tsx`, `pwa/app/api/pair/route.ts`, `pwa/lib/devices.ts`, `pwa/lib/admin.ts:5-12`, `pwa/middleware.ts:25-43` | mints a device token; **the QR encodes the raw long-lived token** (`page.tsx:26`), so a screenshot is a standing credential until revoked. Live runs `BIFROST_AUTH=tailnet` (`live-pwa.env`), so the middleware lets everything through |
| one-time code pairing (the better one) | `lane2-merge/pwa/app/api/pair/code/route.ts` + `claim/ refresh/ kill/ devices/`; `lane2-merge/pwa/app/pair/page.tsx` | QR = `<BIFROST_PUBLIC_URL>/pair#v=1&code=…&fp=…&bridge=…&box=…`; code TTL 5 min (`lane2-merge/pwa/lib/devices.ts:32`, `BIFROST_PAIR_TTL_S`); the fragment never reaches server logs; bridge fingerprint pinned on first scan; **lands on MAIN with zero typing**. **Not on trunk**: `docs/STABLE.md:143-144` says v0.8 needs `lane2/merge` merged |
| installer config | `~/.config/bifrost/bifrost.env` ← `lane2-merge/lab/yggdrasil/install/bifrost.env.example` | `BIFROST_AUTH=devices`: pair by scanning the QR at the box console `http://127.0.0.1:<port>/pair`; `BIFROST_ADMIN_TOKEN` for minting from elsewhere |
| Android shell #1 | `pwa/android/` (trunk): hand-built WebView, `bifrost://pair?token=&url=&bridge=` deep link (`AndroidManifest.xml:26-33`) | lab build, APK gitignored, driven by ygg-sim `app.*` |
| Android shell #2 | `bifrost-sandbox/mobile/` — Capacitor `org.veraldar.bifrost`, `server.url http://localhost:8090` cleartext; iOS project generated (`4ef96ba`) | lab; iOS needs Xcode on the Mac |
| ladder slot | `docs/STABLE.md:112` (v0.8 row) | Android app = first client; **needs a foreground-service mic** (Android mutes the mic ~1 s after screen-off) |

**What's missing**
1. **A way to carry the answers.** Today nothing does. The site's answers sit in another
   origin's storage, and the box mints the QR (console only). So "QR carries state" really means
   box → phone, and the answers have to reach the box first. The only channel the user already
   uses is the **install line**, and `install.sh` reads none of it today.
2. **A way to download the app.** There's no hosted APK, no store listing and no signing-key
   story. iOS needs an Apple developer account (**hard blocker: account**). Today "download the
   app" means installing the PWA from the browser, as `docs/spec-onboard.md:105-106` already says.
3. **One shell.** Two Android shells exist; pick one.
4. **Trunk pairing moves to one-time codes** before any QR is shown off the box console.
5. **A split between box settings and device settings.** Brain and language belong to the box;
   reply style (and later voice) belong to each device.

**Effort: L.** It needs the lane2 merge (pairing + bridge), answer carriage, the shell pick, the
FGS mic, and distribution.
**Risks:**
- A secret in the QR on trunk.
- QR-scanner apps that open links in their own in-app browser: different storage, no PWA install.
- Trust-on-first-scan pinning.
- **Ladder rule:** B *is* v0.8's one structural change (bridge + device tokens + app,
  `docs/STABLE.md:102-116`). It can't ride v0.7.
- B gets judged at the iPhone gate (`docs/roadmap-proposal-v2.md` §6).

### Option C — keep in-app onboarding, fix it

**What exists:** sandbox tree-first (`ce40a1a`, branch `lab/sandbox`, served by
`bifrost-sandbox.service` :8090 → tailnet :8443 from the **worktree**):
- `FirstTree` / `TreeDoor` (`components/tree-door.tsx`).
- `/api/onboard` start|done (`app/api/onboard/route.ts`).
- An LLM-driven prompt (`lib/tree-first.ts:43-67`).
- A reserved MAIN session, and a sweep that deletes onboarding sessions older than 1 h
  (`route.ts:33-59`).
- Uncommitted work from 10-06 19:47–19:51 (resume-into-setup `TF_STARTED_KEY`, a fix in
  `lib/speech.ts` for replies that arrive in one piece). It sits inside the served build
  (`BUILD_ID` 10-06 19:52; **TODO-VERIFY** with `/api/build`).

**What's missing** (numbered for §6):

| # | fixes | change | size |
|---|---|---|---|
| C1 | R1a | remove the fake mic from the product path: delete `page.tsx:446` and the `&labmic=1` at `:458`; allow `lib/labmic.ts` only when a build-time lab flag is set (never in a promoted build); **remove any stored `labmic` key at boot** (the user's phone has one today) | S |
| C2 | R1b | sandbox agent `STT_MODEL` = the live model, set through the next-slot **release env** (not a unit edit, `docs/STABLE.md:65-86`). The gate should do one real STT call per promote: today's probe proves dispatch, not transcription (`docs/STABLE.md:99`) | S |
| C3 | R2 | scripted onboarding (a state machine in the PWA, **no LLM until MAIN**) + pre-recorded lines (§4.5). This also removes the 22-a-day debris sessions, because no brain session exists before MAIN | M |
| C4 | R3 | tree in the server HTML (a static SVG paints before hydration); amber on `pointerdown` within one frame; drop the forced 1.2 s; prefetch the session route + voice token while the greeting plays; ask for the mic from the step that needs it | S–M |
| C5 | R4 | every question changes something visible, or it's cut (§3 Q3–Q4); MAIN opens with one spoken + one written next action; no "over" during setup (§3 Q6) | S |
| C6 | R4 | brand wording: hold not tap; terse lines that state facts (`docs/brand/tree-door.md`, `brand.md` §2) | S |
| C7 | — | make the sim exercise the real mic path and real STT (sim-gap) | S–M |

**Effort: S–M.** About 2 build days + 2 verify days (`docs/roadmap-proposal-v2.md` §2: the
schedule lives in verify, not build).
**Risks:**
- A scripted door loses the "talking to the root" moment. Mitigation: the first brain turn is
  the last onboarding step, and it's measured (§5 #7).
- Pre-recorded lines drift from the copy. Mitigation: a manifest hash check (§4.5).
- **The sandbox serves a worktree.** `docs/STABLE.md:62-63`: freezing the next slot
  (`promote.sh --slot next`) is v0.7's first step. Re-testing on a worktree build is exactly what
  the boundary forbids.

---

## 3. Open questions for the user (default taken unless vetoed)

Cross-checked with `docs/open-questions.md`:
- **OQ3** (the in-browser voice tier, kokoro-js, packs of ~45-150 MB) could let the site speak
  af_heart without files. For onboarding the pre-recorded pack (~1 MB) wins. OQ3 stays open for
  offline use and is not touched here.
- **The 09-27 note** (onboarding auth: cookie vs passkeys) gates B at v0.8 or later, not v0.7.
- **10-01 delete safety**: the onboarding sweep hard-deletes sessions. C3 makes that sweep
  unnecessary.

1. **Scripted onboarding** with no LLM before MAIN, instead of a greeting and questions written
   by the brain? — **Default: scripted.** The brain's first turn is the last step, in MAIN.
2. **Which design is canonical** for "the same experience"? — **Default: one shared script.** The
   app runs language · style · brain (shown) · hold-to-talk practice · MAIN. The site runs the same
   lines plus its install step. Same words, voice and drawing for the shared steps.
3. **Voice gender question:** cut in v0.7 (one voice: af_heart EN / Elise FR, the app's voice), and
   bring it back in v0.8 when the TTS route takes a per-device voice? — **Default: cut.** Today
   nothing can apply it, and it doubles the pack.
4. **Brain step in-app:** name the brain the box actually runs (the class is spoken, the model
   name shown) with "change it in settings", rather than asking a choice that does nothing? Key entry
   ("your LLM, your key surfaces at v0.7", `docs/plan.md:105`) stays outside onboarding.
   — **Default: show, don't ask.** **Flag:** if you want the key collected *during* onboarding,
   that's a new slice (secret input by voice is a bad idea; typed only).
5. **Hold or tap the tree?** Canon is "hold the tree to begin" (`docs/brand/tree-door.md:13`).
   — **Default: hold ≥ 400 ms.** Amber "heard" on touch; released early → `released — nothing sent`
   (`tree-door.md:22`). The instant amber also fixes the "slow click" feel.
6. **Answering during setup:** the "over" keyword, or tap chips + hold-to-talk? — **Default: chips
   + hold-to-talk** (canon `hold to be heard`, `tree-door.md:15`). "Over" is taught by one line
   when MAIN opens.
7. **Audio format and location:** mp3, mono, 24 kHz, ~48 kbps, committed under
   `pwa/public/voice/onboard/{en,fr}/` with a manifest, and copied to the site in v0.8.
   — **Default: yes.** (**TODO-VERIFY**: Safari plays opus; if so, opus is a later size win.)
8. **Publishing renders on veraldar.org:** — **Default: EN after a license check of Kokoro.** FR
   only if the Elise-v2 license allows redistributing outputs; otherwise the FR site door keeps
   `speechSynthesis`.
9. **When the site gets the pack:** v0.8 together with the schema work, or v0.7.x as soon as the
   pack exists? — **Default: v0.8.** v0.7 closes the in-app row only.
10. **How answers travel for B:** the install line carries them (e.g. `--onboard v1.<lang>.<style>.<brain>`)
    → the box stores them → pair-redeem returns them. The QR carries **only** the one-time code.
    — **Default: yes, no answers in the QR.**
11. **Android shell:** trunk `pwa/android` (no Gradle, already in ygg-sim `app.*`) or sandbox
    Capacitor `mobile/`? — **Default: trunk shell.** Capacitor is parked.
12. **Re-test target:** the next slot as a **frozen release** (`promote.sh --slot next`), your
    phone, with **site data for the :8443 origin cleared** first (this removes the stuck fake-mic
    flag). — **Default: yes.**

---

## 4. The defined solution (before any build)

### 4.1 Target shape (complete at v0.8)

```
veraldar.org                     your box                         your phone
hold the tree ─► door speaks ──► install line carries answers ──► box console: one-time QR (5 min)
  (pack: af_heart / elise)       → bifrost.env + yggdrasil.env     scan → /pair#code → redeem
  language · style · brain                                         → answers come back from the box
                                                                   → the same tree → "planted"
                                                                   → MAIN: first brain turn
```

At v0.7 only the right-hand column exists, and it stands on its own. The app's first run *is*
the door, with the same lines and the same voice, so v0.8 adds the site and the QR without
redesigning anything.

### 4.2 v0.7.0 — closes the URD row (in-app, next slot)

1. C1 + C2: both STT kills removed, the stuck flag cleared at boot, and the gate makes one real
   STT call.
2. C3: scripted door state machine + the v0.7 asset pack (EN + FR, §4.5) + fallbacks.
3. C4: the tree in the first paint, amber on press, no forced wait, prefetch during the greeting.
4. C5 + C6: honest steps (style applied to MAIN, brain named, voice gender cut), hold wording,
   a defined landing in MAIN.
5. C7: the sim's tree-first scenario runs the real mic path with real STT. A sim result that
   uses the lab WAV doesn't count toward this row.
6. Freeze the next slot (`promote.sh --slot next`) → re-test per §5 → URD row updated.

### 4.3 v0.8 — the door becomes one experience (with the v0.8 bridge/app change)

1. The site door plays the same pack; the shared script and schema (A1–A3); `/start` and the
   install line fixed (A4, A6); the parity check (A5).
2. The install line carries the answers; `install.sh` writes them; the box serves them after
   pair-redeem (B1, Q10).
3. lane2 one-time-code pairing merged to trunk; the raw-token QR retired (B4).
4. Android shell (Q11) with the FGS mic; the APK hosted next to `/start` (signing key decision
   needed, **TODO**).
5. A per-device TTS voice parameter brings the voice gender question back (Q3).

### 4.4 Stays in `docs/spec-onboard.md` (post-V1)

VPS `bootstrap.sh` + Caddy + public WebRTC edge; the Vercel path; passkeys; store-distributed
iOS/Android apps; unattended updates. Multi-tenant hosting is never on the list
(`spec-onboard.md:9`).

### 4.5 Voice pre-recording approach

**Rule.** Fixed lines are pre-recorded. Dynamic content (model names, transcript echoes, brain
replies) is never pre-recorded: names show as on-screen text, and replies stay live TTS in MAIN.

**Asset list (v0.7 pack, draft copy).** The copy follows brand.md §2 and tree-door.md: terse,
lowercase, no exclamation marks, no please/thanks, no "i'm listening". Final words are a brand
call; regenerating is one command. 17 lines × 2 languages = 34 files.

| id | plays when | en (draft) | fr (draft) |
|---|---|---|---|
| `greet` | hold completes | this is bifrost. your box, your voice. three steps, then you talk. | voici bifrost. votre box, votre voix. trois étapes, puis vous parlez. |
| `lang` | step 1 | english or french? | anglais ou français ? |
| `lang_en` / `lang_fr` | language picked | english. / — | — / français. |
| `style` | step 2 | short answers, or more detail? | réponses courtes, ou plus de détail ? |
| `style_short` | picked | short. signal only. | court. juste le signal. |
| `style_detail` | picked | more detail. full sentences. | plus de détail. des phrases complètes. |
| `brain_local` | step 3 (class read from the box) | the brain runs on this box. nothing leaves your network. | le cerveau tourne sur cette box. rien ne quitte votre réseau. |
| `brain_router` | 〃 | the brain is a cloud model through openrouter. your words travel to its provider. | le cerveau est un modèle cloud via openrouter. vos mots vont chez son fournisseur. |
| `brain_plan` | 〃 | the brain is a coding plan. the vendor sees what you send. | le cerveau est un forfait de code. le fournisseur voit ce que vous envoyez. |
| `brain_change` | after the brain line | change it in settings. | modifiable dans les réglages. |
| `practice` | step 4 | hold the tree to be heard. let go to send. | maintenez l'arbre pour être entendu. relâchez pour envoyer. |
| `heard` | practice transcript arrived | heard. | entendu. |
| `not_heard` | practice: empty or failed STT | nothing came through. check the mic, then hold again. | rien n'est passé. vérifiez le micro, puis maintenez à nouveau. |
| `retry` | answer not matched | not caught. tap one, or hold and say it again. | pas compris. touchez un choix, ou maintenez et redites-le. |
| `mic_denied` | permission denied | no mic access. bifrost works by text too. the keyboard is below. | pas d'accès au micro. bifrost marche aussi au clavier, juste en dessous. |
| `box_down` | `/api` or voice room fails | your box did not answer. hold the tree to try again. | votre box n'a pas répondu. maintenez l'arbre pour réessayer. |
| `planted` | MAIN opens | planted. this is main. hold the tree and ask anything. | planté. voici main. maintenez l'arbre et demandez ce que vous voulez. |

Size estimate: ~3 s × ~6 KB/s ≈ 18 KB per file, about 0.6 MB for the pack (**TODO-VERIFY**
after rendering).

**Where the files live**
- Script (the one source): `voice/onboard/lines.json` at the repo root, holding id, lang, text,
  and an FR seed.
- Rendered output: `pwa/public/voice/onboard/<lang>/<id>.mp3` + `pwa/public/voice/onboard/manifest.json`
  (id, lang, `text_sha256`, model, voice, seed, duration_ms, bytes).
- Site copy (v0.8): `veraldar-site/voice/onboard/…` through a sync step.
- Both service workers (`pwa` and `veraldar-site/sw.js`) precache the pack, so a second run is
  instant and works offline.

**How it's generated (one command, proposed `scripts/voice-prerender.*`, not written here)**
- It calls the **release's own** `POST /api/tts/stream {text, lang, seed}` on loopback. That
  guarantees "the same voice as the app" by construction: same env, same model, same params
  (`pwa/app/api/tts/stream/route.ts:87-133`). No model name is hard-coded in the generator.
  `lang` is always sent explicitly; without it the route reads text as French.
- It wraps the int16 24 kHz PCM as WAV, trims silence the way `/api/tts` does
  (`pwa/app/api/tts/route.ts:49`), and encodes mp3 (ffmpeg).
- It re-renders only lines whose text, model or voice hash changed.
- FR (Qwen3, sampled): render 3 seeds per line, you pick, and the seed is pinned in `lines.json`.
- It runs on the box while the Mac is up. The Mac's one-generation lock means the pack renders
  one line at a time, never during your live use.

**How it plays.** The hold *is* the user gesture, so the audio is allowed to start. `greet` is
fetched into memory on first paint, and later lines are prefetched one step ahead.

**Fallback chain**
- App: the pack file (target ≤ 1 s) → on a 404, a decode error or a manifest hash that doesn't
  match the current text: live `/api/tts/stream` with the same text → no first audio within 3 s:
  text only (the caption is always on screen anyway). Every miss logs a diag line
  (`voice: prerender miss <id> <reason>`), so a stale pack shows up in the re-test.
- Site: the pack file → `speechSynthesis` → text.

---

## 5. Test criteria to close the URD v0.7 row

**Preconditions (recorded in the row):**
- The next slot runs as a frozen release (`scripts/promote.sh --slot next`), and
  `python3 scripts/gate.py` is GREEN for it.
- e2e is green on the release: tree-first spec + full suite.
- Your phone, with site data for the :8443 origin cleared.
- Mac speech up.
- Three runs: cold (data cleared), warm, and one in French.

| # | metric | 10-14 baseline | PASS | FAIL | evidence |
|---|---|---|---|---|---|
| 1 | open → tree visible | blank until hydration; `load 3396ms` | tree in the **first paint**; `[load]` ≤ 1500 ms cold, ≤ 800 ms warm | > 2500 ms or a blank frame | `[load]` diag line + a screen recording |
| 2 | press → visible reaction | 4 taps in 3.2 s | amber within one frame (≤ 100 ms); **exactly 1** start press in the trace | any repeated start press | `[tap]` lines |
| 3 | hold → first greeting audio | ≈ 21.3 s | ≤ 1.0 s on every run | > 2.0 s | new diag `voice: prerender greet first audio Nms` |
| 4 | answer → spoken confirmation | n/a (LLM + TTS per turn) | ≤ 1.0 s | > 2.0 s | prerender diag lines |
| 5 | STT round-trip | no transcript ever (500 + lab WAV) | **10/10** EN utterances recognized, transcript on screen ≤ 2.0 s after release (`docs/STABLE.md:110` gate); FR ≥ 4/5; **0** `failed to recognize speech` in the next-slot agent journal for the run; **0** `GET /user-agi.wav` from the phone | any 500, any lab WAV fetch, < 9/10 EN | `journalctl --user -u <next-slot agent>`; `grep user-agi .diag/*` |
| 6 | whole onboarding | not finished (cancel at 83 s) | hold → MAIN ≤ 60 s by taps, ≤ 90 s by voice | not reached, or > 120 s | first `[tap]` → MAIN `[open]` |
| 7 | first brain turn in MAIN, by voice | — | reply's first audio ≤ 6 s after release (recorded with the brain's `firstDelta`; the zai baseline is 4906 ms) | no reply **and** no explicit error within 30 s (`docs/STABLE.md:111` "every turn ends") | diag + agent journal |
| 8 | flow clarity (your verdict) | FAIL | **4/4 yes:** (a) knew what to do at every step without asking; (b) knew where you were after setup and what to do next; (c) every answer visibly changed something; (d) you'd hand it to someone else as-is. Plus **0** cancel/abort presses in the trace | any "no" | your words in the URD row + `[tap]` lines |

The row closes **PASS** only when #1–#8 pass on the same release. Any FAIL writes a new
URD row with the measured numbers. The old row stays as history.

---

## 6. Who owns what (this doc owns none of the slices)

| gap | owner (dispatch, per `docs/urd/tests.md:27`) |
|---|---|
| C1 fake mic out of product + stuck-flag cleanup · C2 sandbox STT model via the release env + a gate STT probe | **voice-stt-sandbox** |
| C3 scripted door + pack + fallbacks · C4 first paint/press · C5 honest steps + landing · C6 wording | **onboarding-flow** (inside the `yggdrasil-sandbox` claim scope, `docs/claims.md:68`; coordinate before editing) |
| C7 sim on the real mic path + real STT; why `7657f92` was green | **sim-gap** (`lab/ygg-sim`, the `ygg-sim` claim, `docs/claims.md:7`) |
| freeze the next slot | v0.7 ladder step (`docs/STABLE.md:62-63`), via `promote.sh` only |
| A1–A6, B1–B5 | v0.8, unassigned; the site repo is `~/Work/veraldar-site` |

None of the three dispatches has a claim line yet. Each must claim before touching files
(`AGENTS.md` § Parallel sessions).

## Appendix — evidence index

- User run: `~/Work/bifrost-sandbox/pwa/.diag/diag-2026-10-14.log` 11:10:08–11:11:40Z (device `6e64dd78`); fake-mic fetch again in `diag-2026-10-19.log` 07:31:47Z.
- Agent STT 500s: `journalctl --user -u lk-agent-ygg` 2026-10-14 13:10:50 +02:00 (and 10-06, 10-19).
- Sandbox code: `~/Work/bifrost-sandbox` @ `e440d08` + uncommitted work from 10-06 (`git diff --stat`: 8 files).
- Agents: `agent/agent.py:255` (trunk), `lane2-merge/agent/agent.py:263-326`.
- Site: `~/Work/veraldar-site` @ `4803454`; deployed veraldar.org has the door markup, service worker v7 on both.
- Releases: `~/.local/share/bifrost/releases/` (two, both 10-06); `docs/STABLE.md`.
