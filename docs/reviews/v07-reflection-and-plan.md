# v0.7 reflection + plan — the seven questions (V07-REFLECTION, opus, 2026-10-27)

**Evidence read** (all local, all read-only):
- git: trunk `rebuild/cohesive-opus` and `lab/sandbox` (51 commits since 10-10).
- The user's two work sessions: [MAIN] on the root :4100 (`ses_770b…`, 182 messages, 81 user turns since 10-19) and [MAIN] Veraldar on :4096 (the coordinator, 10-14 → 10-27).
- The :4100 wave sessions: `v07 gate waves`, `session`, `[REVIEW] rules-distribution`.
- `.agi-log/log.tsv` (11 v0.7 lanes) and journald (lk-yggdrasil, bifrost-sandbox, lk-verify).
- `scripts/gate.py`, run once today (no `--full`), and `promote.sh --list`.
- The docs: plan.md, STABLE.md, the coordination design, the herdr takeaways, playbook 10-02..10-10, v07-gate-final.md, urd.

Nothing was restarted. Nothing was written outside this file and its artifact copy. The Mac was not touched (Q3). All times are UTC.

**The seven questions** are the coordinator's 10-27 06:31 intent echo of the user's message:

| # | question | where |
|---|---|---|
| Q1 | workflow audit | §1 |
| Q2 | backlog | §2 |
| Q3 | Mac tools + orchestration | §3 |
| Q4 | tool diet | §4 |
| Q5 | R&D lab | §5 |
| Q6 | release gate | §6 |
| Q7 | "pass it to AGI on Opus" | this document |

The user's later 10-27 messages are chained:
- **Q8**, the root-to-root identity lane, appends as §8.
- **Q9**, the APK, the coverage map and the metrics, appends as §9.
- The 06:35 message (is the voice lab running 24/7, on-device STT, are the PCB/silicon labs running) had no chained prompt when this ran. §5 answers it in short.
- **Q10**, that same message refined (the voice lab, STT on the phone, the labs inventory, the loops), appends as §10.

## 0. The answers, short

1. **Q1.** All 11 v0.7 lanes landed. The time leaked in three places, all avoidable:
   - **Polling.** About 21 user turns were spent asking "done?".
   - **Wrong queues.** The gate and the designs ran as REST turns on the flash model, inside the system under test. About 42 h were lost on the gate.
   - **The main working by hand.** It gave four wrong answers about one mic icon. It also killed the live brain by hand, which caused a 4-day v0.6 outage that no monitor caught.
2. **Q2.** Of 27 asks, 18 shipped to the next slot, 3 are partial, 1 is deferred to v0.8 by plan, and 5 are open.
   - The gate-final matrix is green, but it misses three plan items as written:
     - **Version string:** the sandbox still serves `v0.5.0-74`.
     - **"Bifrost" onset on the real phone:** 5/12 misses on 10-19, then 2/8 after the fix.
     - **Exactly-once on the voice path:** 12 phantom runs and 7 duplicate turns in MAIN.
   - The test list has 13 AGI items, then your one consent check.
3. **Q3.** Take the concepts, not the code:
   - **Letters = yes.** They become the shape of the relay (v0.7.x).
   - **Squid = yes.** It is the missing organ: a declared schedule over systemd timers and agi-run, with no LLM scheduler. v0.7.x for the fleet; the product side comes with dreaming at v1.0.
   - **Flow = a thin step list** with an on-fail rule, for fleet tooling only.
   - **Workers = no new concept.** They are sub-sessions with a role.
4. **Q4.** Agreed, and the evidence is from v0.7 itself.
   - The main loses edit, write, bash and build.
   - It keeps talk, read-only state, a phone screenshot ("look"), spawn, inbox and steer.
   - The harness's tool registry enforces this, never a prompt.
   - Only MAIN goes on the diet; topic sessions keep every tool.
   - It lands as **v0.7.1**, right after the promotion.
5. **Q5.** Run R&D now, but on a schedule, not as a 24/7 session.
   - Research-feed pass 2 is 13 days overdue.
   - Add the field-watch seed pass (12 pins) and a voice radar for on-device STT.
   - Cost: about one Sonnet lane a week, plus one a month, with Opus only for verdicts.
   - It needs your go, because autonomy is opt-in.
6. **Q6.** Twelve ordered steps (0–11).
   - **Step 0: the live gate is RED today** (`port.4096`, the hand-made `opencode-legacy` unit from 10-19). `promote.sh` rolls back on RED, so nothing can be promoted until the gate reads the brain from the release env.
   - Then, in order:
     - close the test gaps;
     - trunk merge (`lab/sandbox` is 59 commits and 222 files off trunk);
     - freeze the next slot as `v0.7.0-rc1`;
     - your consent check;
     - 72 h (or the default week) on rc1;
     - promote;
     - the rollback week with v0.6.1 as PREVIOUS;
     - drop v0.6;
     - open v0.8.

---

## 1. Q1 — workflow audit

### 1.1 What the user did on v0.7

| date | the user's move | what it triggered | result |
|---|---|---|---|
| 10-14 | first conversation with the root on :8443 → **FAIL** (slow door, STT dead, flow unclear) | the coordinator queued 3 diagnostic sessions on the **live** brain | wedged 14 h (W1) |
| 10-19 | ":443 shows no sessions"; "v0.6 must keep working"; "onboarding = veraldar.org's"; "AGI decides and builds" | MAIN: the `opencode-legacy` unit; ONBOARD-GAPS → ONBOARD-BUILD (Opus, chained) | v0.6 back; door v2: greeting 21 s → ~100 ms, STT 0.86–0.96 s |
| 10-19 | ~21 voice tests in MAIN | the URD row "3-for-3, PASS" | raw: 5 of 12 utterance-initial "Bifrost" lost (F9) |
| 10-20 | rename refused silently; "no LLM selected" | ONBOARD-UX | 3 fixes, e2e |
| 10-22 | any provider; back button; plain words; the film | DOOR-V3, FILM-V1, FILM-NAMING | landed, site deployed |
| 10-22 | "I have no view of what runs or when it's done" | the coordination design (3 passes, flash) + herdr | a design, nothing built |
| 10-22 | "only simulation is proof"; "AGI uses the sim, I use a finished product" | Rules 10-09/10-10; the gate queued as REST turns on :4100 | wave 1 died on a 429 after 205 s; wave 2 killed its own host (W5) |
| 10-23 | door "or type"; stuck typed message | UX-BATCH | 5/5, e2e 7/7 |
| 10-24 | "three mainframe designs" | MAINFRAME-DESIGN | died 9 min in; found dead 6.5 h later (F3) |
| 10-24 | — | V07-GATE-FINAL (Opus, agi-run) | matrix green in 74 min; the sims found and fixed 4 bugs |
| 10-26 | proposals missing from the gallery | ARTIFACT-PLUMB | fixed, e2e |
| 10-26 | picks C: tap = MAIN, hold = hands-free | MAINFRAME-C | landed, with a mic glyph the user never asked for |
| 10-27 | "the mic icon is unnecessary" (×4) | MAIN edited `roots.tsx` itself | 4 wrong answers first (F5), no e2e after (F6) |

Opus lane time for the v0.7 polish: 11 lanes, ≈ 28,000 s ≈ 7.8 h, all `OK`. Two lanes landed only on a second attempt:
- ONBOARD-GAPS launched twice.
- MAINFRAME-DESIGN died once.

### 1.2 What went right (keep it)
- **Every Opus lane through `agi-run.sh` landed.** Briefs carried the user's words. Commits were per slice, and reports sit in `docs/reviews/`.
- **Repro-first works.** STT went RED → GREEN on the phone class. On its first runs, the churn suite found 4 real bugs that no e2e had seen.
- **`systemd-run` supervision since 10-24.** No lane has died since.
- **The 10-27 intent echo.** The coordinator restated the user's thinking-out-loud as numbered questions before dispatching. That is the right pattern for dictated asks.

### 1.3 The frictions — evidence → cost → fix

| # | friction | evidence | cost | fix (→ spawn) |
|---|---|---|---|---|
| F1 | **Polling instead of events** | ~21 user turns across the two mains are "done? / next? / is it done / and now?". MAIN answered with 44 poll calls (log.tsv, pgrep) since 10-19 | ~21 turns; the user's attention; "I don't have a view" (10-22) | completion letters + phone push now (S4); the relay in v0.7.x |
| F2 | **The meta tax** | "what version is this?" 51 s / 5 bash calls · "why does :443 show no session?" 189 s · "what versions/ports?" 73 s · "what is the whole plan?" 91 s / 14 bash calls | minutes per question, and every answer is re-derived | OG-ctx = **inject** AGENTS.md into yggdrasil + `scripts/where.sh` (slots, versions, ports, lanes, gate, last URD row) (S5) |
| F3 | **Lanes die with their host** | MAINFRAME-DESIGN started 00:51 from MAIN's bash and died **01:00:05**: the second V07-GATE-FINAL restarted lk-yggdrasil (`KillMode=control-group`; MAIN's bash children live in that cgroup, and `setsid nohup` does not leave a cgroup). MAIN called it a "launch race" and read the stale `RUNNING` row twice ("still running", 03:29 and 07:33). ONBOARD-GAPS ran twice (tool timeout + nohup). **This lane is running in `opencode-legacy.service`'s cgroup right now.** | 6.5 h until anyone saw the death | `agi-run` always leaves the caller's cgroup; a reconciler turns RUNNING + dead pid into DEAD; a wave that restarts a brain first lists the lanes it hosts (S4) |
| F4 | **Chains fire anyway** | `chain-q8.sh` and `chain-q9.sh` wait up to 2 h, then start the next lane regardless. If one lane overruns, Q8 and Q9 append to one file at once | a silent write race on this deliverable | on expiry: stop + notify; one chain format (S4) |
| F5 | **The main couldn't see the screen** | "the mic icon" got 4 answers: gone by design → MAIN's composer → a cached page → the door's glyph in incognito. Only then did it read `roots.tsx:~487`. Grepping SSR HTML can't see client-drawn SVG. AGENTS.md says two corrections = stop and re-scope; it took four | 4 user corrections and 2 days | a phone-shot tool: the post-door state, the user's device class, a png into `artifacts/` in one call. The main and the waves **look** before answering (S6) |
| F6 | **The main built by hand** | the glyph fix was one 419 s turn: 4 builds (the jitless recipe rediscovered), a commit, a restart, **no e2e** (`bb6e265`). MAINFRAME-C's home spec "asks for the key exactly" may now be red | the slowest turn of the period, untested | Q4 diet; the jitless recipe in the sandbox AGENTS layer (S5); T8 reruns the specs |
| F7 | **Waves forgot the restart** | MAIN restarted `bifrost-sandbox` by hand 4 times so :8443 would serve what a wave had built (10-20, 10-21, 10-26, 10-27). Rule 10-03 = build + restart as one operation | the user sometimes tested an old build | the sandbox gets `deploy.sh`: build → restart → probe → served BUILD_ID = built BUILD_ID. Every build brief ends on it (S3) |
| F8 | **Artifacts split across trees** | waves wrote to `~/Work/bifrost/artifacts`, the :8443 gallery read the sandbox tree; one hand copy (10-26) | fixed by ARTIFACT-PLUMB | — (kept as the parity lesson) |
| F9 | **The URD ledger cherry-picked** | the voice row reads "PASS — STT 3-for-3, Bifrost clean", dated **10-06**. The test ran 10-19 09:18–09:33, and the raw MAIN shows **5 of 12** utterance-initial "Bifrost" lost (Eifelst, Efron, Frost ×2, Ifrast) plus 2 duplicate commits. The 10-23 retest on the onset-fix build: **2 of 8** lost (Defrost, Eifrost) | a PASS that isn't one; gate item 2 believed closed | URD rows carry n, misses, the test date and the build id; T3 re-measures (S1) |
| F10 | **Phantom runs read as echo** | 12 assistant runs in MAIN follow another run **with no stored user turn** (10-19 09:21–09:24, 10-23 11:15–11:16). Each starts ~2 ms after the previous one ends. The flash model saw its own earlier replies at the end of context and declared "echo bleed" six times. A real echo existed (UX-BATCH reproduced it A/B), but the transcript does not show what the brain was given | a misdiagnosis on the record, and an unfiled exactly-once bug | T2: every run has its persisted user turn; duplicate commits die at the agent (S1) |
| F11 | **A live outage no monitor saw** | 10-15 01:29: the coordinator `kill`ed the live brain (pid 2192792) and started `setsid nohup opencode serve` from a bash tool that the kill itself ended. Nothing listened on :4096 until the user reported it on **10-19 07:41**, ≈ 4.3 days. lk-verify (the daily e2e) fails every day: "FAILED — 45 passed", plus a git push auth failure. It pages nobody | v0.6 down 4 days; the "always a working previous" law broken in silence | lk-verify fixed, no auto-push, its RED goes to the phone (S3) |
| F12 | **The live brain is a hand-made unit** | 10-19 08:25: MAIN wrote `opencode-legacy.service` (the user said "you decide"). It works, but **`gate.py` is RED today**: `port.4096` expects `opencode-serve` | `promote.sh` runs the gate and rolls back on RED, so the ladder is blocked | the gate reads the brain unit from the release env; the legacy unit is made official, with your go (S3) |
| F13 | **Design docs on the wrong rung** | the root coordination design (a final-authority doc) was written on glm-5.3-flash, ~4 min per pass, in 3 passes. Rule 10-04b: Opus judges | the design was never judged | §4 is that judgment: the design holds, with amendments |
| F14 | **No model attribution** | yggdrasil stores no provider/model on assistant messages (all 91 in MAIN are blank). The design's attribution law can't be checked | the routing log (design §5) has no data source | one field per message (T9, S1) |

### 1.4 Our coordinator mistakes — the wrong-queue dispatches

| # | when | what | right queue |
|---|---|---|---|
| W1 | 10-14 11:16 | 3 diagnostic missions as REST turns on the **live** brain (:4096, the user's phone brain). The serve wedged and no turn ran for 14 h. The "fix" was the hand kill in F11 | `agi-run` lanes (Opus), measured, outside any live brain |
| W2 | 10-19 08:50 | re-dispatched as `[FIX] onb2 / stt2 / gap2`, plus a stray second opencode on **:4097** (`setsid nohup`, aborted). Meanwhile the user's MAIN had already launched ONBOARD-GAPS → ONBOARD-BUILD: two coordinators on one problem, in one tree | one coordinator per topic; the claim line first |
| W3 | 10-21 / 10-22 | the rules-distribution review was asked twice (two :4100 sessions, 21 min apart). It first "sat 24 h unanswered" on the wedged :4096 | one lane, one session, one claim |
| W4 | 10-22 02:54 | the coordination design: the first brief asked to **validate the coordinator's own design** (the user had said "don't design, let AGI propose"). A CORRECTION turn withdrew it; the brief was sent a third time. All three ran on flash, in a session titled `session` | one brief, the user's words verbatim, Opus |
| W5 | 10-22 06:10 → 10-23 10:40 | the v0.7 gate mission and its continuation, queued as REST turns (`POST :8090/api/session/{id}/messages`) into a session on the **sandbox brain**: the system under test, on flash, under the provider's rate limit. Wave 1 died on a 429 after 205 s. Wave 2 SIGKILLed its own host during the churn work and died uncommitted (the next boot closed its corpse, 10-24 01:00:05) | `agi-run` Opus: the same mission went green in 74 min on 10-24. ~42 h lost |
| W6 | 10-22 05:45 | the user heard "24 h" and asked "why 24h???". It was the old wall-clock stability item, relayed as a wait | Rule 10-09 (the user deleted the item that night) |

**The rule these share — proposed as coordinator law** (it enters the playbook only with your go, per Rule 10-08):
- Dispatch has **one door**: `agi-run.sh` under `systemd-run`, model by the ladder.
- Never into a brain that is live or under test. Never twice for one topic: the claim line comes first.

**Rule 10-08 terms.** Evidence: W1–W5. Scope: every coordinator session. Counterfactual: a REST turn is right for the user's own conversation, and for product tests of the dispatcher itself.

### 1.5 Fix map

| friction | fix type | spawn |
|---|---|---|
| F1, F3, F4, W1–W5 | tool: lane hygiene + completion letters + push | **S4 LANE-HYGIENE** |
| F2, F6 (recipe), OG-ctx | context: inject + `where.sh` + sandbox AGENTS layer | **S5 MAIN-CONTEXT** |
| F5 | tool: phone-shot | **S6 PHONE-SHOT** |
| F7, F11, F12 | tool: gate/promote/verify made v0.7-true | **S3 RELEASE-TOOLING** |
| F9, F10, F14 + T1–T10 | build + sim: the test gaps | **S1 V07-TEST-GAPS** |
| F6, F13, W-class | design → harness: the concierge diet | **S7 CONCIERGE** (v0.7.1) |
| LIFE.md is a 10-03 opencode-era audit | data | **S10 LIFE-REFRESH** |

---

## 2. Q2 — the v0.7 backlog: wanted, shipped, left to test

### 2.1 The gate (plan.md, 8 items) vs. what proved it

| # | gate item | proof today | verdict |
|---|---|---|---|
| 1 | onboarding v3 fast, greeting < 300 ms, clean flow | onboarding suite 8/8; greeting ≈ 100 ms, pre-recorded; first real voice turn 804 ms. The user, 10-24: "seems to work, good enough" | ✅ |
| 2 | "Bifrost" clean at utterance start | UX-BATCH #3 made the UI honest: "heard" only once the mic captures; the engine takes no bias terms. **Not in the gate-final matrix.** Real phone after the fix: 2 of 8 lost | 🟡 **T3** |
| 3 | echo bleed fixed | UX-BATCH #4: echo gate, replay A/B. **Not in the matrix.** No real-phone evidence since; the 10-23 "sighting" was F10 | 🟡 **T4** |
| 4 | accelerated churn proof | `stability_suite.py` 8/8 phases, 182 s | ✅ |
| 5 | session lifecycle on the root | general suite 57 pass / 0 fail / 2 honest skips (OG-think) | ✅ |
| 6 | version string 0.7.0-x on the sandbox | **❌ :8090 serves `v0.5.0-74-gbb6e265`.** The sandbox's `package.json` says `0.5.0-73-g61182dc`. The 10-20 "version sync fix" (662fc23) changed **trunk's** `package.json` only | ❌ **T1** |
| 7 | voice tests don't pollute MAIN | voice-test room, default off, e2e green. The voice agent still maps room → session **by title**, once per job | 🟡 **T7** |
| 8 | queued REST turns run + reply | churn phase 5: 20/20 queued turns replayed exactly once (REST path). The voice path: 12 phantom runs + 7 duplicate turns (F10) | 🟡 **T2** |

The gate-final matrix certifies build `dBAzIRkZMnA43odv0JWmO`, sandbox HEAD `223836f`. Since then the sandbox moved 15 commits (ARTIFACT-PLUMB, MAINFRAME-C, `bb6e265`). Under Rule 10-08.5 that green **does not carry** to the build that gets frozen (T11).

### 2.2 Everything the user asked for in the v0.7 period (both mains, 10-14 → 10-27)

| # | ask (when) | status | evidence |
|---|---|---|---|
| A1 | record the tests (10-14) | ✅ | `docs/urd/tests.md` |
| A2 | sub-sessions find out what went wrong (10-14) | ✅ | sim-gap + Rule 10-08.5 |
| A3 | fully simulated, reproduced, fixed (10-14) | ✅ | STT repro RED→GREEN; gate-final |
| A4 | v0.6 must keep working, builds separate (10-19) | 🟡 | works on the hand-made `opencode-legacy`; gate RED (F12) |
| A5 | onboarding = veraldar.org's, same voices (10-19) | ✅ | one script + one voice pack (ONBOARD-BUILD) |
| A6 | QR → the app with the onboarding preset (10-19/20) | ⏭ v0.8 | by plan: rides the bridge + app |
| A7 | AGI checks gaps first, then builds (10-19) | ✅ | ONBOARD-GAPS → ONBOARD-BUILD |
| A8 | "why 0.5.0, not v0.6+?" (10-19) | ❌ | = gate 6, T1 |
| A9 | MAIN rename silent; no LLM shown (10-20) | ✅ | ONBOARD-UX |
| A10 | voice tests out of MAIN (10-20) | ✅ | voice-test room (UX-BATCH #5) |
| A11 | any coding plan, not only z.ai (10-22) | ✅ | DOOR-V3 |
| A12 | the phone's back button is safe (10-22) | ✅ | DOOR-V3, e2e |
| A13 | plain words; no "box"; the names explained (10-22) | ✅ | DOOR-V3 + FILM-NAMING |
| A14 | the far-vision film on veraldar.org; no dead air while the voice loads (10-22) | ✅ | FILM-V1 |
| A15 | the film = what we sell today; coherent with the 15 s film; the naming judged (10-22) | ✅ | FILM-NAMING |
| A16 | **a view of what runs + an event when it's done** (10-22) | ❌ | design only. The triad is on the wire (`state` on every session). **No component reads it**: the promised chips never shipped |
| A17 | the coordination design (10-22) | ✅ doc | flash-written; Opus judgment in §4. Build ⏭ v0.7.x |
| A18 | a faster/better model for the main (10-22) | 🟡 | open; §4.4 answers it |
| A19 | rules reach every session of every root (10-21) | ❌ | two reviews (W3), no decision recorded |
| A20 | herdr takes + an R&D lane (10-22) | 🟡 | herdr folded (triad + pins); field-watch never ran (§5) |
| A21 | the door's "or type"; the stuck typed message (10-23) | ✅ | UX-BATCH #1/#2 |
| A22 | only simulation is proof; the user tests finished product (10-22) | ✅ | Rules 10-09/10-10; gate-final |
| A23 | three mainframe designs, no code (10-24) | ✅ | MAINFRAME-DESIGN |
| A24 | new artifacts show at :8443/artifacts (10-26) | ✅ | ARTIFACT-PLUMB |
| A25 | Proposal C: tap = MAIN, hold = hands-free (10-26) | ✅ | MAINFRAME-C, 12/12 specs |
| A26 | the roots' mic glyph goes (10-27) | 🟡 | removed by hand (`bb6e265`), built, **not e2e'd** (T8) |
| A27 | replay the onboarding from the app (10-22, offered by MAIN) | ❌ | never dispatched; only the console recipe |

**18 ✅ · 3 🟡 partial (A4, A18, A26) · 1 ⏭ v0.8 by plan (A6) · 5 ❌ open (A8, A16, A19, A27, plus field-watch inside A20).** A17 counts as shipped because its deliverable was the doc.

Your decisions still owed from the period:
- **OG-ctx** (§6 step 4).
- **The 41 `e2e-*` debris sessions** in the live brain: delete or archive (gate-final, untouched).
- **A19**, the rules distribution.

OG-mainframe is settled: you picked C on 10-26. It moves to the journal.

### 2.3 What remains to TEST on v0.7 — the complete list

**(A) AGI-owned, in simulation, before any invitation (Rule 10-10).** Every item runs on **the build that gets frozen** (T11).

| # | test | the property | today |
|---|---|---|---|
| T1 | version string | the sandbox and the frozen rc display `0.7.0-x`; an e2e asserts it | ❌ shows v0.5.0-74 |
| T2 | voice-path exactly-once | 20-utterance burst, PTT and hands-free, through the lab agent + a LiveKit room: one utterance = one stored user turn = one run; 0 phantom runs, 0 duplicate commits | ❌ 12 phantom runs, 7 duplicates in MAIN |
| T3 | onset on the phone class | utterance-initial "Bifrost", **spoken at the press** (the user's habit): reproduce the 25–42 % loss, then capture from the press (pre-roll ring buffer), then ≤ 1/20 lost | ❌ the UI cue is honest; the audio is still cut |
| T4 | echo, speaker on | the replay test on the frozen build in hands-free; the 10-23 "sighting" re-read against T2's fix | 🟡 A/B on 10-23's build only |
| T5 | STT language + no-speech | ambient noise in hands-free became a Chinese turn in MAIN (10-26 18:51, "哎，大哥。 同事。"). Pin the language to the door's choice; no speech → no turn | ❌ unfiled |
| T6 | send while working | two MAIN turns aborted 1.5–9 s after send when a second message followed (10-23 02:35, 10-26 17:43). Decide queue or interrupt; either way the triad says `blocked/interrupted` and nothing vanishes silently | ❌ unfiled |
| T7 | voice agent session pin | the agent resolves the session by **id**, not title; a namesake or renamed session never takes voice turns (the phone side is pinned already) | ❌ open in gate-final |
| T8 | the roots without the glyph | MAINFRAME-C's 12 specs + MAIN's specs on `bb6e265`+ | ❌ not run since the hand edit |
| T9 | model attribution | every assistant message records the model that served it | ❌ blank |
| T10 | the triad chips | ship them in the deck (A16, the user's "view"), or strike them from v0.7 in writing | ❌ promised, absent |
| T11 | artifact parity | the whole matrix (onboarding 8, general, churn, verify-real-upstream, herdr, watchdog-zombie, the yggdrasil mock suite, T1–T10) on the **trunk-merged** build that gets frozen; receipts carry its hash | ❌ last green = `dBAzIRkZ…` |
| T12 | rollback rehearsal | on the frozen rc: `--rollback` to v0.6.1 and forward again. MAIN on :4100 untouched; the v0.6 sessions on :4096 intact; the gate GREEN at each end | ❌ never run with a yggdrasil release |
| T13 | the root's store | backup + restore of `~/.local/share/yggdrasil` (STABLE v0.7 row: "one supervised, backed-up store"); restore proven on a copy | ❌ not built |

**(B) Your consent check: once, on the frozen rc, about 5 minutes.** These are the gate-final's four steps plus three lines:
1. MAIN, keyboard: "Reply with one word: ready". It lands, and "working…" clears.
2. MAIN, voice: hold, ask, release. The transcript appears and the reply is spoken.
3. Another session: "Reply with one word: here". It lands **there**, and its dot shows, then clears.
4. Settings → voice tests: reads off.
5. *(new)* The front page: tap the roots → MAIN; hold the roots → talk without leaving; no glyph.
6. *(new)* Cold start: "Bifrost, what time is it?" said **at** the press. "Bifrost" lands.
7. *(new)* Hands-free with the speaker on: one reply plays, and no turn of yours repeats it.

**(C) Named SKIPs — what simulation can't reach.** Under Rule 10-08.5 these are written into the release notes, not carried as green:
- your phone's mic privacy toggle;
- One UI battery rules on notifications;
- room acoustics beyond the replay test;
- screen-off voice (v0.8 material).

---

## 3. Q3 — the Mac's Squid, Flow, Workers, Letters: into the roots?

**Basis.** This is decided from the user's description plus the doctrine. Nothing on the Mac was read (§3.3 lists what to read there).

**The assumption.** The Mac runs another root of the same tree, and these four are its organs. The names mean what the user said: Squid = scheduling, Flow = pipelines, Workers = workers, Letters = async session-to-session messages.

The doctrine applied:
- the light-prompt law;
- STABLE 7: autonomy is opt-in, and MAIN is never in a registry;
- STABLE 8: safety lives in the harness, not in prose;
- the coordination design: main-mediated, depth 1, terminal events only;
- herdr AVOID #2: no sibling prompting;
- Rule 10-02: rebuild the life, not the surface;
- the connectors precedent: evidence-triggered.

| Mac concept | in our design it is | what it adds that we lack | verdict | lands |
|---|---|---|---|---|
| **Letters** | the queued-turns relay (design §3: a sub's terminal event becomes a queued turn for the main) + the delegate skill's file pattern | an **addressed, durable mailbox**; non-terminal kinds; and above all **a lane that is not the user's transcript**. Today a relay can only be a turn in MAIN, and MAIN already got polluted once (voice tests, 10-20). This is also the user's 10-27 06:33 point (Q8): sessions have only two voices | **ADOPT as the relay's envelope.** One schema: `{id, from, to (session ids, pinned), kind: result · blocked · question · note, body ≤ one screen, artifact refs, model, time}`. Letters land in an inbox. The harness turns only `result` and `blocked` into **one line** in MAIN, plus a phone push. Notes stay pull. No sub→sub letters (depth 1) | **v0.7.x**, with spawn/relay. Build the relay letter-shaped from day one, so there is one schema, never two. Cross-root letters: v1.0, over the bridge + grove addressing (Q8) |
| **Squid** | **the Nornir**, the schedulers in `vision.md`: named, never built. Today: 2 timers (lk-verify, failing daily; worldtree, fine). The research feed is "weekly" but ran once (10-07). The ygg-sim loop's last cycle was 10-07. fleet-watchdog and ygg-driver were stopped 10-06 (STABLE 7) | **the mechanism behind Rule 10-07** ("continuous, not per-release"): the playbook's biggest law with nothing that runs it | **ADOPT, with hard walls.** One declared schedule file. Each job has a name, cadence, lane, model, brief file, wall-time and token budget, owner, and `enabled_by: user`. systemd timers run it → `agi-run` under `systemd-run`. **No LLM decides when.** A job never targets MAIN. Every run writes a receipt. Two consecutive failures disable the job and notify the phone | **v0.7.x for the fleet** (research feed, field-watch, sim cycle, lk-verify). It is tooling, not product. Product scheduling ("remind me", nightly consolidation) → **v1.0, inside dreaming** (`spec-dream.md` D1) |
| **Flow** | the hand-written chains (`chain-onboard-build.sh`, `chain-q8.sh`, `chain-q9.sh`) + the ladder's split (Sonnet research → Opus judge → Sonnet verify) | the failure semantics the bash chains lack (F4: on expiry they start the next step anyway), plus resume after a reboot | **ADOPT MINIMAL.** A flow = ordered steps (lane, model, brief, done-check), on-fail = stop + notify, one supervisor, state in `log.tsv`. No DAG engine, no LLM in the control path | **v0.7.x tooling.** Product pipelines: never by default (evidence-triggered, like connectors) |
| **Workers** | sub-sessions with a role (`spawn_session`, role → model config), and today's `agi-run` lanes | the **herd view**: what runs, on what, since when, blocked or not. That is herdr's triad plus `agi-status` | **No new concept.** A worker is a sub-session. Take only the registry view (T10 chips + `where.sh`). Long-lived worker pools: no (idle cost, no evidence) | v0.7.x with `YGG_SUBSESSIONS`; cross-root workers at v1.0 |

### 3.2 What goes into the root vs. the box
- **Into yggdrasil, the product root:**
  - **Letters**: the user's "tell me when it's done" is product.
  - **Workers**: sub-sessions.
- **Fleet tooling on the box first (scripts + systemd):**
  - **Squid and Flow**: they schedule and chain AGI lanes, not user features.
  - They enter the root only through dreaming (v1.0), where the root schedules its own night work.

### 3.3 What to check on the Mac (S9 MAC-REVIEW — needs the new access you mentioned)
Read the **life**, not the surface (Rule 10-02): the data, the logs, the usage counts.

- **Letters:**
  - storage (files or DB);
  - delivery (at-least-once? ack? expiry?);
  - addressing (by id or by name — our pin lesson);
  - how a letter enters the receiver's context (an injected turn or a tool read);
  - the loop guard;
  - usage: letters per day, sender → receiver pairs, how many were ever read.
- **Squid:**
  - the schedule format;
  - the missed-run policy (catch up or skip);
  - concurrency caps and budgets;
  - who may create a schedule (an LLM or only a human);
  - the failure path;
  - jobs run and failed in the last 30 days.
- **Flow:**
  - step-state persistence;
  - retries;
  - resume after a reboot;
  - how one step's output reaches the next (files or letters).
- **Workers:**
  - lifecycle and isolation (a worktree each?);
  - model per worker;
  - timeouts and kill;
  - cost metering;
  - how a worker says "blocked".
- **Incidents:** the Mac's own versions of W1–W5.

**What would change the verdict:**
- letters used peer-to-peer at volume with no loops → revisit depth 1;
- an LLM-driven scheduler stable for weeks → revisit "no LLM decides when".

Anything else confirms §3.

---

## 4. Q4 — the main's tool diet

### 4.1 Verdict: agreed. It is the coordination design, made strict
The design (§4.2) already says: *"The main is the user's fast model, low temp, tiny context — routing and relay only. If it catches itself working, it spawns."*

The user's version replaces "if it catches itself" with the harness taking the tools away. That is STABLE rule 8: safety in the harness, never in prose.

The v0.7 evidence from both mains points one way:
- **Where the main delegated, it landed:** 11 of 11 Opus lanes.
- **Where it worked by hand, the period's worst outcomes:**
  - F11: killed the live brain;
  - F12: wrote a live unit;
  - W2: a stray :4097 server;
  - F5/F6: four wrong answers, then a 419 s untested hand build;
  - F2: the meta tax.
- **Every boundary break of the period came from a main's bash.**

### 4.2 The diet spec (MAIN only)

| tool | MAIN | subs / topic sessions | why |
|---|---|---|---|
| talk (reply, voice) | ✅ | ✅ | |
| read / grep / glob, read-only | ✅ | ✅ | meta questions in ≤ 1 call, with OG-ctx |
| **status** (`where.sh`: slots, versions, ports, lanes, gate, last URD row) | ✅ new | ✅ | F1, F2 |
| **look** (phone shot, read-only) | ✅ new | ✅ | F5 |
| **spawn**(topic, brief, role, tree, done-check) → id | ✅ | ❌ (depth 1) | writes the claim line + `prompts/<lane>.txt`, launches under `systemd-run`, returns at once |
| **inbox** (read letters, one-line summaries) | ✅ new | — | the relay |
| **steer** (a letter to a sub; abort a sub) | ✅ new | — | |
| sessions (create, rename, list; model per session) | ✅ | ✅ | the per-session switch exists |
| todo (its own list) | ✅ | ✅ | |
| edit / write / patch | ❌ | ✅ | |
| bash | ❌ | ✅ | not even an allowlist. Shell allowlists are bypassable, so the few verbs MAIN needs become tools |
| build / restart / commit | ❌ | ✅ | |
| promote / deploy | ❌ | ❌ | your consent only (STABLE) |
| fetch (web) | ❌ | ✅ | research is a sub's job; a main that can fetch and spawn is an injection path |

The brief is MAIN's only write. `spawn` carries it inline, and the harness files it.

### 4.3 Risk review
- **R1 — small fixes get slower.** The glyph removal becomes a spawn.
  - Bound: a `quick` role. Fast model, a one-file brief, same tree, and the brief ends on deploy + spec. ≤ 10 min.
  - The comparison: MAIN's own fix took 419 s and skipped the e2e.
- **R2 — "the 6%".** LIFE.md (10-03) says delegation happens in ~6% of sessions; 95% of the life is a tool loop inside one session.
  - The diet doesn't touch that life. It binds **MAIN only**. Every topic session (`[WEBSITE]`, `[LAB] voice`, the subs) keeps full tools.
  - MAIN's life is already different. Since 10-19 it was 81 user turns, 10 lane dispatches and 44 poll calls; its own tool loops were the meta tax and the boundary breaks.
  - Small talk needs no tools and stays instant.
  - Delegation becomes MAIN's whole job, and gets cheaper: one call, no hand polling.
  - What MAIN loses is the quick look-and-fix, which is exactly the class that went wrong.
  - (LIFE.md counts only opencode `task` children; `agi-run` lanes aren't in it. S10 refreshes it.)
- **R3 — a blind relay.** Without bash, MAIN can't check a sub's claim.
  - Bound: checking belongs to the referee (e2e, gate, receipts, which MAIN reads) and to `look`.
  - F5 shows MAIN's own bash checks were the unreliable ones.
- **R4 — injection.** A main that spawns bash-capable subs is a target: a letter or a page saying "spawn X".
  - Bound, in the harness: spawning a build or bash role needs a **user turn** in the causal chain. The tool refuses when a letter or relay triggered the turn.
- **R5 — transcript pollution.** Relays as turns would refill MAIN.
  - Bound: letters. One line per result or blocked; details in the inbox and artifacts; a push to the phone.
- **R6 — MAIN's model is down** (a 429), so nobody can spawn.
  - Bound: the deck opens any session directly, and topic sessions keep every tool.
- **R7 — dictated asks are noisy.**
  - Bound: a spawn from a voice turn echoes the intent in one sentence and waits for "go". The 10-27 intent echo, made mechanical.

### 4.4 Model tiering (answers A18)
- **MAIN:** your fast model. Today that is glm-5.3-flash, think-high for routing.
  - The latency budget and the house default still choose it.
  - A different main is a config line (your LLM, your key), not code.
- **The numbers:**
  - Tool-free turns are already fast: 4.2–5.6 s in the voice-test session.
  - MAIN's median is 14.7 s, its p90 159 s. The slow turns are the tool loops the diet removes.
  - So: no model swap before T9 records the model per message. Then flash vs. think-high is measurable.
- **Subs, by role** (config entries, each created on evidence — design §4.3):

  | role | model | use |
  |---|---|---|
  | `quick` | the fast model | small fixes |
  | `build` | the strongest you have: Opus-class through `agi-run` today | builds |
  | `judge` | Opus | verdicts (Rule 10-04b) |
  | `research` | Sonnet-class | research passes |

  This is the 10-04b ladder. yggdrasil's role config inherits it when `spawn_session` lands.

### 4.5 Landing
- **Now, no code:**
  - the coordinator law (§1.4);
  - S4's lane hygiene;
  - this diet applied to the two mains as practice. Any build goes to a lane.
- **v0.7.0:** nothing. The gate stays as written: one structural change per version.
- **v0.7.1**, the first rung after promotion, built in the next slot, behind `YGG_CONCIERGE=1` for MAIN only:
  - the concierge profile: MAIN's agent = §4.2, enforced by yggdrasil's per-session tool list;
  - `spawn` wraps `agi-run` under `systemd-run`;
  - `status`, `look` and `inbox` as tools;
  - letters as files.
- **v0.7.x:** `parent`, `spawn_session` and the letter relay inside yggdrasil (design §7), behind `YGG_SUBSESSIONS=1`.
- **v0.8:** blocked/result pushes; role config visible in the PWA.

---

## 5. Q5 — the R&D lab: run it now?

### 5.1 What actually runs today (also answers 06:35: "which labs run, on this machine?")

| lab | declared | what the box shows | on a loop? |
|---|---|---|---|
| research feed (arXiv) | weekly | **one** pass (10-07); pass 2 never ran | ❌ |
| field-watch (repos/tools) | proposed 10-22 | never ran | ❌ |
| ygg-sim (the self-improving sim) | continuous (Rule 10-07) | container up 3 weeks, **last cycle 7 on 10-07** (the driver/watchdog stop of 10-06 also stopped its loop) | ❌ |
| voice lab | "24/7, self-improving" (the user's expectation) | `[LAB] voice` last active 10-22; no timer; v0.6.2 in-process STT stalled on French | ❌ |
| worldtree | nightly | `worldtree-fetch.timer`, runs daily | ✅ the only one |
| hardware (PCB) / silicon | lab sessions | `[LAB] hardwar` last 10-06; `[LAB] silicon` 10-08, 2 min | ❌ dormant |
| lk-verify (daily e2e) | daily | runs, **fails every day** | ⚠️ |

The playbook's "continuous" law (Rule 10-07) has no mechanism.
- Nobody decided against it. It lacks a scheduler (Squid/Nornir, §3), and autonomy was stopped on 10-06 with nothing to replace it.
- The trend metrics behind "are we improving?" belong to Q9.
- *(Q10)* §10.4 replaces this table with evidence per lab (16 rows); §10.5 sets the loop order.

### 5.2 Decision: **run it now — on a schedule, not 24/7**

**Why now.** The cost of not watching showed up inside v0.7:
- herdr shipped the triad and atomic prompt+wait while we were designing coordination, and we learned that by hand (herdr §4);
- connector demotion is "evidence-triggered", but nothing generates the evidence;
- you want STT on the phone, with only text crossing the trunk. On-device speech moves fast, and open-questions #3 has waited since 09-30.

**Why not 24/7.** An always-on research session:
- burns tokens and has no done-check;
- risks co-cheating: self-evolving loops improve their own signal while external truth slips (Rule 10-05 law 2).

The field's own pace is the cadence:

| what | how often |
|---|---|
| papers | weekly |
| repos | monthly |
| release radar (no LLM until a pinned repo actually releases) | weekly |

"Continuous" here means scheduled plus incident-triggered, not always awake.

**Cost.** From the lane ledger, research/design lanes run 10–40 min.

| job | lane |
|---|---|
| papers, weekly | ≈ one Sonnet lane, 20–30 min |
| field-watch, monthly | one Sonnet lane ≈ 45 min, plus an Opus judge ≈ 15 min only when T/A items exist |
| radar | Atom feeds, no tokens |

All of it runs through `agi-run` (no pay-per-token API). GitHub fetches are unauthenticated and stay outside the 12:30 UTC worldtree window, which shares the IP budget.

**It needs your go** (STABLE 7: autonomy is opt-in). The walls:
- the jobs never touch MAIN and never build;
- they write only `docs/research/` and receipts;
- a T or A item becomes a *candidate* lab slice through the normal playbook. A person or the coordinator decides whether to build it.

### 5.3 The first pass (S8: three lanes, one go)
1. **RESEARCH-FEED pass 2** (Sonnet; Opus only for playbook deltas).
   - The 7 locked queries since 10-07.
   - Plus one new query: on-device streaming ASR/TTS for phones, EN + FR (the v0.6.2 French gap).
2. **FIELD-WATCH seed** (Sonnet → Opus judge on T/A).
   - The 12 pins of herdr-takeaways §4, with herdr as receipt 0.
   - First thing to watch: opencode upstream's parent/task semantics (our spawn design).
3. **VOICE RADAR** (Sonnet). On-device STT/TTS for the phone-side STT you asked for: browser runtimes (WebGPU/WASM) and Android-native ones.
   - Per candidate: languages, size, RTF on a mid-range phone, licence, streaming.
   - It ends with the 1-day RTF spike plan that open-questions #3 called for.
   - It feeds v0.8: the Android app, with its foreground-service mic, is where phone-side STT can live.

**Done-check per lane:** a dated PASS section in its ledger, an index JSON, and T/A/N lines that each end "drives: product / lab / playbook / none".

Then the schedule file gets four entries, each enabled by you: the three above, plus **ygg-sim cycle 8, weekly**. Its brief carries the v0.7 incidents, per Rule 10-07 source 1: F10 phantom runs, onset loss, STT language, the cgroup kill.

The PCB and silicon labs stay dormant until you ask. They don't gate any rung ("background, never gates a release" — plan.md).

---

## 6. Q6 — what remains: drop v0.6 → promote v0.7 → start v0.8

**Where we stand.**
- Live is `v0.6.1` (`promote.sh --list`: LIVE v0.6.1 / PREVIOUS v0.6-stable.1, both on brain :4096).
- **`gate.py` is RED today: `port.4096`**. The listener belongs to `opencode-legacy.service`, made by hand on 10-19; the gate expects `opencode-serve`. `promote.sh` runs the gate and rolls back on RED. Until step 0, no promotion can stick.
- The next slot runs from three worktrees, against STABLE rule 1 ("nothing is served from a worktree"):
  - PWA: `~/Work/bifrost-sandbox`;
  - agent: `~/Work/lane2-merge/agent`;
  - root binary: `lab/yggdrasil/target`.

Owners:
- **WAVE** = an AGI lane;
- **USER** = you;
- **PROCESS** = scripts, the gate, timers.

| # | step | owner | done when |
|---|---|---|---|
| 0 | **Make the live gate true.** `gate.py` takes the brain unit from the release env; `opencode-legacy` becomes v0.6's declared brain unit, or goes back under `opencode-serve`'s name. Touching the live brain's unit = your go | WAVE (S3) builds, USER consents | `gate.py` GREEN on v0.6.1 |
| 1 | **lk-verify fixed:** the specs behind its daily "FAILED — 45 passed", no auto-commit/push (it fails on GitHub auth every day), RED → a phone push | WAVE (S3) | a daily run that is GREEN, or RED with a push |
| 2 | **T1–T10 closed in the sandbox** (§2.3 A) | WAVE (S1) | each red → green, specs in the suite |
| 3 | **Trunk merge.** `lab/sandbox` (59 ahead, 222 files) + `lane2/merge`'s agent + one yggdrasil line (`lab/yggdrasil` canonical; `release/v0.9.0`'s voice mode folded in) → `rebuild/cohesive-opus`. Rebuild `bifrost-sandbox`, `lk-agent-ygg` and `lk-yggdrasil` from trunk | WAVE (S2) | next-slot units run trunk builds; no lab worktree serves |
| 4 | **Decide OG-ctx** (recommended: inject AGENTS.md; F2 is the evidence) and **OG-think** (recommended: accept the one-model catalog for v0.7.0) | USER | one word each |
| 5 | **`promote.sh` learns the next slot.** `--slot next` freezes :8443's build + agent + root binary + env into a release (STABLE: "the first step of v0.7"). Plus the root-store backup (T13) | WAVE (S3) | `--list` shows a NEXT row; a restore proven on a copy |
| 6 | **Freeze `v0.7.0-rc1`** into the next slot, then run the whole matrix on it (T11) and the rollback rehearsal (T12) | PROCESS + WAVE | receipts carry rc1's hash; all green |
| 7 | **Your consent check** (§2.3 B, ~5 min) on rc1, then the URD row (n, misses, date, build id) | USER, then WAVE writes the row | your go |
| 8 | **The week in the next slot** (STABLE v0.7 row). You have lived on :8443 since 10-19, but on worktree builds; rc1 is the first frozen artifact. **Recommendation: 72 h on rc1 with zero hand fixes**, because 8 days of daily use already happened on near-identical builds. Your call; the week stays the default | USER (daily use) + PROCESS (the daily gate) | 72 h (or 7 d), zero hand fixes |
| 9 | **Promote:** `scripts/promote.sh <rc1 commit> --label v0.7.0`. The release env's `OPENCODE_URL` → :4100, so :443 serves v0.7 and your [MAIN] on the root carries over. v0.6.1 becomes PREVIOUS, and `opencode-legacy` keeps running for the rollback week | USER consents, PROCESS runs (`gate --full` GREEN or auto-rollback) | gate GREEN on :8080 + the URD row |
| 10 | **Drop v0.6** after a week of v0.7 live with zero hand fixes. Stop `opencode-legacy` (your go). The release dirs stay on disk (STABLE: keep them all). The 41 live `e2e-*` debris sessions get deleted or archived (your go). STABLE's "What is live" is rewritten | USER go, WAVE edits docs | v0.6 = one `--switch` away on disk, no running brain |
| 11 | **Start v0.8.** <ul><li>Re-create the next slot with **its own root instance**: own port, own store ("one brain per store"; :4100 is now live).</li><li>plan.md gets the v0.8 gate from STABLE's v0.8 row: QR pairing; text + voice over the bridge with tailscale off; screen-off voice through a foreground-service mic; revoke kills access; no unauthenticated listener; sim `bridge.*` + `app.*` green; the bridge's two blocking workers made async.</li><li>`lane2/merge`'s bridge merges on trunk.</li><li>**v0.7.1 (the concierge, S7) rides that slot first.**</li></ul> | WAVE (plan + slot) + USER (go on the v0.8 gate) | plan.md has the v0.8 checklist; the next slot carries v0.7.1 → v0.8 |

**Two rulebooks, one order.**
- plan.md says "URD row → v0.8 starts".
- STABLE says each version lives on daily use before the next is promoted.

They agree once split:
- v0.8 **building** may start in a lab after step 7.
- v0.8 **in the next slot** waits for step 9, because the slot holds rc1 until then.

The step 1–3 waves must not wait on step 0's live-unit go: they work in the sandbox and on trunk, never on live.

---

## 7. The plan + the spawn list

### 7.1 Sequence
**This week (no promotion yet):**
1. **S4 LANE-HYGIENE first.** It is short, and it protects every later lane. S1 restarts the root, which kills any lane still inside the root's cgroup (F3).
2. Then, in parallel, because their files don't overlap:
   - **S3 RELEASE-TOOLING** (scripts: gate, promote, verify, deploy);
   - **S5 MAIN-CONTEXT** (`where.sh` + the AGENTS layers);
   - **S6 PHONE-SHOT** (a new script);
   - **S1 V07-TEST-GAPS**. It owns every yggdrasil, agent and sandbox-PWA code change, including the OG-ctx injection once you decide.
   - *(Q8)* **S11 GROVE-LANES-SPEC**, after S4. It is a doc lane and touches no code, so it doesn't conflict with S1.
   - *(Q9)* **S12 APK-SIM** and **S14 METRICS-LEDGER**, after S4. They touch only the lab and scripts, so they don't overlap S1:
     - S12 owns `pwa/android` and the `app.*` family;
     - S14 owns `scripts/metrics.py` and `docs/metrics/`.
   - *(Q9)* **S13 SIM-REVIVAL**'s incident register (a doc edit).
   - *(Q10)* **S15 VOICE-BENCH** and **S17 LABS-REGISTRY**, after S4. S15 works in its own repo (`~/Work/voice-lab`), so it overlaps nothing. S17 touches `docs/labs.md`, one `where.sh` subcommand (after S5) and worldtree's nightly script.
   - *(Q10)* **S16 PHONE-STT-SPIKE** after S12's first slice and S15's corpus v1. Its S22 column waits for item 9.
3. **S2 TRUNK-MERGE** after S1's slices land. Merging a moving target is the claims-race class. The yggdrasil part may merge first.
   - *(Q9)* Then **S13**'s cycle 8 runs on S2's trunk hashes. Its `rest.*` result is T11's root line.
4. §6 steps 5–9: freeze rc1 → matrix + rollback rehearsal → your check → 72 h / 7 d → promote.

**After the promotion:**
- **S7 CONCIERGE** = v0.7.1 in the next slot.
- Then the v0.8 slot (§6 step 11).

**On your go, in the background:**
- **S8** R&D first pass + the schedule file;
- **S9** Mac review (needs your access);
- **S10** LIFE refresh, which feeds R2 and Q9's metrics.

**Your one-word decisions, in order:**
1. the `opencode-legacy` unit (step 0);
2. OG-ctx;
3. OG-think;
4. the R&D timers (S8);
5. the coordinator law (§1.4) into the playbook, *(Q8)* with its two lines from §8.7: "authority never travels with a message" and "no session writes `user` turns into another session";
6. 72 h or 7 d (step 8);
7. later: the debris sessions;
8. later: stopping `opencode-legacy`;
9. *(Q9)* the S22 over wireless debugging: a one-time pairing, then AGI runs the device probes (§9.1);
10. *(Q9)* the uptime probe timer (§9.4);
11. *(Q10)* the voice-lab schedule: radar daily, bench nightly, re-eval on a release (≤ 4 a month) (§10.3);
12. *(Q10)* the STABLE amendment: STT on the phone, "your voice never leaves the phone", a v0.8.1 row (§10.2);
13. *(Q10)* PCB, silicon and mini-agi stay dormant, with the wake triggers of §10.5.

*(Q10)* **After the v0.8 promotion:** v0.8.1 "voice stays on the phone" (EN, per-device flag) in the next slot (§10.2).

### 7.2 Spawn list

| # | lane | model | scope (files) | done-check | after |
|---|---|---|---|---|---|
| S1 | **V07-TEST-GAPS** | opus | **sandbox PWA:** T1 version, T3 pre-roll, T4, T6, T8, T10 chips · **agent** (`lane2-merge/agent`): T2 de-dupe, T5 language, T7 id pin · **yggdrasil:** T2 run accounting, T6 `blocked/interrupted`, T9 model field, OG-ctx on your word | each T red → green with its spec in the suite; the full matrix rerun on the final build; URD rows with n / misses / build id | S4 |
| S2 | **TRUNK-MERGE-V07** | opus | `lab/sandbox` + `lane2/merge` + `release/v0.9.0` → `rebuild/cohesive-opus`; the three next-slot units rebuilt from trunk | the T11 matrix green on the trunk build; `gate.py` INFO lines show no lab-worktree cwd | S1 |
| S3 | **RELEASE-TOOLING-V07** | opus | `scripts/gate.py` (brain unit from the release env; a yggdrasil brain as a live unit); `scripts/promote.sh` (`--slot next`, root-store backup); `lk-verify` (find the specs behind "FAILED — 45 passed", stop the auto-commit + auto-push that fails on auth daily, RED → push); the sandbox `deploy.sh` (build → restart → probe → served BUILD_ID = built) | `gate.py` GREEN on v0.6.1 after your unit go; `--list` shows NEXT; `deploy.sh` refuses a stale served build | — |
| S4 | **LANE-HYGIENE** | sonnet | `scripts/agi-run.sh` (`systemd-run` by default, out of the caller's cgroup; a completion letter into `artifacts/letters/` + `/api/push`); `scripts/agi-status.sh` (RUNNING + dead pid → DEAD); one chain format that **stops** on expiry; the §1.4 coordinator-law draft | restarting the hosting brain kills no lane; a killed lane reads DEAD ≤ 60 s; a finished lane pushes (named SKIP: the real phone) | — |
| S5 | **MAIN-CONTEXT** | sonnet | `scripts/where.sh`; a `~/Work/bifrost-sandbox` AGENTS layer (the jitless build recipe, `deploy.sh`, the artifacts rule, the restart rule); pointer lines in `~/Work/AGENTS.md` | "what version / what URL / what runs / what do I test next" each answered from one `where.sh` call (spec) | — |
| S6 | **PHONE-SHOT** | sonnet | `scripts/phone-shot.mjs`: Playwright, Pixel-class viewport; states = door, returning front page, MAIN, settings; → `artifacts/*.png` | the 10-27 glyph shows up as a png in one call against the pre-`bb6e265` build | — |
| S7 | **CONCIERGE (v0.7.1)** | opus | yggdrasil per-session tool list + `spawn` / `status` / `look` / `inbox` / `steer`; `YGG_CONCIERGE=1`, MAIN only (§4.2, §4.5) | under the flag an edit/bash call by MAIN is impossible (spec); spawn → lane → letter → one line in MAIN + a push; small-talk latency within ±10 % | §6 step 9 |
| S8 | **R&D-FIRST-PASS** | sonnet + opus judge | `docs/research/`: research-feed pass 2, field-watch seed, voice radar; the schedule file (4 jobs, each `enabled_by: user`) | 3 dated PASS sections + index JSONs; T/A/N lines | your go |
| S9 | **MAC-REVIEW** | opus | read-only on the Mac: the §3.3 list | `docs/research/mac-yggdrasil-tools.md`: usage counts, plus the §3 verdicts confirmed or revised | your access |
| S10 | **LIFE-REFRESH** | sonnet | `lab/yggdrasil/LIFE.md` v2 for the v0.7 period: both mains (:4100 + :4096 stores) + `.agi-log` | delegation rate, turn latencies, tool mix, poll count — the numbers §4.3 and Q9 use | — |
| S11 | **GROVE-LANES-SPEC** *(Q8)* | opus | `docs/spec-grove-lanes.md`: authors + session classes, the grove door + refusal codes, envelope v1, trust tiers T0–T3, the loop guard, the A2A mapping table (§8.3–8.6); sim-spec stubs `grove.*` in `lab/ygg-sim` (two local yggdrasil instances) | the spec has a done-check per §8.7 row; the `grove.*` stubs run and fail for the right reason (lane not built); S7's brief cites it | S4 |
| S12 | **APK-SIM** *(Q9)* | opus | `pwa/android`: a release signing key (outside git, backed up), `versionCode` from the release label, built from trunk. `lab/ygg-sim` `app.*`: 5 → 11 scenarios (§9.1: install-download, the QR leg, token-lifecycle, voice-roundtrip on a PipeWire virtual mic, update-over, pwa-rollback). An AVD image matching the S22's Android | every scenario runs on the APK's own sha, recorded in the cycle snapshot. The shell-only flows PASS; the v0.8 pieces (FGS, native client, Keystore) are RED for the right reason. The device column is a named SKIP until your item 9 | S4 |
| S13 | **SIM-REVIVAL** *(Q9)* | sonnet + opus judge | `lab/ygg-sim`: <ul><li>cycle 8 paired to trunk (app 0.7.0-x; yggdrasil + bridge by hash);</li><li>`INCIDENTS.md` gains the v0.7 incidents (F10 phantom/dup, the v0.6 brain outage, T5, T6, onset, the version string);</li><li>an `agent.*` family puts the LiveKit voice agent into the world: burst exactly-once, session pin by id, language pin, duplicate-agent drain.</li></ul> | cycle 8 VALID on trunk hashes, or a FAIL that names the uncovered incidents (the law biting). `agent.burst` is RED on the pre-fix agent and GREEN on S1's T2 fix | the register: now; cycle 8: S2 |
| S14 | **METRICS-LEDGER** *(Q9)* | sonnet | `scripts/metrics.py` (append / backfill / report / month). `docs/metrics/` (the schema, `waves/*.jsonl`, `index.jsonl`). Adapters: Playwright JSON, ygg-sim cycle JSON, `.agi-log`, a nightly `voice.turn` digest. The uptime probe unit (enabled on your item 10). The §9.4 backfill | the backfilled table regenerates from the JSONL alone; the next wave report opens with the generated six-row block; `artifacts/metrics-2026-10.svg` exists | S4 |
| S15 | **VOICE-BENCH** *(Q10)* | sonnet + opus verdict only on a beat | `~/Work/voice-lab`: <ul><li>its first commit (results history from disk);</li><li>corpus v1 + `MANIFEST.sha256` (EN, FR ≥ 10 real speakers, VOCAB, ONSET, PHONE);</li><li>`lab/bench.py` + engine plugins: mac-qwen3, speaches-whisper, parakeet-redux, parakeet-v3-int8, granite-5.0 via llama.cpp;</li><li>the nightly incumbent mode, which reads the release env;</li><li>`lab/radar.py` → `watch/candidates.jsonl`;</li><li>ledger lines in S14's schema;</li><li>3 schedule-entry specs, each `enabled_by: user`.</li></ul> | <ul><li>`bench --corpus v1` reproduces the 10-04 duel: RTF within ±10 %, the same WER on the same chunks (the old JSON is the referee);</li><li>Granite 5.0 gets a dated verdict row, EN + FR;</li><li>the radar, back-tested over 10-01 → 10-27, lists Granite 5.0 and Parakeet Redux;</li><li>`voice-*.jsonl` lines exist.</li></ul> | S4 |
| S16 | **PHONE-STT-SPIKE** *(Q10)* | opus | <ul><li>`pwa/android`: a lab-flavour bench activity + the sherpa-onnx AAR, no product UI;</li><li>`docs/spec-phone-stt.md`: the transcript envelope, the law, the visible fallback;</li><li>`lab/ygg-sim` `voice.rs`: `voice.text-only-trunk`, `voice.stt-phone`, `voice.fallback-visible`, `voice.pack-update`, `voice.offline-queue`;</li><li>adb device engines for S15's bench.</li></ul> | <ul><li>**AVD:** the 5 scenarios run on the APK's sha, PASS or RED for the right reason.</li><li>**S22:** the §10.2 budget table filled for ≥ 3 candidates + the Android recognizer baseline (a named SKIP until item 9).</li><li>A pick per language, EN and FR.</li></ul> | S12 slice 1 + S15 corpus v1 |
| S17 | **LABS-REGISTRY** *(Q10)* | sonnet | <ul><li>`docs/labs.md`: the §10.4 rows, plus a wake trigger and an owner each;</li><li>`where.sh labs`;</li><li>worldtree's nightly "published" marker moves off the trunk, to its run ledger or a `robots/worldtree` ref;</li><li>its run-health line goes into S14's ledger;</li><li>the stale ygg-sim "loop running" claim is closed.</li></ul> | <ul><li>`where.sh labs` answers "which labs run, where, since when" in one call;</li><li>a nightly run leaves no trunk commit and writes one ledger line.</li></ul> | S4, S5 |

*(Q8)* Two rows grow; their cells above are left as written:
- **S4:** completion letters use envelope v1 (§8.6) from the first letter.
- **S7:** adds the `author` field, notices (never a run), the user-lane token on `POST /session/{id}/message`, and `inbox` through the tool channel (§8.7, the v0.7.1 row). Its done-check gains the four v0.7.1 specs.

*(Q9)* Four rows grow; their cells above are left as written:
- **S1:**
  - **T14**: manifest icons 192/512 + maskable. Done when `beforeinstallprompt` fires on the AVD.
  - `.apk` joins `ARTIFACT_TYPES`, so an APK can reach the phone through the chat.
  - **one `voice.turn` diag line per turn**: `{source, run_id, release→transcript, release→first_audio, dup}`. T2's accounting and the latency metric are the same event.
- **S3:**
  - lk-verify writes Playwright JSON (the fail count, the names, the build hash) to a known path;
  - `gate.py --quick` (read-only, ≤ 5 s) for the uptime probe.
- **S10:** its numbers land as backfill lines in S14's ledger.
- **T11 (§2.3):** adds `ygg-sim --only rest.` on rc1's yggdrasil binary, so the root's 9 plumbing scenarios attach to rc1 (Rule 10-08.5).

*(Q10)* Four rows grow; their cells above are left as written:
- **S8:** three voice entries in the schedule file (radar daily, bench nightly, re-eval on trigger). S15 writes the job specs; S8 owns the file.
- **S13:** `voice.rs` goes to S16. S13 keeps `agent.rs` + `sources.rs`. The register gains "10-22: a lab lane died mid-build with no notice" and "10-19: an STT model/env mismatch reached the user".
- **S14:** the voice adapter (bench JSON → ledger) and the voice block in the monthly chart: incumbent vs frontier, per role.
- **S1:** T3's pre-roll spec is reused later as `voice.stt-phone`'s onset case.

Every lane:
- launches through `agi-run.sh` under `systemd-run`;
- claims its files in `docs/claims.md` first;
- commits per slice;
- writes its report to `docs/reviews/`;
- never touches live (STABLE 4/5).

Q8 and Q9 append below and may add rows, e.g. an APK sim spec or a metrics ledger.

---

## 8. Q8 — the third lane: root-to-root without touching your conversation

**The problem (yours, refined).** MAIN will have to reach other roots and other systems. Today no tool does that. A direct call would overlay your conversation, because a session knows only two voices: you speaking, the agent answering. MAIN is for you only. Talk between roots, or between a root and another system's agent, belongs in separate sessions with their own identity.

### 8.0 The answer, short
1. **A third author, and a third session class.**
   - Every stored message names its author: `user`, `agent`, `harness` or `peer:<tree>/<session>`.
   - Sessions come in three lanes: the **user lane** (MAIN + your topics), the **work lane** (subs, §4) and the **machine lane** (`⇄` sessions, one per peer thread).
   - A `user` message can only enter through your own client. MAIN never holds a `peer` message.
2. **Letters, not calls.** Roots talk in letters (the §3 envelope, extended). A letter goes to a tree's door, never to a session, and `<tree>/main` can't be addressed. The receiving root opens or resumes the machine-lane session for that thread.
3. **Authority never travels with a message.** A peer letter says who sent it and which of your turns caused it. It never carries your permissions. A machine lane gets read-only access, artifacts, and the verbs you enabled for that peer.
4. **The transport:**
   - letters on files today, on the bridge at v0.8, found through the grove at v1.0;
   - the queued-turns relay is the engine on the receiving side;
   - herdr-style prompting is rejected.
5. **Identity lands before the wire.**
   - **v0.7.1** (with S7): the author field, notices and the user-lane token. The overlay already happens on one box.
   - **v0.7.x:** machine lanes between two local roots, in the sim.
   - **v0.8:** letters over the bridge.
   - **v1.0:** the grove directory + entry-root routing.

### 8.1 Evidence: the overlay already happens on one box
- **The store can't tell you from a machine.**
  - yggdrasil stores two roles. `upstream_history` (`lab/yggdrasil/src/main.rs:562`) replays everything that is not `assistant` as `user`.
  - `POST /session/{id}/message` checks nothing: any caller on loopback is stored as `role: user`. The only bearer in `main.rs` is the one sent to the upstream.
- **17 of the 27 sessions on the root (:4100) hold only machine-written `user` turns:**
  - the coordinator's briefs (`[REVIEW] rules-distribution`, the coordination design review);
  - the gate missions (`v07 gate waves`: "MISSION —", "WAVE CONTINUATION");
  - e2e probes ("Reply with exactly: …");
  - sim replays (`voice-live-cycle`).
  
  The other 10 are empty or mixed: your turns, voice tests, and STT noise stored as speech (`test-audi`: "得得得得得。"). The store can't say which is which.
- **W1 and W5 were this overlay.** The coordinator "talked" to a root by typing as you into its sessions. F10 is the mirror image: runs in MAIN with no stored user turn.
- **The relay as designed would add one more source.** Design §3 turns a sub's terminal event into "a queued turn for the main". On today's store that turn is `role: user`, so MAIN would hear a machine speak in your voice.

So Q8 is not only a v1.0 question. The identity half is needed on one box now; only the wire waits for the bridge.

### 8.2 Survey: how others keep the human lane apart from the agent lane

| system | who is speaking | addressing | trust (what a foreign agent may ask) | does the human see the machine talk? |
|---|---|---|---|---|
| **A2A 1.0** (Linux Foundation; v1.0.0 is the latest release) | two roles: `user` (the calling client, which may itself be an agent) and `agent`. The human is not a party to the protocol | an Agent Card at `/.well-known/agent-card.json` (skills, auth schemes, bindings); `contextId` groups one conversation, `taskId` one unit of work, `referenceTaskIds` link them | the client authenticates with the schemes on the card. Agents are **opaque**: they collaborate "without needing access to each other's internal state, memory, or tools". The `input-required` and `auth-required` states hand a decision back to the caller | no: the exchange is its own context, and the client decides what its human sees |
| **MCP** (2025-11-25) | **roles are separate from transport.** Host (the app the human uses) · client · server, over stdio or HTTP | the host configures its servers; no discovery | the host owns consent. A server's sampling or elicitation request goes *through the host*, with a human able to deny it. Tasks (experimental) make long requests async | server traffic never enters the chat as the user; an elicitation is shown as the server asking |
| **OpenAI Agents SDK** (Swarm's successor) | one conversation; the active agent changes | `handoff()` to a named agent | the tool list only | **yes, by design:** a handoff gives the *human's* conversation away. `input_filter` and the nested history trim what the next agent sees |
| **AutoGen core** | `AgentId` = type + key | direct messages + pub/sub topics | none built in | GroupChat: everyone sees everything |
| **CrewAI** | role-named coworkers | the "delegate work / ask question to coworker" tools | none built in | the coworker's answer returns as the manager's **tool result**, never as a user turn |
| **Letta** | per-agent ids; the receiver is told the `sender_agent_id` | `send_message_to_agent_async` by id, with a delivered receipt | none built in; shared memory blocks | separate histories |
| **Claude Code** (subagents, agent teams) | separate sessions; `SendMessage` between them | by name inside a team; a mailbox + a shared task list on disk | **2.1.166:** "messages relayed via `SendMessage` from other Claude sessions no longer carry user authority — receivers refuse relayed permission requests, and auto mode blocks them" | the lead gets a summary; teammate traffic stays in their sessions |
| **herdr** | nobody: `agent.prompt` submits text + Enter into the pane, exactly as if you typed it | the pane id; `agent.wait` pins the pane's occupant | none: a control layer, not a messaging layer | the human watches the panes |
| **our delegate skill** | the CLI's output file; "say who did what" | a file path | read-only by default; never push, deploy or commit without the user in *this* conversation; no secrets | a summary in the transcript, the file for details |

**What the field agrees on:**
1. **The human lane belongs to the host, not to the protocol.** A2A, MCP, Claude Code and CrewAI keep the agent exchange in its own context; the human sees what the host chooses to show. Only two put the machine inside the human's conversation:
   - handoffs, on purpose, to *give the human away*;
   - herdr, because it drives terminals it doesn't own (herdr AVOID #1–2).
2. **Identity is stamped per message, and the speaker is "the user" only if it really is the user.** A2A names the role, Letta the sender id, Claude Code the relay. Claude Code's 2026 hardening is the exact lesson: the hole was a peer's message carrying the user's authority, the confused deputy.
3. **Addressing = a card + a context.** The **card** says what a root can do, the **context** pins one conversation, and a **task** is one unit of work. Our letters already hold most of this (Q3).
4. **Results from a peer come back as artifacts or through the tool channel, never as a user turn** (CrewAI, Claude Code subagents, MCP). LLM APIs have only `user`, `assistant` and `tool`. The tool channel is the one input every provider already treats as data rather than as the human.
5. **Async means durable state.** A2A tasks + push, MCP tasks, Letta receipts and Claude Code mailboxes are all store-and-forward with an id, never a held call.

### 8.3 Proposal (1): the identity model, three lanes

**Authors.** One field on every stored message. The harness sets it from the *door* a message came through, never from its text.

| author | enters through | may start a run in |
|---|---|---|
| `user` | the user-lane door only: the PWA proxy and the voice agent, which hold the user-lane token (`YGG_USER_TOKEN`) | its own session |
| `agent` | this root's own run loop | — |
| `harness` | deterministic code: notices, receipts, roll-ups, sim probes | **nothing.** A notice is shown and kept for reading; nothing answers it by itself |
| `peer:<tree>/<session>` | the grove door (letters), pinned to the sender's key | only the machine-lane session of its thread |

**Session classes.**

| lane | for whom | examples | in the deck | tools |
|---|---|---|---|---|
| **user lane** | you | MAIN (`<tree>/main`, reserved), `[WEBSITE]`, `[LAB] voice` | the list | MAIN: the §4.2 diet; topics: all |
| **work lane** | you, through a brief | subs from `spawn` (depth 1), `agi-run` lanes | under their parent | by role (§4.4) |
| **machine lane** `⇄` | a peer root or a foreign agent | `tv/⇄desk-7f3a` (desk asked tv to play a file) | a **grove** drawer, closed by default; read-only for you | the peer's verbs only (§8.5) |

**Pins.**
- **User lane:** the session **id**, never the title (T7), plus the owner's device tokens. The voice room identity becomes per device (STABLE's known bug: `user_<slug>` is fixed per room).
- **Work lane:** the parent id + incarnation (herdr §1.4).
- **Machine lane:** (peer key, thread id). A letter from desk can never land in a thread tv holds with the Mac, and a replaced peer can't answer an old thread.

**Your transcript:**
- **Always:**
  - your turns;
  - the replies;
  - MAIN's own tool calls, collapsed;
  - **notices**, one line each: `⇄ desk · result · night level drafted · open`.
- **Never:**
  - a peer's text as a turn;
  - the back-and-forth inside a machine lane;
  - a harness line in the `user` role.
- **When you summon it:**
  - tap a notice → the machine-lane session opens read-only, as its own page, and MAIN stays as it was;
  - or ask "what did desk say?" → MAIN calls `inbox`. The letter enters its context as a **tool result** and the reply is attributed ("desk says: …").

**One rule for MAIN's brain: no run without a `user` turn as its cause.**
- A notice never wakes MAIN. This amends design §3 ("events → queued turns for the main"): the relay posts a **notice** plus a push, and the brain reads it on your next turn.
- In hands-free the harness may *speak* the notice itself: the template through TTS, no LLM. You hear "desk finished: night level" and MAIN never runs.

### 8.4 Proposal (2): addressing, through the grove door
- **You address a tree, not a session.** A letter's `to` is a tree (`studio`, `tv`), plus a thread on replies. The receiving root's **grove door** is a harness endpoint, not a session:
  - a new thread opens `⇄<peer>-<thread>`;
  - a known thread resumes its own session.
- **`<tree>/main` and every user-lane slug are closed to peers.** The door answers with a typed refusal (`user_lane`), the way herdr answers `agent_blocked`.
- **Names come from Parts 13 and 16:**
  - `tree/slug` = a session's id across the grove (the v0.8 namespacing already planned for rooms, tokens and ids);
  - `tree` = the root's stable name;
  - the **peer key** is the identity. bifrost-net already makes one per install ("give this to peers"). Names are only for display.
- **The tree card** (A2A's Agent Card, at our size) lives at `GET /api/v1/grove/card`. It holds:
  - the name, the key and the version;
  - which verbs the root offers, and to whom;
  - whether it is awake.
  
  The card is generated from config, never written as prose.
- **Finding a root, by version:**
  - **v0.7.x (one box):** two local roots know each other from a static `grove.toml` (tree, key, door path).
  - **v0.8 (the bridge):** `grove.toml` entries are written at **introduction**.
    - Your phone already holds both trees' tokens (spec-bridges), so *you* introduce desk to tv from the phone.
    - Roots never find and trust each other on their own. Each tree stays sovereign behind its own token (Part 9).
  - **v1.0 (the grove):** the trunk's directory (Part 16, move 2) answers *who is home*: which cards, which sessions.
    - It is presence, not trust. An unknown key in the directory has no rights until you introduce it.

### 8.5 Proposal (3): the trust boundary

**The law, in one line: authority never travels with a message.** A letter proves who sent it and which of your turns caused it. It never grants your permissions. Claude Code arrived at the same rule in 2.1.166, after the fact.

| tier | who | may do without you | never |
|---|---|---|---|
| **T0 you** | `user`, through the user-lane door | whatever the session's tool list allows | — |
| **T1 your work** | subs and lanes from a brief you caused | the brief's scope (§4) | promote, deploy, push (STABLE; the delegate skill) |
| **T2 your other trees** | the same owner, introduced by you | <ul><li>**read** its own status and the files it exports;</li><li>**answer with artifacts**: files + ≤ one screen, attributed `{from, model, time, sha}`;</li><li>run **the verbs you enabled** for that peer (`tv: play, stop, volume`; `desk: status, draft`). Each verb is a typed tool, never a shell.</li></ul> | <ul><li>edit, write or bash outside its quarantine (`artifacts/inbox/<peer>/`);</li><li>spawn a build or bash role;</li><li>write into any user-lane session;</li><li>change config, model or keys;</li><li>**ask for permissions** (that becomes a `question` letter → a notice in your MAIN, and you answer there);</li><li>forward to a third root (depth 1 holds across trees too).</li></ul> |
| **T3 foreign agents** | another owner, another system (an A2A agent, a friend's tree) | read-only artifact exchange, only on a thread **you opened** or allowed from a notice ("X wants Y — allow?") | everything T2 can't do, plus verbs |

**Enforced by the harness, not by a prompt (STABLE 8):**
- **The tool list.** A machine lane's tool list is its verb set, enforced by the same per-session registry as S7's diet.
- **The envelope.** Peer text reaches a brain only inside an attributed envelope. An injected "rm -rf" finds no tool to land on.
- **The cause chain.** Every letter carries `cause: <tree>/<user turn id>`. A T2 verb runs only if that cause is a real user turn on a tree you introduced. R4 (§4.3) said this for spawns; now it holds across trees.
- **The loop guard.** A thread holds at most 6 letters, then turns `blocked` and you get a notice. Each peer also has a daily letter and token budget; over budget = `blocked`.
- **No chatter.** The coordination design says "no LLM-to-LLM chatter across roots ever — only artifact exchange with attribution". That still holds, read precisely:
  - a machine lane is a **bounded, typed, attributed thread** (ask → result / blocked / question), not chatter;
  - neither brain ever sees the other's transcript (A2A's opacity).

### 8.6 Proposal (4): the transport

| option | what it is | verdict |
|---|---|---|
| **Letters** (the delegate skill's files, the Mac's Letters, Q3) | a durable, addressed envelope: store-and-forward + an ack | **The meaning layer, at every version.** One schema (below), on files, over the bridge, and behind any later A2A adapter |
| **The queued-turns relay** (gate item 8, the dispatcher) | runs a turn without a client | **The engine on the receiving side.** <ul><li>A letter at the door becomes a queued turn in the **machine-lane** session, author `peer:…`. Never in MAIN.</li><li>At the API, the letter is that session's `user` role, its only counterpart, wrapped in one harness line: "letter from `desk` (a peer, not your user); your tools are its verbs".</li></ul> |
| **The bridge** (bifrost-net, v0.8) | an authenticated, keyed wire between boxes | **The wire between boxes.** <ul><li>`POST /api/v1/peer/letter`, signed with the sender's key.</li><li>The outbox retries until it gets an ack.</li><li>An asleep tv means the letter waits and its chip goes grey (spec-bridges). Never a hang.</li></ul> |
| herdr-style prompt (`agent.prompt` + wait) | typing into another agent's session | **Rejected as the primitive.** It is the overlay itself: no author, and your authority by default. Two ideas survive: **atomic send + ack**, and the **pinned wait** |
| A2A | the open standard | **A later adapter, on evidence** (the connectors precedent). It maps 1:1: <ul><li>letter ≈ Message;</li><li>thread ≈ `contextId`;</li><li>`result` ≈ completed, `blocked` ≈ failed/rejected, `question` ≈ input-required;</li><li>tree card ≈ Agent Card.</li></ul> The mapping table goes into the spec, not into code |

**Envelope v1** is a superset of §3's letter, so there is still one schema:

```
{ v: 1, id, thread,                    // thread = "<origin tree>/<first letter id>" (≈ A2A contextId)
  from: "<tree>/<session>", to: "<tree>" | "<tree>/<session>",   // never "<tree>/main" on a peer letter
  author: user | agent | harness | peer, cause: "<tree>/<user turn id>",
  kind: ask | result | blocked | question | note,
  body,                                // ≤ one screen
  artifacts: [{path, sha256, bytes}],
  model, time, sig? }                  // sig = the sender's key; required once the letter crosses the bridge
```

On one box (S4's completion letters, the v0.7.1 inbox), the same file lands in `artifacts/letters/` without `sig`. **S4 writes this schema from its first letter**, so §3's "one schema, never two" holds.

### 8.7 Proposal (5): landing

| version | what lands | why there | done-check |
|---|---|---|---|
| **now, no code** | two lines join the coordinator law (§1.4), with your go: <ul><li>"authority never travels with a message";</li><li>"no session writes `user` turns into another session".</li></ul> Briefs go through `agi-run`, never as REST turns into a session | W1/W5; the 17 machine-only sessions | a week of coordinator logs with zero REST turns |
| **v0.7.0** | nothing | the gate is frozen; one structural change per version | — |
| **v0.7.1** (with S7, `YGG_CONCIERGE=1`) | <ul><li>the `author` field;</li><li>**notices**: stored, shown, pushed, never a run;</li><li>the user-lane token on `POST /session/{id}/message`;</li><li>`inbox` reads letters into the **tool channel**;</li><li>no run in MAIN without a user cause.</li></ul> | identity is a one-box problem today, and S7 already rebuilds MAIN's tool registry and inbox | specs: <ul><li>a POST without the token is refused;</li><li>a letter yields one notice and **zero runs** in MAIN;</li><li>`inbox` reaches the brain as a tool result;</li><li>e2e and sim probes are stored as `author: harness`.</li></ul> |
| **v0.7.x** (with `YGG_SUBSESSIONS=1`) | <ul><li>the machine-lane class;</li><li>the grove door on files;</li><li>T2 verbs as typed tools;</li><li>the loop guard;</li><li>two **local** roots in the sim (two yggdrasil instances, two stores, two loopback ports) exchanging letters.</li></ul> | proves the lane with no second box and no bridge (Rule 10-09: only simulation is proof) | sim `grove.*` green: <ul><li>a peer can't address `main`;</li><li>relayed permission requests are refused;</li><li>a 7th letter → `blocked`;</li><li>an asleep peer → the letter waits, then is delivered exactly once;</li><li>an injected command finds no tool.</li></ul> |
| **v0.8** (the bridge) | <ul><li>signed letters over bifrost-net;</li><li>`tree/slug` everywhere (already a v0.8 line);</li><li>introduction from the phone writes `grove.toml`;</li><li>the grove drawer in the deck;</li><li>pushes for `question` and `blocked`.</li></ul> | the wire exists only from here | box ↔ Mac Studio: <ul><li>a letter goes both ways with tailscale off;</li><li>revoking the peer kills the thread on its next letter;</li><li>`bridge.*` sim green.</li></ul> |
| **v1.0** (the grove) | <ul><li>the trunk directory (presence + cards);</li><li>entry-root routing: "put it on the tv" → MAIN sends an `ask` to `tv`;</li><li>TV verbs auto-allowed per peer.</li></ul> | Part 17: the inflection test *is* this | "put it on the tv" plays on the tv. MAIN's transcript shows your line, the reply and one notice. Nothing else |
| **after v1.0, on evidence** | an A2A adapter for foreign agents (T3) | no customer yet | — |

**The laws, checked.**
- **Light prompt ✓.** No new prose in any prompt. MAIN gains one tool line (`inbox`). A machine lane gets one harness line per letter. The rest is registry, store fields and doors.
- **STABLE ✓:**
  - **4:** no session writes into another.
  - **5:** the peer door listens beyond loopback only on the bridge, gated by key and token.
  - **6:** each root's machine lanes live in its own store.
  - **7:** peer verbs are autonomy, so each one is `enabled_by: user`, per peer.
  - **8:** the harness enforces all of it.
- **No-pay-raw-API ✓.** A machine lane runs on the receiving root's brain, under its owner's plan, with per-peer budgets. There is no new spend path.
- **The user lane stays sacred ✓.** Only a `user` author starts a run there. Whatever a machine says reaches you as a notice you can open, or as a tool result MAIN reads when you ask.

**Risks.**
- **R8 — notices pile up unread.** Bound:
  - a push for `result` and `blocked`;
  - an unread count on the grove chip;
  - Q9's metrics count the read-through.
- **R9 — the token leaks into a lab script, and the overlay quietly returns.** Bound:
  - the token lives only in the PWA's and the agent's release env (0400);
  - `gate.py` gets one check: no other unit's env holds it.
- **R10 — two brains in one thread agree on something wrong.** Bound:
  - the thread cap;
  - artifacts carry a sha;
  - only you turn a result into an action beyond the verbs.
- **R11 — tests need to write `user` turns.** Bound:
  - they go through the proxy like the phone, as the PWA specs already do;
  - sim probes are stored as `author: harness`, never as you.

### 8.8 Plan + spawn-list delta (folded into §7)
- **New: S11 GROVE-LANES-SPEC** (opus).
  - It writes `docs/spec-grove-lanes.md` + sim-spec stubs that are RED by design.
  - It fixes the store field, the door's refusal codes, the tiers and the A2A table before S7 builds on them.
  - It runs after S4, in parallel with S1.
- **S7 grows:** the author field, notices, the user token, `inbox` through the tool channel (the v0.7.1 row above). Same flag, same slot.
- **S4 grows:** completion letters on envelope v1 (§8.6) from the start.
- **v0.8 plan line**, written when §6 step 11 opens the v0.8 plan: *grove letters over the bridge* (the v0.8 row above). Not a spawn now.
- **One more word from you:** the coordinator-law extension (§8.7, "now"). It joins your decision list next to item 5.

---

## 9. Q9 — the APK, the coverage map, the metrics

**Your four questions (refined):**
1. Is the APK ready to download and install? Was it fully simulated?
2. Per version (v0.7, v0.8, v0.9, v1.0): what is not tested or simulated yet, and what should be before it ships?
3. Is the system simulated? The honest coverage map.
4. Do the developments improve over time, and do we have the quality and performance metrics to see the direction?

**Evidence read** (read-only, 10-27):
- `pwa/android/` (the shell, its README, the built APK on disk);
- `lab/ygg-sim/` (`report/cycles/cycle-1..7.json`, `matrix.md`, `VERSIONS.md`, `INCIDENTS.md`);
- `docs/android-lab.md`, `docs/STABLE.md` (the ladder), `docs/plan.md`, `docs/reviews/{native-app-eval,sim-gap-v07,v07-gate-final}.md`, the playbook rules 10-08..10-10;
- `docs/urd/tests.md`, `lab/yggdrasil/LIFE.md`, `.agi-log/log.tsv`, `artifacts/agi-loop-metrics.json`;
- `docs/environments.md` (lk-verify's daily rows) and its journal;
- the sandbox diag `bifrost-sandbox/pwa/.diag/diag-2026-10-2*.log` (250,659 lines);
- the manifest and the artifact route, as served on :8090.

### 9.0 The answers, short
1. **The APK: not ready, and not fully simulated.** One correction to the brief: it is not "nothing built, nothing simulated".
   - **What exists:** a 21 KB **debug-signed lab shell** (`pwa/android`). It was built once, 10-06 22:32, and never since.
   - **What was simulated:** 5 emulator scenarios on 10-06/07, against the live v0.6 app. 3 PASS: install + pair, hot-reload, mic by origin. 2 BREAK-OK: no push when closed, and the mic goes silent at screen-off.
   - **What was never run:** your S22, a voice round-trip through the APK, the update path, the token lifecycle through the app, and the v0.7 sandbox build inside it.
   - **It can't even reach you:** `.apk` is not in the artifact route's type map, so `/api/artifact/*.apk` answers 404.
   - **The plain PWA install is still blocked by the icon.** Trunk and the sandbox both ship only the 16/32 px favicon, and Chrome wants ≥ 192 px. This was found 10-03 and is still open.
   - **By plan, the APK is v0.8.** §9.1 specs its simulation.
2. **Per version** (§9.2):
   - **v0.7** needs §2.3's T1–T13, plus four sim additions: the root's 9 plumbing scenarios on rc1's binary, the voice burst as a re-runnable sim, the 4 uncovered incidents, and a measured voice latency.
   - **v0.8** needs the whole app column and the bridge on trunk with its two KNOWN issues fixed.
   - **v0.9** needs a clean-box install, HTTPS without tailscale, and the iPhone class.
   - **v1.0** needs the grove, which has nothing yet.
3. **Is the system simulated? The plumbing is; the product is not** (§9.3).
   - Estimates: root ≈ 65 %, agent ≈ 30 %, PWA ≈ 55 %, trunk ≈ 25 %, bridge ≈ 45 %, app ≈ 20 %, grove 0 %. That is ≈ 44 % of what v0.7 ships, and ≈ 34 % of the road to v1.0.
   - On the shipping artifact, on the shipping device class (Rule 10-08.5), **no subsystem is above ≈ 30 %**.
   - ygg-sim has not run since **10-07** (20 days), and it ran against app 0.6.0.
4. **Are we improving? We can see it for sim coverage. We can't for quality or performance** (§9.4).
   - **Sim coverage:** 17 → 30 scenarios in 3 days with 0 FAIL held, then the loop stopped.
   - **The sandbox e2e:** 35 → 57 passing.
   - **The daily verify:** green on 09-24 (10/10), then RED four days running (10-23..26). It doesn't record how many specs failed, or which.
   - **Voice latency in the sim:** flat at 17–20 s per turn for six cycles. The 8 s target was never met.
   - **Voice latency on the real chain:** measured once, n = 3, on 10-04.
   - **Uptime:** measured nowhere. The 4-day v0.6 outage was found by you.
   - **The fix:** a metrics ledger, one JSONL per wave, with six fixed metrics and a generated trend (S14).

### 9.1 Q9.1 — the APK

**The facts.**

| fact | evidence |
|---|---|
| **Scope: v0.8.** The first client of the bridge | STABLE ladder, the v0.8 row "bridge + app"; native-app-eval Rung A (sideload, owner-only) |
| **The thin-client plan.** <ul><li>The APK has no UI of its own: a WebView around the same PWA.</li><li>It adds only what a browser can't do: the pairing deep link, the mic held natively, native notices.</li><li>v0.8 adds two native pieces behind the same UI:<ul><li>a **microphone foreground service**;</li><li>the **bifrost-net client** inside that service (`cargo-ndk` + uniffi), with the token in the Android Keystore.</li></ul></li></ul> | `pwa/android/README.md`, "Design note"; STABLE v0.8 row |
| **What is built.** <ul><li>A hand build, no Gradle: aapt2 → javac → d8 → zipalign → apksigner.</li><li>`app-debug.apk`: 21,062 bytes, **debug-signed**, built 10-06 22:32 from `9d650da`.</li><li>Never rebuilt: not from trunk, and not against the v0.7 sandbox.</li></ul> | the file on disk; `git log -- pwa/android` (one commit) |
| **What was simulated.** ygg-sim cycles 6–7 (10-06/07), Android 16 AVD, WebView 133, against **app 0.6.0** (live) and the lab bridge: <ul><li>`app.install-pair`: PASS, pair-verify 2.4 s;</li><li>`app.hot-reload`: PASS, 2.8 s;</li><li>`app.chrome-mic-origin`: PASS;</li><li>`app.push-notification`: **BREAK-OK** (WebView has no Web Push);</li><li>`app.background-audio`: **BREAK-OK** (silenced at screen-off while the page sees a live track).</li></ul> | `lab/ygg-sim/report/matrix.md`; cycle-7.json |
| **What was never run.** <ul><li>Any real phone.</li><li>A voice round-trip through the APK. The emulator voice loop was BLOCKED on 10-06, and the 10-03 Mac AVD had no input device.</li><li>The update path.</li><li>Token expiry, revoke and re-pair through the app. Revoke is proven only inside bifrost-net's own test.</li><li>Release signing.</li><li>The sandbox tree-first build inside the shell, beyond "renders the tree door".</li></ul> | sim-gap-v07 §2; android-lab "Stretch"; `lab/bifrost-net/src/bridge.rs:840` |
| **The manifest icon prerequisite.** <ul><li>`manifest.json` on trunk **and** as served on :8090 lists one icon: `/favicon.ico 16x16 32x32`.</li><li>Chrome needs ≥ 192 px for installability, so `beforeinstallprompt` never fires.</li><li>The shell itself doesn't need it (it has its own launcher drawable). But the PWA install is the APK's fallback and a plan.md human check.</li></ul> | android-lab finding 1 (10-03); `curl :8090/manifest.json` today |
| **The download path.** <ul><li>`ARTIFACT_TYPES` (`bifrost-sandbox/pwa/lib/artifacts.ts`) has no `.apk`.</li><li>`resolveArtifact` returns null, so the link 404s.</li><li>Today an APK can't reach your phone through the chat.</li></ul> | the route code |

**Ready to download and install? No, for three reasons:**
- **It's v0.8 scope, and v0.8's bridge isn't on trunk.** `bifrost-bridge` still runs from `~/Work/lane2-merge`.
- **The shell fails two v0.8 gate lines by design:**
  - screen-off voice (the BREAK-OK at screen-off);
  - notices while closed (no push).
  
  The two native pieces that fix them aren't built.
- **No green exists on the shipping binary, on the shipping device class** (Rule 10-08.5). The lab APK is debug-signed, built against v0.6, and was never on a phone.

Sideloading it today would give you a WebView of the PWA, paired to a lab bridge. That is less than Chrome gives you now.

**The APK simulation spec.** Each flow runs on the APK's own hash, built from trunk and release-signed, on the AVD on this box. The "S22" column is what an emulator can't prove.

| flow | what the sim does (AVD, this box) | scenario | today | needs the S22 |
|---|---|---|---|---|
| **download + install** | Chrome on the AVD opens `/api/artifact/bifrost-<v>.apk` from the next slot. UiAutomator grants "install unknown apps". `pm` asserts the package, `versionCode` = the release label, and signer = the release key | `app.install-download` *(new)* | ❌ `.apk` 404s; the APK is debug-signed | One UI's sideload gates (Auto Blocker if on, the Play Protect scan) |
| **pair** | The sim decodes the QR the box renders and asserts it equals the deep link. Then: deep link → native verify (`POST {bridge}/offer`, Bearer) → token handed over. A wrong token gets 401; a re-pair replaces the old one | `app.install-pair` *(exists, PASS)* + a QR leg | 🟡 deep link via `adb am start` only | **the S22's camera opening the QR's scheme.** If it won't open `bifrost://`, pairing is dead. The fallback is a QR holding an https link whose page hands over |
| **token lifecycle** | Issue → use → revoke on the box → the next request reads 401 → the app shows re-pair, never a hang → re-pair. The token survives an update and is gone after uninstall. At v0.8 it never appears in WebView storage (a CDP dump over adb) | `app.token-lifecycle` *(new)* | 🟡 revoke proven in bifrost-net's unit test (401 within the 1 s store refresh), never through the app | the StrongBox-backed Keystore |
| **voice round-trip** | The audio chain: <ol><li>a real-speech wav → a **PipeWire virtual source** on this box → the AVD's host-audio mic;</li><li>→ the page (today) or the FGS's `AudioRecord` (v0.8);</li><li>→ agent or bridge STT → the brain (the mock, plus one real run) → TTS;</li><li>→ the AVD's audio out → a virtual sink → the STT∘TTS keyword gate.</li></ol> Timings: press → transcript, release → first audio. "Bifrost" is said **at the press** (T3's class) | `app.voice-roundtrip` *(new)* | ❌ never run on any emulator | the real mic, AEC/NS, speaker-to-mic echo in a room, Bluetooth routing, the mic privacy toggle |
| **screen-off** | 20 s of screen-off in mid hands-free. `RecordActivityMonitor` reads `silenced:false`, and a turn completes in the dark | `app.background-audio` *(BREAK-OK → PASS with the FGS)* | 🟡 breaks as documented | One UI battery (Doze, app standby, "sleeping apps") on a mic FGS over hours |
| **notices** | Today: the native notify posts. v0.8: `run.done` arrives over the service's channel with the screen off | `app.push-notification` → `app.bridge-native` *(README's planned scenario)* | 🟡 | delivery under One UI rules over hours |
| **update** | Install N and pair, then install N+1 over it (`adb install -r`, same key). Pairing and the deep link survive. When the box rolls the PWA back one release, the shell still works or says "update the app" (a shell↔PWA contract version check). It never breaks silently. Android refuses a lower `versionCode`, so **app rollback = PWA rollback** | `app.update-over`, `app.pwa-rollback` *(new)*; `app.hot-reload` *(exists, PASS)* | 🟡 bundle reload only | the install-over prompt (cosmetic) |

**Rules for the spec:**
- **The signing key is a trunk asset.** It is stored outside git, backed up like the root's store (T13), and never regenerated: a lost key means no update path, ever.
- **The device column runs once, as a probe.** The same scenario binary runs with `--device s22` over **wireless debugging**: a one-time pairing of your phone to the box, then AGI runs it. This doesn't put the testing on you (Rule 10-10): you grant access once, as with the Mac. Until then those cells are named SKIPs in the release notes.
- **The AVD image** must match the S22's Android version as well as Android 16, so a green carries a device class, not just "an emulator".

### 9.2 Q9.2 — the coverage map

**The subsystems:**
- **root** = yggdrasil: sessions, runs, tools, the store.
- **agent** = the LiveKit voice worker (STT → root → TTS).
- **PWA** = the phone client + the Next proxy.
- **trunk** = the release spine: `gate.py`, `promote.sh`, the units, the store backup, lk-verify.
- **bridge** = bifrost-net + device tokens.
- **app** = the APK.
- **grove** = tree-to-tree (letters, directory).

**Legend:**
- ✅ = a repeatable referee ran green on a v0.7-period build (≥ 10-19);
- 🟡 = a referee exists, but it is stale, ran on another artifact, or covers only part;
- ❌ = no referee;
- — = not in that version.

|  | root | agent | PWA | trunk | bridge | app | grove |
|---|---|---|---|---|---|---|---|
| **v0.7** | 🟡 | 🟡 | 🟡 | ❌ | — | — | — |
| **v0.8** | ❌ | ❌ | 🟡 | ❌ | 🟡 | 🟡 | ❌ |
| **v0.9** | ❌ | 🟡 | ❌ | ❌ | 🟡 | ❌ | — |
| **v1.0** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

No ✅ cell: under Rule 10-08.5, nothing green today attaches to an artifact that will ship, because rc1 doesn't exist yet (T11).

Priority: **P0** = blocks the version; **P1** = before the version's week of daily use; **P2** = may ship as a named SKIP.

**v0.7 (the tree)** — §2.3's T1–T13, plus:

| subsystem | today | missing sims | P |
|---|---|---|---|
| root | `verify.sh` mock suite, churn 8/8, real-upstream PASS-REAL, herdr triad + pins; ygg-sim `rest.*` 9/9 (10-07 binary) | <ul><li>T2 run accounting;</li><li>T9 model field;</li><li>T13 store backup;</li><li>OG-ctx;</li><li>**ygg-sim `rest.*` on rc1's binary** (added to T11).</li></ul> | P0 |
| agent | voice-wait ×15, the onboarding first voice turn (804 ms), the STT repro (10-19), rekeys 100/100 | <ul><li>**T2 as a re-runnable burst sim** (S13 `agent.*`);</li><li>T3, T4, T5, T7;</li><li>the uncovered incidents **agent-dup** and **tts-stutter** (registered 10-07, never covered);</li><li>**voice latency measured** (release → transcript / first audio, p50/p95).</li></ul> | P0 (T2, T7), P1 (the rest) |
| PWA | general 57/0/2, onboarding 8/8, MAINFRAME-C 12/12, herdr 6/6; desktop Chromium at 360×780 | <ul><li>T1, T6, T8, T10;</li><li>the **chunk-race** incident (a deploy swaps chunks under loaded clients);</li><li>**T14 (new):** manifest icons 192/512 + maskable. Done when `beforeinstallprompt` fires on the AVD.</li></ul> | P0 (T1, T8), P1 (T6, T10, chunk-race), P2 (T14) |
| trunk | the gate exists (RED, `port.4096`); `promote.sh` has never shipped a yggdrasil release | <ul><li>step 0;</li><li>T12 rollback rehearsal;</li><li>`--slot next`;</li><li>lk-verify that names its failures;</li><li>**an uptime probe** (the outage nothing caught);</li><li>the **oc-timeout** class (a > 5 min run through the proxy).</li></ul> | P0 (step 0, T12), P1 (uptime, oc-timeout) |

**v0.8 (bridge + app)** — the STABLE gate: QR pairing; text + voice over the bridge with tailscale off; screen-off voice; revoke kills access; no unauthenticated listener; sim `bridge.*` + `app.*` green.

| subsystem | today | missing sims | P |
|---|---|---|---|
| bridge | 15 `bridge.*` scenarios: 11 PASS, 2 BREAK-OK, 2 KNOWN. On `lane2-merge` as of 10-07, not on trunk | <ul><li>all 15 on **trunk's** bridge binary;</li><li>`bridge.prompt-run-done` and `bridge.tool-loop` KNOWN → PASS (async workers: ping 151 ms → 4.3 s under 2 tool runs);</li><li>`nat-rebind` → PASS (ICE restart: the phone moves between Wi-Fi and cell).</li></ul> | P0 |
| app | 5 `app.*` (3 PASS, 2 BREAK-OK) on the lab shell | §9.1: download, QR, token lifecycle, voice round-trip, screen-off → PASS, update, PWA rollback | P0 |
| trunk | — | <ul><li>the bridge as a release unit in `promote.sh` + `gate.py`;</li><li>**`trunk.listeners`**: every non-loopback listener refuses without a token;</li><li>the APK signing key in the backup.</li></ul> | P0 |
| agent | — | **dual-transport parity:** the same turn over LiveKit + agent and over the bridge gives the same stored turns, exactly once, with both connected. This is the "two clients on one session" known bug | P0 |
| root | — | Q8's v0.7.1 specs (the author field, notices, the user-lane token) and `tree/slug` namespacing | P1 |
| PWA | devices-mode via `v09-ladder.sh`, 8/8 rungs on 10-04 (lane2, old) | the ladder rerun on trunk's PWA + bridge | P1 |
| grove | — | Q8's v0.8 row: signed letters over the bridge, both ways, with tailscale off | P1 |
| — | — | `bridge.bandwidth-starved` → PASS (pacing) | P2 |

**v0.9 (bridge-first, tailscale optional)** — the STABLE gate: valid HTTPS without tailscale; v0.8's gates on a second phone (iPhone); a clean-box install; a week of use.

| subsystem | today | missing sims | P |
|---|---|---|---|
| trunk + root | the 09-26 Vercel container smoke only | **`install.clean-box`**: plant yggdrasil on a fresh VM (Arch + Debian) from the public installer, run the whole matrix there, then uninstall leaves nothing | P0 |
| bridge + PWA | `app.chrome-mic-origin` (secure context on :8443) | **HTTPS without tailscale**: the cert path (ACME staging, or a pinned cert carried in the pairing QR), then the mic secure-context probe on that origin | P0 |
| PWA / app | — | **the iPhone class**: a WebKit project for the Playwright suites (closer than Chromium, still not iOS). The iOS Simulator needs Xcode on the Mac (S9's access). The real iPhone is the named second phone | P0 (WebKit), SKIP (lock-screen mic and iOS background audio until the device) |
| agent | `voice.stt-inprocess` KNOWN: EN parity, FR WER 37 % vs 18 % | French parity, because STT moves into the bridge at v0.9 | P1 |
| all | churn on the LiveKit path | the **accelerated week over the bridge transport** (`stability_suite` phases on the bridge) | P1 |

**v1.0 (the grove, "put it on the tv")**

| subsystem | today | missing sims | P |
|---|---|---|---|
| grove | nothing (S11 writes the stubs, RED by design) | `grove.*` with 2 → 3 local trees: an asleep peer, version skew N / N-1 between trees, the loop guard, injection finds no tool | P0 |
| agent + root + grove | — | **the inflection test as a sim:** "put it on the tv" spoken into tree A → a letter → tree B's `play` verb → a fake media sink plays. A's MAIN shows your line, the reply and one notice | P0 |
| trunk | — | the directory under churn (trees joining and leaving, the directory down); per-tree releases with skew | P1 |
| root | — | the memory layer: per-root wells + the small shared layer, consistent under partition | P1 |
| — | — | the real TV: a named SKIP until one exists | SKIP |

### 9.3 Q9.3 — is the system simulated? The honest verdict

**Method (an estimate, not a measurement; S14 turns it into one).**
- Each subsystem's denominator is the behaviors its next gate needs, plus its registered incidents and the §2.3 tests that touch it.
- A behavior counts as covered when a repeatable referee ran green on a recent build.
- There are two columns:
  - **plumbing**: the logic in a hermetic world;
  - **artifact + device class**: Rule 10-08.5's bar, meaning the shipping binary on the shipping device class.

| subsystem | plumbing | artifact + device class | estimate | the biggest hole |
|---|---|---|---|---|
| root | ≈ 80 % | ≈ 30 % | **≈ 65 %** | <ul><li>voice-path run accounting (T2);</li><li>no store backup (T13);</li><li>OG-ctx;</li><li>nothing attaches to rc1 until T11.</li></ul> |
| agent | ≈ 35 % | ≈ 10 % | **≈ 30 %** | <ul><li>**It's not in ygg-sim at all.** The sim's voice runs through the bridge, not the LiveKit agent.</li><li>No burst / exactly-once sim, so F10's 12 phantom runs and 7 duplicates reached MAIN.</li><li>No latency instrumentation.</li><li>2 of the 4 uncovered incidents are its own.</li></ul> |
| PWA | ≈ 75 % | ≈ 15 % | **≈ 55 %** | <ul><li>The device class. "Phone" means desktop Chromium at 360×780.</li><li>The AVD probes ran on another artifact.</li><li>The S22 has never run a scripted probe.</li></ul> |
| trunk | ≈ 30 % | ≈ 10 % | **≈ 25 %** | <ul><li>The gate is RED.</li><li>Rollback with a yggdrasil release has never been rehearsed.</li><li>No uptime probe.</li><li>lk-verify is RED with its failures unnamed.</li></ul> |
| bridge | ≈ 70 % | 0 % | **≈ 45 %** | <ul><li>Not on trunk.</li><li>20 days stale.</li><li>2 KNOWN issues unfixed.</li><li>Never run on a phone.</li></ul> |
| app | ≈ 30 % | 0 % | **≈ 20 %** | <ul><li>The FGS mic, the native client, the token lifecycle, the voice round-trip, the update path.</li><li>Signing.</li><li>The download route.</li></ul> |
| grove | 0 % | 0 % | **0 %** | everything (by plan) |

- **What v0.7 ships** (root, agent, PWA, trunk; equal weight): **≈ 44 %**.
- **The whole road to v1.0** (seven subsystems): **≈ 34 %**.
- **In one sentence:** the plumbing is simulated, the product is not, and the simulator stopped evolving 20 days ago.

**The five biggest holes, ranked:**
1. **The voice agent path.** It is the product's core. It has no re-runnable exactly-once sim, no latency number, and no place in the sim world.
2. **The release spine.** The gate that decides promotion is RED. The rollback was never rehearsed with a yggdrasil release. Nothing watches uptime: the 4-day v0.6 outage (§1) was found by you.
3. **Staleness.** ygg-sim's last cycle was **7, on 10-07**, paired to app 0.6.0.
   - The co-evolution law ("an incident uncovered for more than one cycle FAILS the cycle") never bit, because no cycle ran. Its 4 uncovered incidents (agent-dup, chunk-race, tts-stutter, oc-timeout) have been open since.
   - At least 6 v0.7 incidents were never registered: F10's phantom and duplicate runs, the v0.6 brain outage, T5's STT language, T6's send-while-working, onset loss, the version string.
4. **The device class.** Every fact about the phone comes from your hands. The S22 has never run a scripted probe.
5. **The grove.** Zero, by plan. S11's stubs are the first step.

### 9.4 Q9.4 — evolution metrics

**What exists:**

| source | what it measures | span | trendable? | the numbers |
|---|---|---|---|---|
| **ygg-sim cycles** (`report/cycles/`) | scenarios ran/pass/break/known/fail, per-scenario latencies, SLOs; the hermetic world, mock brain | 7 cycles, 10-04 → 10-07 | **yes**, the only true series. It stopped 20 days ago | <ul><li>**scenarios:** 20 → 24 → 24 → 24 → 27 → 30 → 30;</li><li>**PASS:** 17 → 16 → 17 → 17 → 20 → 23 → 23;</li><li>**FAIL:** 0, except cycle 2 (1);</li><li>**SLO:** 44/45 at cycle 7;</li><li>**hands-free voice turn:** 23.3 → 19.2 → 16.8 → 19.1 → 18.1 → 17.8 → 20.3 s (target ≤ 8 s, never met);</li><li>**poor network:** 22.7 → 19.5 s;</li><li>**long reply:** 28.0 → 22.2 s;</li><li>**ping:** 150 → 149 ms, flat;</li><li>**wall:** 217 → 425 s.</li></ul> |
| **`.agi-log/log.tsv`** | lane attempts: model, duration, exit | 10-04, 10-19 → 10-27 | **counts only**. It records that a lane *exited*, not whether its gate went green. The 42 h gate (REST turns) is not in it | <ul><li>10-04: 9 ended (6 OK, 1 FAIL, 1 STALLED, 1 stall-retry);</li><li>v0.7: 13 ended, 13 OK, median 27 min, 8.2 h total.</li></ul> |
| **e2e per wave** (prose in `docs/reviews/`) | pass/fail per suite, per wave | 10-19 → 10-24 | no: prose, no build hash in a machine form | <ul><li>**general:** pre-batch 35 pass / 4 fail → batch 42 / 4 → final **57 / 0 / 2 skip**;</li><li>onboarding 8/8;</li><li>MAINFRAME-C 12/12;</li><li>herdr pins 3/3 (RED pre-fold).</li></ul> |
| **lk-verify daily** (`docs/environments.md`) | trunk e2e, daily | 09-24, then 10-23 → 10-26 | half: **the fail count and the names are not recorded** | <ul><li>09-24: 8 → 10 passed, green ×4;</li><li>10-23..26: "FAILED — 45 / 43 / 45 / 45 passed";</li><li>the `oc` column reads `inactive` (the gate's `port.4096` story).</li></ul> |
| **URD** (`docs/urd/tests.md`) | human gate rows | 10-01 → 10-19 | no: prose verdicts, n and misses mostly absent | 10 rows. The v0.7 consent FAIL (10-06) → the STT leg RED → GREEN (10-19). Onset 5/12 lost (10-19) → 2/8 after the fix (42 % → 25 %, small n; §2.1) |
| **LIFE.md** | the usage model (opencode store) | one snapshot, 10-03 | no: S10 refreshes it | 178 sessions; median 22 messages, p90 130; tool parts 8,749 vs text 5,151; bash 60 % of tools; 1,346 user turns |
| **voice latency, the real chain** | STT and brain time per turn | 10-04 (n = 3); 10-24 (n = 1) | no | <ul><li>STT: 1,221 / 918 / 584 ms;</li><li>brain: 4.95 / 7.46 / 6.95 s (`agi-loop-metrics.json`);</li><li>the first real voice turn's transcript: 804 ms after release (gate-final).</li></ul> |
| **voice latency, the diag** (`[voice] first-turn: …`) | release → transcript and → reply, per page load | 10-22 → 10-27 | **no, as logged.** <ul><li>First turn only.</li><li>Every line is written twice.</li><li>The reply values sit on poll ticks (6.0 / 9.0 / 12.0 / 16.0 s), not on the voice.</li><li>A cluster at 10.44 s repeats across three days: a test fixture's signature, not your voice.</li><li>Test traffic is mixed with yours.</li></ul> | transcripts 462–10,447 ms; replies 6,003–16,004 ms |
| **wedges** | runs that stall | the churn receipts (sim) | no daily count | <ul><li>churn phase 3: 10/10 SIGKILLs healed in 2.1–2.3 s to `blocked/interrupted`;</li><li>the diag logs watchdog *scans and arming*, not the stalls it fired on.</li></ul> |
| **session uptime** | — | — | **nothing measures it** | the 4-day v0.6 outage was found by you, not by a metric |

**So, are we improving?**
- **Sim coverage: yes, measurably, then stalled.**
  - +10 scenarios and +6 PASS in three days, with 0 FAIL held.
  - The incident → scenario register started: 5 of 9 covered.
  - No cycle since 10-07.
- **Test breadth on the sandbox: yes.** 35 → 57 passing in the general suite. The failures traced to the environment, not to the code (gate-final wave 1).
- **Quality of what you hold: unknown.** The signals we have point both ways:
  - **Better:** onset loss 42 % → 25 %; the STT leg fixed; queued REST turns exactly once (20/20).
  - **Worse:**
    - the daily verify green → RED for 4 days;
    - the gate items green as written: **3/8** (§2.1);
    - 12 phantom runs and 7 duplicate turns in MAIN.
  
  No common unit, no build hash, no series. So direction can't be called.
- **Performance: flat where measured, unmeasured where it matters.**
  - In the sim, the voice turn sat at 17–20 s for six cycles, because nothing in the voice stack changed.
  - The real chain was measured once (n = 3), 23 days ago. plan.md's own "perceived round-trip < ~2 s" has never been measured.

**The metrics ledger (proposal → S14).**

The fixed set: six metrics, every wave and every release, always with the build hash and the device class.

| metric | definition | source | what's missing to collect it | builds it |
|---|---|---|---|---|
| **e2e pass rate** | passed / (passed + failed), per suite | Playwright JSON reporter | lk-verify and the wave runners emit JSON: the fail count, the names, the hash | S3 (lk-verify), S14 (adapter) |
| **flake rate** | tests that pass only on retry, plus gate referees disagreeing across N = 3 reruns (Rule 10-08.3) | Playwright `flaky` status; the N-pass rerun | `--retries=1` in the referee runs; the rerun step | S14 |
| **voice round-trip** | p50 / p95 of release → transcript and release → first audio, **split by source** (you / e2e / sim) | one `voice.turn` diag line per turn: `{source, run_id, release→transcript, release→first_audio, dup}` | the line itself. It is the same event T2's accounting needs | S1 (with T2), S14 (daily digest) |
| **wedge count** | per 100 runs: runs that ended `blocked/interrupted`, were aborted by the watchdog, or sat on "working…" > 2 min with no event | the root's run table + the diag | a daily count | S14 |
| **gate items green** | n green / n in plan.md's current gate, on the frozen build's hash | the gate written in machine form (id, referee command) | that file | S14 |
| **session uptime** | % of 5-min probes GREEN, per slot (live, next), plus the time to recover | `gate.py --quick` (read-only, ≤ 5 s) on a timer | the quick mode (S3); the timer (your go) | S3 + S14 |

Three more lines are carried, because v0.7 failed on them:
- **exactly-once:** duplicate + phantom turns per 100 voice turns;
- **onset loss:** n and misses, from URD;
- **sim coverage:** ran / pass / known / break / fail, plus incidents uncovered.

**Storage.**
- `docs/metrics/waves/<wave-id>.jsonl`, append-only, one line per measurement:
  ```
  {"ts":"…Z","wave":"v07-gate-final","release":"v0.7.0-rc1","build":"<hash>","slot":"next",
   "device":"desktop-chromium-360","source":"e2e","metric":"e2e.pass_rate","value":0.983,
   "n":59,"unit":"ratio","evidence":"docs/reviews/v07-gate-final.md"}
  ```
- `docs/metrics/index.jsonl` holds one roll-up line per wave: the six numbers + the release + the hash + the date. That is the trend series.
- **Writers:**
  - the wave runners;
  - lk-verify;
  - `ygg-sim cycle`, through an adapter (its `cycle-N.json` is already structured);
  - the uptime timer;
  - a nightly diag digest.
- **Commits:** the wave that produced the numbers commits them. **No timer pushes.** lk-verify's daily auth failure is the lesson.
- **Backfill:** the numbers in the table above (cycles 1–7, gate-final waves, environments.md rows, agi-loop-metrics, URD onset). Every gap stays a visible `—`.

**Presentation.**
- **Every wave report opens with a generated block.** Six rows: this wave · previous · a sparkline over the last 6 waves (`▁▂▃▅▇`) · the target · the direction. `scripts/metrics.py report <wave>` writes it; never by hand.
- **Monthly:** `scripts/metrics.py month 2026-10` writes `artifacts/metrics-2026-10.svg`. One small line chart per metric, a dot per wave, the target dashed. It is linked in the chat on the 1st, through the schedule file (Q3's Squid / S8).
- **The direction rule:**
  - a metric **improves** when the median of its last 3 waves beats the 3 before;
  - a move inside the metric's own spread is **flat**;
  - two waves the wrong way = a **regression** line in the report + a phone push.
  
  Then "are we improving?" is answered by `index.jsonl`, not by a reflection lane.

### 9.5 Plan + spawn-list delta (folded into §7)
- **New: S12 APK-SIM** (opus): the §9.1 spec as scenarios, plus release signing.
  - It builds the sim for v0.8 *before* v0.8's code (Rules 10-09/10-10), so it may start now, in the lab.
  - It runs after S4, in parallel with S1.
- **New: S13 SIM-REVIVAL** (sonnet + an opus judge): ygg-sim cycle 8 on trunk hashes, the v0.7 incidents registered, and an `agent.*` family that puts the LiveKit voice agent into the world.
  - The incident register is a doc edit and can go now.
  - Cycle 8 waits for S2.
- **New: S14 METRICS-LEDGER** (sonnet): `scripts/metrics.py`, `docs/metrics/`, the adapters, the backfill, the uptime probe unit (enabled on your go). It runs after S4.
- **Rows that grow:** S1 (T14 icons, `.apk` in the artifact type map, the `voice.turn` line), S3 (lk-verify JSON, `gate.py --quick`), S10 (feeds S14's backfill), and §2.3's T11 (ygg-sim `rest.*` on rc1's binary).
- **Shared file:** S11, S12 and S13 all add scenarios to `lab/ygg-sim`.
  - Each owns its family file: `grove.rs`, `app.rs`, `agent.rs` + `sources.rs`.
  - The registry (`scenarios/mod.rs`, `main.rs`) is the one shared file: claim it per slice, merge small.
- **Two more words from you:** the S22 over wireless debugging (a one-time pairing; AGI runs the device probes), and the uptime probe timer (read-only; it pushes only on RED).

---

## 10. Q10 — the voice lab, STT on the phone, the labs inventory, the loops

**Your five questions (refined):**
1. Does a voice lab run 24/7, scanning GitHub and papers for new STT/TTS models, evaluating them and improving itself?
2. The goal is STT **on the phone**, with only text crossing the trunk to the root. Is that written down anywhere, and what does it take?
3. If the 24/7 voice lab doesn't exist: why not, and what must be set up?
4. What other labs exist (PCB/hardware, silicon, others)? On this machine or not, alive or dormant?
5. Do the labs run in a loop with evolution and metrics, so quality and performance trends can be measured?

**Evidence read** (read-only, 10-27):
- `~/Work/voice-lab`: README, `docs/phase-log.md`, `docs/plan.md`, `results/stt_duel.json`, `corpus/`, `models/`, its git state.
- The `[LAB] voice` session (`ses_f080…`, 149 messages, 10-01 → 10-22), and the session list of the :4096 store, with first and last activity per `[LAB]` session.
- STABLE.md (the ladder and the locked 10-06 decisions), `lab/ygg-sim/FINDINGS.md` + `VERSIONS.md`, `docs/urd/tests.md`, `docs/open-questions.md` #3/#4, `docs/spec-bridges.md`, `docs/roadmap-proposal.md`, `docs/claims.md`.
- `artifacts/on-device-voice-research.md` (09-30).
- `systemctl --user list-timers`, the lab units, `docker ps`, `docker inspect ygg-sim`.
- Path-scoped `git log` per lab, plus the trunk's last 40 commits.
- `hardware/build/*-drc.rpt`, `lab/worldtree-data/nightly.log` + `method/VERSION`.
- Two read-only HTTP probes: the Mac `:8001/health` and `:8002/health`, and speaches `:8000/health`.

Nothing was restarted. Nothing was written outside this file and its artifact copy. §5.1 already gave a short labs table for the 06:35 message. This section replaces it with evidence per lab.

### 10.0 The answers, short
1. **No voice lab runs 24/7, and none watches the field. In practice, you are its field-watch.**
   - **What exists:** `~/Work/voice-lab`, a real bench with real numbers, worked 10-01 → 10-04. The repo has **zero commits** (`git log`: "does not have any commits yet"), so its history is file mtimes only.
   - **The last voice R&D:** on 10-22 you pasted the IBM Granite Speech 5.0 article into `[LAB] voice` by hand. The lane started a CPU bench: it hit a missing BLAS, had no sudo, pivoted to cloning llama.cpp, and the session stops there (13:31, no result). The 3.1 GB GGUF is still in `voice-lab/models/`, never evaluated.
2. **STT on the phone: written nowhere as a decision, and the one locked decision points the other way.**
   - STABLE's locked line from 10-06 puts STT in-process on the box and says it "moves into the bridge for v0.9".
   - The v0.9 bridge claim routes "mic → speaches STT" over WebRTC to the box.
   - Your goal appears only as open-questions #3 (09-30: an *offline fallback* tier, undecided, its spike never run) and as §5.3's research radar.
   - **Feasible:** native, inside the APK (sherpa-onnx class). English now; French is the same blocker that stalls v0.6.2.
   - **Lands:** as **v0.8.1** behind a flag, then the default per language at v0.9.
   - **The law:** your voice never leaves the phone.
3. **Why the 24/7 lab doesn't exist.** Four pieces are missing:
   - a scheduler (Squid, §3, unbuilt);
   - a replacement for the autonomy stopped on 10-06 (STABLE 7);
   - an instrument: no frozen corpus, no ledger, results uncommitted;
   - a trigger: nothing watches releases.
   
   **The setup:**
   - a voice bench: frozen corpus v1, plus WER, RTF, tail latency and RSS lines into §9's ledger;
   - a release radar with no LLM;
   - a re-eval wave per real release;
   - an Opus verdict only when a candidate beats the incumbent.
   
   **Cost:** 0 tokens per day, about 10–15 min of box CPU per night, and 2–4 Sonnet lanes plus ≤ 1 Opus lane a month.
   
   **Decision:** build it now (S15) and enable the timers on your word.
4. **Labs: 16 rows, two timers.** worldtree's is green; lk-verify's is RED.
   - **No lab trends its own quality.** worldtree loops on *data*; its method is frozen at 0.6.0 since 10-08.
   - **PCB:** three boards placed and routed on 10-06, **not fab-ready**: DRC 67 / 114 / 381, unconnected pads 27 / 30 / 87. Dormant since.
   - **Silicon: stillborn.** A 2-minute session on 10-08 started a 748 MB toolchain download. Nothing is on disk today.
   - **ygg-sim:** its container runs `sleep infinity`, and its last cycle was 10-07. claims.md still says "SELF-IMPROVING LOOP running".
5. **Loop + evolution + metrics: no lab has all three.**
   - The loop-driver goes, in order, to:
     1. ygg-sim (S13);
     2. the voice lab (S15);
     3. research-feed + field-watch (S8);
     4. lk-verify, after S3 turns it green;
     5. worldtree, hygiene only (S17).
   - Dormant on purpose, each with a wake trigger: PCB, silicon, mini-agi.
   - Folded or graduated: edge, bifrost-net, android-lab, yggdrasil, agi-metrics.

### 10.1 Q10.1 — the voice R&D audit: what happened vs what a 24/7 lab does

**What happened** (every row was hand-started by you or a dispatch):

| date | what | result | receipt |
|---|---|---|---|
| 09-30 | on-device voice research (browser/WebGPU/native) | **STT:** English on-device is solved: Moonshine 34M/123M streams. French = Whisper batch or sherpa zipformer-fr. **TTS:** Kokoro-82M. **Next step:** a 1-day RTF spike on real phones, **never run** | `artifacts/on-device-voice-research.md`, open-questions #3 |
| 10-01 | edge / bifrost-lite spike | sherpa-onnx whisper tiny.en int8 STT RTF 0.29, piper TTS 0.26–0.37, verify 7/7 on x86. The Termux arm64 run on a spare phone: **never done** | `edge/`, a2051fc |
| 10-01 | voice-lab P1 baseline | <ul><li>Mac Qwen3-ASR: 0.56 s, WER 3.7 / 2.3 % EN/FR.</li><li>faster-whisper-small: 5.5 s, WER 6.4 / 12 %.</li><li>A config change, `streaming_interval` 4 → 0.5, took first audio from 1.19 s to 0.19 s.</li></ul> | `docs/findings/baseline-2026-10-01.md`, roadmap-proposal |
| 10-02 | calm voice + French voice matrix (TTS) | deep French male solved by chatterbox clones (97/112 Hz, loop WER 0); the VoxCPM2 French ref path is broken | phase-log, `results/*_voices.json` |
| 10-04 | **the STT duel**: 510 s, 17 chunks, auto-caption reference | **Parakeet Redux** (ONNX, this CPU): WER 5.3 %, RTF 0.224, slowest chunk 9.2 s, 398 MB fp32 · **Qwen3-ASR 1.7B** (Mac): 7.4 %, RTF 0.060, 2.5 s · **speaches whisper-small**: 5.4 %, RTF 0.437, 17.3 s. Number-normalized WER barely moves. **Verdict:** Parakeet Redux earns the edge/CPU/phone EN slot; the Mac stays prod (speed, French, cleanest text) | `results/stt_duel.json`, `docs/findings/stt-duel-parakeet-redux.md`, URD 10-04 |
| 10-06 | sim cycle 6 `voice.stt-inprocess` | <ul><li>**Parakeet Redux, resident in the edge:** EN WER 0 vs 0 %; 476 vs 4869 ms per utterance; a 10 s utterance in **1280 ms** (gate ≤ 2 s); RSS 640 MB.</li><li>**FR:** WER 37 % vs whisper's 18 %. Parakeet v3 int8: 31 %, 1611 ms, 1152 MB.</li><li>→ **v0.6.2 blocked on French** since 10-06.</li></ul> | FINDINGS #10, STABLE "Decisions locked 10-06" |
| 10-19 | the STT leg of the v0.7 FAIL | `STT_MODEL=faster-whisper-small` was sent to the Mac → 500. 150 s of talk, zero transcripts. Fixed back to Qwen3-ASR | URD 10-19, `artifacts/stt-dead-v07-report.md` |
| 10-19 → | "Bifrost" onset | 5/12 misses → 2/8 after the fix (§0). The miss is a lost onset, not vocabulary. Still, **no stage of the stack takes a vocabulary hint**: the Mac's transcription call is file + model only. Biasing is a second lever nobody holds | memory "STT: no hotword", URD |
| 10-22 | **Granite Speech 5.0 2B** (you pasted the article) | EN + FR, keyword biasing, GGUF + mlx. The lab server `:8002` was dead and ssh to the Mac was refused, so it went CPU-only. No BLAS, no sudo → llama.cpp clone → **the session stops, no result** | `[LAB] voice` 13:22–13:31; `voice-lab/models/granite-speech-5.0-2b-Q8_0.gguf` (1.96 GB) + `mmproj` (1.16 GB) |

**Standing infrastructure:**
- **speaches** (`deploy-speaches-1`, up 3 weeks, `:8000` → 200; faster-whisper-small) is the CPU fallback: the slowest on every axis, the best French on this box.
- **The Mac:** prod `:8001` → 200; the lab server `:8002` → no answer today, the same as on 10-22.

**The honest read:**
- The lab produced real numbers and one real product decision: Parakeet goes to the edge tier, and Qwen3 stays on the Mac.
- It is not an R&D loop:
  - every run was started by a person;
  - the repo was never committed, so no trend can be rebuilt from git;
  - the corpus is thin: 8 EN + 8 FR human clips, plus the duel video. STABLE's French gate demands **≥ 10 real human FR fixtures**, so that gate **cannot even be judged** on today's corpus;
  - the newest candidate on disk (Granite) has waited 5 days for a run that died without a notice.

**What a running lab would have done with the same five weeks:**

| event | what happened | with the loop (§10.3) |
|---|---|---|
| Granite Speech 5.0 released (10-22) | you read an article, pasted it; the lane died silently | the radar sees the HF release that day → a re-eval wave benches it on the box CPU overnight → a verdict row by morning, EN + FR |
| Parakeet Redux published (early 10) | you saw a video; a hand-run duel | the same, without the video |
| The Mac lab server `:8002` died | found by chance on 10-22, still down | the nightly bench goes red → a phone push |
| The wrong STT model in the env (10-19) | 150 s of your talk lost before anyone saw it | the nightly bench runs the **release env's exact STT config** → red the night it lands |
| The French gate open since 10-06 ("more candidates") | nothing looks for candidates | every FR-capable release is benched against the FR gate automatically |

### 10.2 Q10.2 — STT on the phone, only text across the trunk

**Is it written down? Where the plan says where STT lives:**

| doc | what it says | vs your goal |
|---|---|---|
| STABLE, "Decisions locked 10-06" | "STT in-process, in bifrost — not in yggdrasil … the same STT moves into the bridge for v0.9" (the bridge runs on the box) | ❌ the box hears your voice |
| STABLE, v0.8 row | "text + voice over the bridge with tailscale off" | ❌ as written: audio over the trunk |
| claims.md, `v09-notailscale` | "voice over WebRTC: mic → speaches STT → opencode → speaches TTS → audio back, libopus" | ❌ audio over the trunk |
| spec-bridges, Transport | "the owning tree hosts the room … No audio relay, ever" | neutral (about relays between trees) |
| open-questions #3 (09-30) | the on-device tier as an *offline/fallback* option behind a flag; "decide after the 1-day RTF spike" | ⚠️ half: a fallback, not the path. Undecided; the spike never ran |
| open-questions #4 (09-30) | radical local-first; the Termux spike half-done | ⚠️ the direction, parked |
| §5.3 (this doc) | the voice radar: research only | ⚠️ |

**So:** your goal is not a decision anywhere, and the locked line contradicts it. The reasoning behind that line survives the move, and gets stronger: "the brain stays text-in/text-out, so swapping the brain never takes speech with it". STT on the phone is the strictest form of that law. **The fix is a one-paragraph amendment to STABLE, on your word (item 12).**

**The law (proposed): your voice never leaves the phone.**
- **Uplink: text only.** In phone-STT mode the trunk carries a transcript envelope, never audio:
  `{run_id, session, text, lang, confidence, model_id, model_sha, audio_ms, release_to_final_ms}`.
  - `run_id` is T2's exactly-once key. The envelope is the same event as §9's `voice.turn` line, with `source = phone-stt`.
- **No audio on the box.** No audio file or buffer is uploaded, logged or cached there. Diag lines carry timings, never samples.
- **Fallback is visible, never silent.** If the phone can't transcribe, a chip reads "voice → box" *before* any audio leaves. A setting decides whether that fallback is allowed at all; when it isn't, you get an error, never an upload.
- **Downlink: TTS stays on the box at first.** Its audio is synthesized from the reply text, which crosses the trunk anyway, so it leaks nothing new.
  - **Phase 2** moves TTS to the phone too (Kokoro-82M class, about 45–90 MB). Then the trunk is text-only both ways and LiveKit leaves it.
  - **The payoff to name now:** for the APK, a native mic needs no secure origin. That retires v0.9's "valid HTTPS or the mic dies" problem, and the bridge's WebRTC/TURN work becomes the fallback transport, not the main one.
  - This is why the STABLE line should change **before** v0.8 builds voice over the bridge.

**Feasibility on your S22** (8 GB RAM; Snapdragon 8 Gen 1 or Exynos 2200, which one isn't known here).

**Anchors measured on this box** (x86, 16 cores):

| engine | RTF | 10 s utterance | RSS |
|---|---|---|---|
| Parakeet Redux fp32 | 0.224 | 1.28 s | 640 MB |
| Parakeet v3 int8 | — | 1.61 s | 1152 MB |
| sherpa whisper tiny.en int8 | 0.29 | — | — |

**Assumption, to be replaced by the spike's numbers:** a phone's big cores run these 2–4× slower than this box.

**What follows:**
- **Batch models** (they transcribe after you release) need about 3–6 s for a 10 s utterance on the phone. That **fails** the 2 s gate unless an NPU path delivers.
- **Streaming models** transcribe *while* you speak, so the tail is one chunk (≈ 0.3–0.6 s) at any length. They are the realistic default.

| path | candidate | EN | FR | streaming | size | role |
|---|---|---|---|---|---|---|
| native, sherpa-onnx | streaming zipformer (EN; FR = a 2023-era model) | ✅ | ⚠️ | ✅ | ~50–70 MB | **EN latency pick** |
| native, sherpa-onnx | Moonshine tiny/small (streaming) | ✅ | ❌ | ✅ | 34M / 123M params | EN candidate |
| native, sherpa-onnx | Parakeet TDT v3 int8 | ✅ | ✅ (31 % on our one FR test) | ❌ | ~640 MB | quality pick. Fails the RAM budget as measured on x86 (1152 MB); the phone build must show less |
| native, sherpa-onnx | Qwen3-ASR (sherpa ≥ 1.13 has the hook, per the edge claim) | ✅ | ✅ (the Mac's FR champion family) | ? | depends on whether a phone-sized variant exports | **the FR hope**: bench first |
| native, whisper.cpp | small (FR) / base.en | ✅ | ✅ | ❌ | 150–480 MB | FR fallback |
| native, llama.cpp | Granite Speech 5.0 2B Q8 | ✅ | ✅ + keyword biasing | ❌ | 3.1 GB | bench only; too big to keep resident |
| Android on-device recognizer (`createOnDeviceSpeechRecognizer`, API 31+; biasing strings on 13+) | the OS engine | ✅ | ✅ (offline packs) | partials ✅ | 0 to ship | **the zero-download fallback and the baseline row.** Never the default: the OS picks and updates the model, so it can't be pinned and the gate can't be reproduced |
| browser (WASM/WebGPU) | Moonshine-js / transformers.js | ✅ | ⚠️ | ✅ | 45–150 MB | PWA only; dies at screen-off (`app.background-audio` BREAK-OK) → not primary |

**The budget** (the spike's done-check, measured on the S22):

| axis | budget | why |
|---|---|---|
| tail (release → final text) | ≤ 1.0 s streaming; ≤ 2.0 s for a 10 s utterance in batch | v0.6.2's gate; plan.md's "perceived round-trip < ~2 s" leaves the brain about 1 s |
| WER | ≤ the incumbent's on corpus v1, **EN and FR separately** | the v0.6.2 rule |
| RAM | ≤ 800 MB resident while the voice foreground service runs | on an 8 GB phone, the app must not be the low-memory killer's first pick |
| download | ≤ 700 MB per language pack, Wi-Fi only, sha-pinned | "a model is a path in the release env" (STABLE) |
| load | ≤ 3 s warm | the first press after unlock |
| thermal | 30 min of PTT at 60 utterances/h with RTF drift ≤ 20 % | throttling shows up as drift |
| battery | ≤ 3 %/h of active talk | see the estimate below |
| biasing | a hotword list (Bifrost, yggdrasil, repo names) | a bench column. It closes the hotword gap |
| onset | a ≥ 300 ms pre-roll ring buffer from the press | on the phone, capture and recognition share one clock, so onset loss becomes a local bug with a local fix (T3's pre-roll) |

**The battery estimate:**
- 60 utterances × 10 s × RTF 0.25 = 150 s of compute per hour.
- At about 4–5 W, that is ≈ 0.2 Wh of the S22's ≈ 14 Wh, so **about 1–1.5 %/h**.
- It replaces an always-connected WebRTC uplink, which costs radio time. The spike measures both modes A/B with `dumpsys batterystats` rather than trusting this arithmetic.

**Verdict:** feasible for English now. **French is the shared blocker.** One French bench (corpus v1 FR, ≥ 10 real speakers) decides both v0.6.2's box STT and the phone's FR pack, and the radar is what finds the candidates.

**Landing:**

| when | what | gate |
|---|---|---|
| **now** (lab, no version) | **S16 PHONE-STT-SPIKE**: a bench activity in the lab APK. **AVD:** function. **S22:** numbers, after your wireless-debugging pairing (§9 item 9) | the budget table filled for ≥ 3 candidates + the Android baseline; a pick per language |
| **v0.8** | unchanged: the bridge + the APK with box STT. **One change per version** (STABLE). The bridge's voice contract carries the text envelope from day one; the audio transport already built in `lab/bifrost-net` (WebRTC relay, libopus) is the fallback | as written in STABLE |
| **v0.8.1, "voice stays on the phone"** | EN, a per-device flag, box STT as the visible fallback | the budget on the S22 · sim `voice.text-only-trunk` + `voice.stt-phone` + `voice.fallback-visible` green · 3 days of your use |
| **v0.9** | the default, per language, once that language passes on the phone (FR may lag EN). **The iPhone (v0.9's second phone) has no APK:** on-device there means Apple's speech framework with on-device-only recognition, or WASM in Safari. A separate spike, named now so v0.9 doesn't find out late | the v0.9 row |
| **v1.0 candidate** | TTS on the phone → the trunk is text both ways | not needed for the privacy law |

**What to simulate.** The AVD covers function and the S22 covers numbers (Rule 10-08.5: the shipping binary on the shipping device class).

| scenario | proves | where |
|---|---|---|
| `voice.text-only-trunk` | in phone-STT mode, **zero audio bytes cross the trunk**: a capture on the proxy/bridge port; any RTP/Opus frame or audio MIME = FAIL | ygg-sim + AVD |
| `voice.stt-phone` | press → local transcript → envelope → exactly one run (by `run_id`) → reply; onset case from the pre-roll | AVD with the PipeWire virtual mic (S12's fixture) |
| `voice.fallback-visible` | model load fails or OOM → the chip shows *before* any audio leaves. With fallback disallowed → an error, never an upload | AVD |
| `voice.pack-update` | a new model pack: download, sha check, swap, rollback to the previous pack | AVD |
| `voice.offline-queue` | trunk down → the transcript queues on the phone and lands once when the trunk returns | ygg-sim chaos |
| the device bench | RTF, tail, RSS, battery, thermal drift on corpus v1 | the S22 only (a named SKIP until item 9) |

### 10.3 Q10.3 — why no 24/7 voice lab, and the setup

**Why not:** the four missing pieces, all visible on the box.
1. **No scheduler.** Squid (§3) is unbuilt. The box's only timers are lk-verify and worldtree.
2. **Autonomy stopped on 10-06** (STABLE 7: fleet-watchdog and ygg-driver off). That was right that day. Nothing replaced it, so every lab stopped with it.
3. **No instrument.**
   - Results are one-off JSON in a repo with no commits.
   - The corpus has no version.
   - No ledger exists.
   
   "Improving itself" had nothing to improve against.
4. **No trigger.** Nothing watches releases. The 10-22 lane also died **without a notice** (the F3/F4 class; S4's completion/death letters fix it).

**The loop:**
```
radar (daily, no LLM) ──candidate──▶ re-eval wave (Sonnet, ≤ 45 min) ──lines──▶ ledger (§9.4)
                                              │ beats the incumbent on a role's rule?
nightly bench (no LLM, the release env's      ▼
incumbents) ──red──▶ phone push         verdict (Opus, ≤ 15 min) ──▶ proposed --env-only release (your go)
```

| # | component | what | LLM |
|---|---|---|---|
| 1 | **corpus v1** | Frozen and hashed (`corpus/v1/MANIFEST.sha256`). <ul><li>**EN:** the 510 s duel set, the 8 human clips, about 10 min of public read speech.</li><li>**FR:** ≥ 10 real human speakers with transcripts, from public/CC sets.</li><li>**VOCAB:** 50 utterances of coding speech: repo names, commands, "Bifrost", "yggdrasil".</li><li>**ONSET:** 20 utterances that open on the keyword.</li><li>**PHONE:** 10 real phone-mic clips, yours, with your consent.</li></ul> A change = v2. Scores are never compared across versions without re-running the incumbents | none |
| 2 | **`lab/bench.py`** | One plugin file per engine: mac-qwen3 (`:8001`), speaches-whisper (`:8000`), parakeet-redux, parakeet-v3-int8, granite-5.0 (llama.cpp), plus S16's device engines over adb. **Metrics:** WER EN/FR/VOCAB/ONSET (+ no-numbers), RTF, tail on 10 s, first partial, peak RSS, load, size, licence, biasing yes/no | none |
| 3 | **the nightly incumbent bench** | Reads the **release env's** STT/TTS config (live + next slot) and benches exactly that, 03:00 local, ≈ 10–15 min of box CPU. Red = drift: the Mac down, a wrong model, a regression | none |
| 4 | **`lab/radar.py`** | **Watches:** <ul><li>release feeds of the pinned repos: sherpa-onnx, whisper.cpp, moonshine, NeMo, transformers.js, mlx-audio, kyutai, granite, Qwen, kokoro, piper, speaches, livekit-agents;</li><li>the HF API: ASR/TTS models, new or updated, open licence, a runnable format (onnx/gguf/mlx), EN or FR;</li><li>the Open ASR leaderboard diff.</li></ul> **Output:** `watch/candidates.jsonl`. The filter is code. Unauthenticated, outside the 12:30 UTC worldtree window (shared GitHub IP budget) | none |
| 5 | **a re-eval wave** | Per candidate: a Sonnet lane writes one engine plugin and runs the bench. At most 4 a month; the rest queue | Sonnet |
| 6 | **the verdict** | Only when a candidate beats the incumbent on a **role's** rule. **Roles:** Mac STT, box STT, phone EN, phone FR, TTS EN/FR. It writes the verdict and the proposed `--env-only` change, and **never applies it** | Opus |
| 7 | **ledger lines** | S14's schema, `docs/metrics/waves/voice-<date>.jsonl`: `voice.wer.{en,fr,vocab,onset}`, `voice.rtf`, `voice.tail_ms_10s`, `voice.first_partial_ms`, `voice.rss_mb`, tagged by engine × device (box-x86 · mac · s22). **Two series per role:** the incumbent (nightly: are we stable?) and the **frontier** (the best candidate: is the field passing us?). Monthly, in S14's svg | none |
| 8 | **commits** | voice-lab gets its first commit. The wave that produced results commits them. **No timer pushes** (lk-verify's lesson) | none |

**"Improving itself", defined so it can't co-cheat** (Rule 10-05 law 2):
- **The corpus grows from field misses.** Every real miss ("Bifrost" → "Frost") becomes a fixture in the next corpus version: ygg-sim's incident → scenario law, applied to voice.
- **The incumbent changes only through a gated `--env-only` release, on your go.**
- **The lab never edits its referee.** Corpus versions are frozen, the WER code is fixed, and the judge never authors the candidate it judges.

**Cost per month:**

| item | cadence | cost |
|---|---|---|
| radar | daily | 0 tokens; ≈ 40 HTTP GETs a day |
| nightly bench | daily | 0 tokens; ≈ 10–15 min of box CPU at 03:00; the Mac sees only HTTP calls |
| re-eval waves | 2–4 a month. The field's pace: two benchable releases worth a test in October (Parakeet Redux, Granite 5.0) | 2–4 Sonnet lanes × 30–45 min |
| verdict | ≤ 1 a month | 1 Opus lane × ≈ 15 min |
| S16 device runs | on demand | the S22 over adb, minutes per candidate |
| disk | — | model cache capped at 40 GB, LRU (848 GB free; Granite alone is 3.1 GB) |

Everything runs through `agi-run`: subscription quota, no pay-per-token API (§5.2). In total, about one more weekly-papers lane.

**Decision: build now, enable on your go.**
- **Build now (S15):**
  - the bench, corpus v1, the radar, the ledger lines and the first commit;
  - the Granite re-eval as receipt 0.
  
  No LLM is in the loop and no timer gets enabled. It is pure tooling with a done-check.
- **Enable on your go (item 11):** three schedule entries (radar daily, bench nightly, re-eval on trigger). They come after S4, so a lane that dies says so, and after S8's schedule file exists.
- **Not awake 24/7** (same reasoning as §5.2): the field's pace is the cadence, and a quiet week costs zero tokens. "24/7" here means **nothing released in the field goes unbenched for more than a day**. That is checkable; an always-on session is not.

### 10.4 Q10.4 — the labs inventory

All on this box unless the machine column says otherwise. "Last activity" cites git (path-scoped), the session store, or the unit.

| lab | where | machine | state | last activity (evidence) | loop? | metrics? |
|---|---|---|---|---|---|---|
| **worldtree-data** | `lab/worldtree-data`, `worldtree-fetch.timer` (14:30 CET) | box → veraldar.org | **alive** | run `20261026T133328Z` published; 47 runs in `runs/`; `nightly.log` | ✅ **data loop** (fetch → run → publish, daily). The **method is frozen** at 0.6.0 since 10-08 (8922a9c): the data moves, the lab doesn't evolve. That is right for a published method; it changes by milestone briefs | output numbers (realm scores per run); **no lab-health line**. Side effect: **17 empty "run …: published" commits on the trunk since 10-10** (0 files each). With lk-verify's 4, robots wrote 21 of the trunk's last 40 commits |
| **ygg-sim** | `lab/ygg-sim` + container `ygg-sim` | box | **stopped** | cycle 7 = ff434a2 "v6: the co-evolution law mechanized", 10-07. The container runs `sleep infinity`, up since 10-04 | ❌ the law is in code (`src/sources.rs`), with no driver. **claims.md still says "SELF-IMPROVING LOOP running"** | ✅ the best we have: `report/cycles/cycle-1..7.json` + matrix |
| **voice-lab** | `~/Work/voice-lab` + `[LAB] voice` | box + Mac (prod `:8001` 200; lab `:8002` silent) | **dormant, hand-fed** | last result 10-04 (`stt_duel.json`); 10-22 the Granite run died mid-build | ❌ | per-run JSON; **0 commits** |
| **edge / bifrost-lite** | `edge/` | box (arm64 never run) | dormant | a2051fc, 10-01 | ❌ | verify 7/7, once |
| **research-feed** | `docs/research/research-feed.md` | box | dormant (declared weekly) | pass 1 on 10-07 (+ index JSON); pass 2 due 10-14 → **13 days overdue** | ❌ | the index JSON |
| **field-watch** | proposed in herdr-takeaways | — | never ran | herdr = receipt 0, by hand on 10-22 (4a5a718) | ❌ | — |
| **hardware / PCB** | `hardware/`, `~/Work/veraldar-hw`, `[LAB] hardwar` | box (KiCad AppImage, freerouting) | **dormant, stalled** | **The 10-06 run** (M4 "FINISH", 5461725): 3 boards placed + routed, 89 / 81 / 54 % of nets.<br>**Not fab-ready:** DRC **67 / 114 / 381**, unconnected pads **27 / 30 / 87** (beacon-A / airnode-B / current-C, `build/*-drc.rpt`, 10-06 19:56).<br>`veraldar-hw` was last committed on 10-04 | ❌ | route %, DRC/ERC counts, once |
| **silicon** | `[LAB] silicon` | box | **stillborn** | 10-08 05:07–05:08, 6 messages: started a 748 MB OSS CAD Suite download with `nohup`. Today there is no `~/oss-cad-suite-dl` and no `lab/silicon` | ❌ | — |
| **mini-agi (halo-memory)** | `experiments/halo-memory`, `docs/research/mini-agi-report.md` | box | dormant (parked on a GPU-rental call) | report 10-04 | ❌ | toy-scale retention results |
| **bifrost-net** | `lab/bifrost-net`; `bifrost-bridge.service` **running** | box | **graduated** → the v0.8 track (`lane2/merge`, 10-06) | last lab commit 057bddb, 10-07; ap-verify 15/15 on 10-04 | its loop = sim `bridge.*` | m0/m1/ap verify suites |
| **android-lab** | `pwa/android` + AVD | box | graduated → S12 | APK built 10-06 22:32; cycle 6 scenarios | → S12 | 5 `app.*` scenarios |
| **yggdrasil** | `lab/yggdrasil` | box (`lk-yggdrasil` :4100) | graduated → the v0.7 root | a683c22, 10-24 | product | the e2e suites |
| **agi-metrics** | `.agi-log/log.tsv` | box | graduated → agi-run's ledger | 10-04 | — | 50 lane rows |
| **lk-verify** (daily e2e) | `lk-verify.timer` (12:00 CET) | box | alive, **RED** (the unit reads `failed` today) | daily | ⚠️ loops, fails daily | pass counts in `environments.md`; no trend |
| **net-research** | `[LAB] net-research` | box | one-shot | 10-05 → `docs/research/tailscale.md` | — | — |
| **the Mac** | Mac Studio | Mac | prod speech alive (`:8001` 200); voice-lab server `:8002` down | the Mac's own root (Squid / Flow / Workers / Letters) is **unread**: S9, needs your access | unknown | unknown |

`~/Work` also holds dbzcraft, monster3d, magic-closet and a japan-booking session. They are other projects, not yggdrasil labs, and out of scope.

**Totals.**
- 16 rows and two timers: one green, one RED.
- **0 labs trend their own quality.**
- 5 graduated into product or tooling.
- 4 dormant with real assets: voice, PCB, mini-agi, edge.
- 1 stillborn: silicon.
- 2 never really started: research passes after #1, and field-watch.

### 10.5 Q10.5 — loops, evolution, metrics: the verdict + the order

**Verdict: no lab runs a loop with evolution and metrics.**

| lab | loop | evolves | metrics |
|---|---|---|---|
| worldtree | ✅ | ❌ (method frozen, by design) | output data only |
| ygg-sim | ❌ (driver stopped 10-06) | ✅ (the incident law) | ✅ |
| voice-lab | ❌ | ❌ | per-run, no history |

The "continuous" law (Rule 10-07) has no mechanism (§5.1); this table confirms it lab by lab. The trends §9.4 asks for cannot exist yet for any lab.

**The bar for the loop-driver.** A lab earns the wave chain + the ledger only when it has all five:
1. a referee outside the lab (corpus, matrix or gate);
2. one ledger line per run;
3. a done-check per run;
4. a cadence or a trigger;
5. **a product rung it feeds.**

A loop without a consumer burns quota and drifts toward its own signal (Rule 10-05).

| order | lab | cadence / trigger | ledger line | feeds | lane | switched on by |
|---|---|---|---|---|---|---|
| 1 | **ygg-sim** | weekly + every trunk merge | the cycle roll-up (ran / pass / known / break / fail) + incidents uncovered | every release gate (T11) | S13 | your go (§5.3) |
| 2 | **voice-lab** | radar daily · bench nightly · re-eval on a release | `voice.*` per engine × device | v0.6.2's French gate, phone STT (S16), the Mac incumbent | S15 (+ S16) | item 11 |
| 3 | **research-feed + field-watch** | weekly / monthly | T/A/N counts per pass | the playbook, candidate slices | S8 | item 4 |
| 4 | **lk-verify** | daily (already) | e2e pass rate, fail names, build hash | the release gate | S3 | already on; **turn it green first** |
| 5 | **worldtree** | daily (already) | run health: ok, sources fresh, published sha verified | veraldar.org | S17 (hygiene) | already on |

**Dormant on purpose, each with a wake trigger** (`docs/labs.md` carries these, S17):
- **PCB.**
  - **Wakes when** you name a board to fabricate.
  - **Its loop is then natural:** freerouting + DRC/ERC → 0, trended. It has the cleanest metric of any lab.
  - **Why dormant now:** it gates no rung until a satellite device exists (v1.0+).
- **Silicon.**
  - **Wakes only with a written done-check first:** one RTL target + a testbench + a yosys/OpenROAD PPA number against a published one ("no execution without a checkable done"). The 10-08 vision ("any agent designs any chip from requirements") has none.
  - **Restart cost:** a 748 MB toolchain download. Nothing else was built.
- **mini-agi.**
  - **Wakes when** dreaming (`spec-dream.md`, v1.0) needs continual learning.
  - **The GPU-rental call is yours.**
- **Folded:** **edge** becomes the bench's box-CPU device class. Its Termux arm64 run is superseded by S16's APK bench on the S22.
- **Graduated:** **bifrost-net, android-lab, yggdrasil, agi-metrics.** Their loops are product sim families and the release gate, not lab loops.

**Then "are the labs running?" has a standing answer:**
- **`where.sh labs`:** state, machine, last run, next run (S17).
- **S14's monthly chart:** ygg-sim coverage, the voice incumbent vs the frontier, research T/A yield, the verify pass rate.

No reflection lane is needed to answer it again.

### 10.6 Plan + spawn-list delta (folded into §7)
- **New: S15 VOICE-BENCH** (sonnet; opus verdict only on a beat). The §10.3 instrument plus the Granite re-eval as receipt 0. It works in its own repo, so it may run in parallel with everything after S4.
- **New: S16 PHONE-STT-SPIKE** (opus).
  - **Builds:** the lab APK's bench activity, the transcript-envelope spec, and the five `voice.*` scenarios (§10.2).
  - **Runs after:** S12's first slice (it shares `pwa/android`) and S15's corpus v1.
  - **Device column:** after item 9.
- **New: S17 LABS-REGISTRY** (sonnet):
  - `docs/labs.md`;
  - `where.sh labs`;
  - worldtree's nightly marker off the trunk;
  - worldtree's run-health line into the ledger;
  - the stale ygg-sim "loop running" claim closed.
- **Rows that grow:**
  - **S8:** three voice entries in the schedule file. S15 writes the job specs; S8 owns the file.
  - **S13:** `voice.rs` moves to S16. S13 keeps `agent.rs` + `sources.rs`, and its incident register gains "10-22: a lab lane died mid-build with no notice" and "10-19: an STT model/env mismatch reached the user".
  - **S14:** a voice adapter (bench JSON → ledger) and the voice block in the monthly chart.
  - **S1:** T3's pre-roll spec becomes the onset case of `voice.stt-phone` later.
- **STABLE amendment** (a doc edit, on your word, item 12):
  - the 10-06 locked line → "STT moves onto the phone (the app); the box's in-process STT stays as the visible fallback";
  - a v0.8.1 row, "voice stays on the phone";
  - the law "your voice never leaves the phone" in the rules.
- **Three more words from you:**
  - **11:** the voice-lab schedule;
  - **12:** the STABLE amendment;
  - **13:** confirm PCB / silicon / mini-agi stay dormant with the wake triggers above.
