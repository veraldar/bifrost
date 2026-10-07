# Full fleet review — merge-wave + release readiness (10-06, evening)

Reviewer: Claude Opus 5.5, max effort, one session, read-only on the repo (I wrote only this file).
Method: claims were spot-checked against git, the filesystem, live services and fresh gate runs.
Nothing was taken from claim lines alone. Gate runs that I executed myself are marked **[ran]**.
Claims that I only read are marked **[claim]**.

Snapshot: `rebuild/cohesive-opus` @ `79d53f1`. This commit landed *during* the review (20:49): the
fleet is live and the line is still moving. It is 130 commits ahead of and 2 behind `origin/main`,
and 5 commits ahead of `origin/rebuild/cohesive-opus` (`49a61e6`). The main checkout has 49
dirty/untracked paths. There are 13 worktrees.

---

## 0. The one-paragraph answer

**The state is not coherent enough for the merge wave tonight, but it is two to three hours of
deterministic work away from coherent.** All the code that matters builds, and its gates are green on
both lines. Three problems sit around it:

- There are **two divergent production lines** (`rebuild/cohesive-opus` and `lane2/merge`). Both are
  live at once, from different worktrees.
- **Production runs code that exists in no commit.**
- **A P0 exposure:** two LAN listeners, :8082 and :8090, answer unauthenticated in front of a brain
  that has a bash tool.

A **`v0.9.0` tag already exists**: local, unpushed, at `fb911b7`, labelled "FINAL". Its message
overclaims: it says "user-owned relay", which was not built, and "iPhone auto-setup", which ran
only in emulated Chromium. **`v0.7.0` is not done on any line.** The `streaming_interval` knob and
the iOS known-limits line are missing on both lines. The no-docker edge-voice default exists, but
only on the v0.9 line. Fix the P0, triage the WIP, run one integration merge plus the gate, and
then tag. The exact order is in §4.

---

## 1. READY — tested and validated (evidence)

| # | What | Evidence |
|---|---|---|
| R1 | **Both lines build clean from committed state** | **[ran]** fresh `--shared` clones in /tmp. `npm ci && next build` rc=0 for `rebuild/cohesive-opus@0def4c5` and for `lane2/merge@2f3006d`. `tsc --noEmit`: the only error on both trees is a test file (`e2e/artifacts.spec.ts:1`, imports `afterAll` from `@playwright/test`). App code typechecks clean. |
| R2 | **yggdrasil brain, slices 1–9** (session, SSE, abort, roll-up, tool loop, anthropic dialect, voice mode, self-measurement) | **[ran]** `lab/yggdrasil/verify.sh` on the lane2 clone → `PASS` (rc 0). Includes slice-7 dual-dialect byte-identical transcripts, slice-8 voice mode, slice-9 first_delta. Unit tests 6/6. |
| R3 | **bifrost-net** M0 mesh / M1 relay / V9 P2P bridge / AP access point | **[ran]** `selftest m0`, `m1`, `v9` and `ap` all rc 0, GREEN. `cargo test` 1/1 (the crate's real gates are its selftests). Three warnings, all unused imports/variables. |
| R4 | **ygg-sim** self-improving cycle runner | **[ran]** `cargo test` 11/11. **[claim, file verified]** `lab/ygg-sim/report/cycles/cycle-5.json` (10-06 20:13): 27 ran, 20 pass, 2 break, 1 known, 4 skip, 0 FAIL. The evolution rule (app↔sim pairing 0.6.0↔0.4.0) is present. |
| R5 | **S1 full semantics on the v0.9 line**: short-lived region-bound access tokens, rotating refresh with theft detection, hashed at rest, one-time pairing codes, kill-switch, device cookies | **[read]** `lane2/merge:pwa/lib/devices.ts` (mutex chain + tmp→rename + 0o600 + TTL/refresh/region), `lib/pairing.ts` (HttpOnly SameSite=Strict `bifrost_device`), `lib/admin.ts` (`timingSafeEqual`), middleware rate limit. **[claim]** e2e auth 7/7 and pair-ladder 8/8 rungs (RELEASE-REPORT.md). |
| R6 | **Release-line report is honest** | `lane2/merge:RELEASE-REPORT.md` names the gaps itself: relay not built, LAN HTTPS not built (so no phone mic without tailscale), no real iPhone, no voice over P2P. It also found real seam bugs: the `tokenHash`/`token_hash` mismatch and spoofable XFF fixed via `server.mjs`. This is the best artifact of the run. |
| R7 | **Live :8080 is healthy right now** | **[ran]** home plus 7 chunk assets including `app/session/[slug]/page-*.js` all return 200. `lk-pwa` restarted 19:43, after the 19:30 `.next` build, so there is no ChunkLoadError condition. |
| R8 | **v0.7.0 items on the live line**: wedge-fix, S3 | `5819137` is an ancestor of HEAD. S3 is `7572aaa`: `BIFROST_AUTH=tailnet` is declared in `.env.example`, `token/route.ts:30`, `dispatch/route.ts:17`, `middleware.ts:26`. |
| R9 | **Incident fixes with mechanism proofs** | 300 s undici timeout `40c6037` (live line) / `236b86e` (fix branch). Agent re-arm `49a61e6`. Outage chain `79d53f1`: load gate, brain-drift guard, speech watchdog. agent-dup fix (`agent.py`). Backup nest fix `a81c37a` (on `main` only). |
| R10 | **Injection defense** | `faab05b` + `e97ed0b`: content-is-data and forged-`<system-reminder>` rules are in `~/Work/AGENTS.md` and active in this very session. |
| R11 | **Secrets hygiene in git** | **[ran]** `git grep` over HEAD and `lane2/merge` finds no real `bfnd-`, `sk-ant-`, `ghp_` or `LIVEKIT_API_SECRET=` values (only the fixture `bfnd-not-a-real-token-value`). No `.env*`, `.devices.json` or `.agi-log` is tracked. Repo `veraldar/bifrost` is **PUBLIC**, so this matters. |
| R12 | Worldtree M2–M6, hardwar M4, android-lab | Files present and dated: `lab/worldtree-data/tests/m6_github.sh` (10-06 10:35, commit `9597fe7`), `artifacts/pcb-final-report.html` (570 KB, 10-06 19:56, `580bda5`), `docs/android-lab.md` (6/6). `worldtree-fetch.timer` is enabled; next run 10-07 14:30. |

---

## 2. BROKEN / RISKY — ranked

**P0-1 — Unauthenticated LAN access to a shell-capable brain.**
- `bifrost-sandbox.service` listens on `0.0.0.0:8090`, and `lk-pwa-lan` listens on
  `192.168.1.89:8082`. Both run `BIFROST_AUTH=tailnet`, so the middleware is a no-op.
- **[ran]** From the LAN address with no credentials, `GET /api/session` → **200 with transcript
  previews** on both ports, and `GET /api/models` → 200.
- Both proxy to yggdrasil :4100. Its `tools.rs:49` exposes `bash` ("Run a shell command (bash -c)")
  and no permission gate is configured in `yggdrasil.env`.
- So any device on the home LAN (guests, IoT) can read sessions, and by POSTing a message can almost
  certainly run shell as `dweeb_xyz`. I did not test the POST.
- This breaks the plan invariant "opencode stays tailnet/localhost-only" in spirit. The v0.9
  "no-tailscale" stack is deployed with its own auth layer **off**.
- **Fix tonight:**
  - Bind :8090 to 127.0.0.1 or the tailnet IP.
  - Either stop `lk-pwa-lan` or run it as `BIFROST_AUTH=devices` (with the F1 fix below).

**P0-2 — Two production lines, and the live one runs uncommitted code.**
- Which tree serves what:
  - `lk-pwa` (:8080) and `lk-agent` run from `~/Work/bifrost`: the live line **plus a dirty tree**.
  - `lk-pwa-lan`, `bifrost-bridge` and `lk-agent-ygg` run from `~/Work/lane2-merge`: the v0.9 line,
    which also has its own uncommitted edits to `lab/yggdrasil/src/main.rs`, `messages/route.ts` and
    `token/route.ts`.
  - The sandbox runs from `~/Work/bifrost-sandbox`.
- The live :8080 build (19:30) includes uncommitted fixes:
  - push `urgency:high` + delivery denominator (`lib/push.ts`, `public/sw.js`; claim rung0-push says "DONE… live")
  - the wake-lock/`bvl` effect (`page.tsx` +51; claim rung0-bvl still open)
  - the one-piece TTS "eternal synthesizing" fix (`lib/speech.ts`)
- A `git checkout`/`stash` mishap, or any lane's `git add -A`, silently deletes or misattributes
  production behaviour.
- The two lines diverge by **55 / 42 commits**. A trial merge conflicts on `agent/agent.py`:
  `79d53f1` `load_threshold=inf` vs `2f3006d` `AGENT_LOAD_THRESHOLD` env. These are two fixes for
  the same 10-06 cgroup bug, made by different sessions.

**P1-3 — The `v0.9.0` tag is premature and overclaims.**
- It is an annotated tag, created 10-04 20:24 at `fb911b7`, **not pushed**. No `release/v0.9.0`
  branch contains it; only `lane2/merge` does.
- The tag message claims "+ user-owned relay". RELEASE-REPORT §Skipped-1 says the relay was
  "specified, NOT built". The AP lane (`50f4066`..`21d64ac`) came *after* the tag, and AP-REPORT
  still says "voice media end to end is NOT proven".
- "iPhone auto-setup" ran in Chromium with the iPhone-13 descriptor. WebKit was untested.
- Without LAN HTTPS, the phone has no `getUserMedia`/SW/install off-tailnet. So the release's
  headline, no-tailscale voice, does **not** work on a phone.
- The plan says v0.9.0 is "done when tested on this machine". It is tested on this machine, but
  not for its headline promise.

**P1-4 — Four of the five S1 review fixes are unfinished.** Checked against `lane2/merge`:
- **F1 NOT fixed.** `token/route.ts:30` still `throw`s outside `try` unless `BIFROST_AUTH==='tailnet'`.
  Devices mode therefore 500s every LiveKit mint, and voice is dead in devices mode. The ladder never
  exercised voice in devices mode, so it stayed green.
- **F2 fixed:** the cookie is set at pairing.
- **F3 partial.** The mutex, atomic rename and 0o600 are in. But `readRegistry()` still `catch → {devices:[]}`,
  so one parse failure plus the next `mutate()` **wipes the registry and resets `killEpoch` to 0**.
  That un-kills a pulled kill-switch.
- **F4 implemented.**
- **F5 deviated.** The kill-switch exists, but `adminOrDevice` lets **any** device revoke any other
  device and pull the global kill. The review said admin-only. The code comment justifies it, but it
  is not recorded as a named deviation in plan.md.
- **Other review findings still open:**
  - `startsWith('/api/pair')` prefix.
  - Relative `DEVICES_FILE` default.
  - No SSE re-validation on heartbeat.
  - No "every route → 401" sweep test.
  - `IS_VERCEL_PREVIEW` still set in the live `pwa/.env.local` (dead, but it is the S3 lie, left in place).
- **e2e tokens NOT purged.** The live registry `pwa/.devices.json` holds **68 devices, 59 live**:
  36 `e2e-phone`, 14 `fail-closed-probe`, 5 `e2e-device`, 4 probes. That is up from 52. Each suite
  run against :8080 mints more.
  - They are inert while in tailnet mode.
  - The v0.9 code auto-revokes v1 entries on upgrade ("v1 token — re-pair"), so merging lane2
    neutralizes them.
  - Purge them anyway.

**P1-5 — Nightly verification has been dead for 4+ days and nobody noticed.**
- `lk-verify.service` fails daily (10-03 through 10-06, rc 127): `bash: scripts/record-env.sh: No such file or directory`.
- The unit runs `npm run verify --prefix …/pwa`, so the cwd is `pwa/`, but the script lives at the repo root.
- Its `ExecStartPost` also does `git add docs/environments.md && git commit && git push` **from the
  shared live checkout on whatever branch is checked out**. That is a latent unattended-push hazard
  the moment it starts succeeding.

**P1-6 — The fleet watchdog is blind.**
- `~/.fleet-labs` was overwritten by a simulation fixture (`# sim registry`, `ses_corpseAAAA…`, `ses_quietBBBB…`).
- Every 5 minutes the watchdog 404s on two fake sessions. No real lab is driven, and the last real
  nudge was 18:21 "NUDGE FAILED timed out".
- This is the anti-stall mechanism (stall incidents 3×), and it is currently off.

**P1-7 — Orphaned v0.9 WIP in the live tree breaks the suite and invites a sweep.**
- These files date from 10-04 11:52–12:50 (claim v09-notailscale) and are superseded by the release line:
  - Untracked: `pwa/app/pair/`, `pwa/app/bridge/`, `pwa/e2e/bridge.spec.ts`.
  - Modified: `lab/bifrost-net/src/{bridge,bridge_main,opencode,relay,tokens}.rs` and `Cargo.*`.
  - Modified: `package.json` (`qrcode` dependencies).
- Evidence of supersession: `release:pair/page.tsx` differs by +79/−134. `bridge.rs` is 226/424
  lines off the release version.
- `bridge.spec.ts` is the "1 fail" in the 10-06 rearm suite run (46/47).

**P2-8 — The `git add -A` sweep happened, and its effects are permanent in pushed history.**
- `6405ead` ("run 20261004T081621Z: published", a worldtree data commit) swept **6,475 files** from
  other sessions:
  - the stutter fix (`api/tts/stream/route.ts` +204)
  - ux-mictap (`page.tsx` +162, the 350 ms pill delay)
  - `speech.ts` +168
  - bifrost-net `mesh.rs`
  - the launch/brand/review docs
  - 6,420 synthetic `experiments/halo-memory` files
- None of it was gated as its own change. It is pushed to the public `origin/rebuild/cohesive-opus`.
  Nothing secret is in it (checked).
- Consequence: the ux-mictap code is *in* HEAD but its claim is open. The 300 ms-press regression
  spec it promised does not exist (`voice-ui.spec.ts` has no 300). It is unreviewed code in prod.

**P2-9 — Environment cross-contamination between lanes is the 10-06 outage's real root cause.**
- `79d53f1` documents it: `agent/.env` (gitignored, shared) pointed the **production** agent at the
  **sandbox** brain :4100.
- The fix adds a drift guard. The class (shared mutable host state) is unaddressed, and P1-6 is the
  same class.

**P2-10 — Local `main` is a third line.**
- It is 67 ahead of `origin/main` and 2 behind (`b6d59bd` livekit-bootstrap, `5fca3c6` glm-4.7 e2e).
- It holds `a81c37a` (backup nest fix), which the live line lacks. The dirty `scripts/backup.sh` is
  that same fix re-applied by hand.
- `origin/main` = public v0.6.0 users still carry the 300 s wedge bug (`fix/oc-timeout-300s`
  pushed, not merged). Issue #1 is still open although both halves are fixed.

**P2-11 — Release-ladder items for v0.7.0 are missing.** See §3 M1. Nothing labelled v0.7.0 is complete on either line.

**P3-12 — Stray debris in the repo root.**
- `skidl*`, `dump_json.*`, `render_sch.*`: hardwar KiCad runs with the repo root as cwd.
- `VERSIONS.md`: a misplaced, divergent copy of `lab/ygg-sim/VERSIONS.md`.
- `LANE-B-BRIEF.md`.
- `.agi-log` shows **no measured delegations after 10-04**, although fleet rule 10-04 forbids bare
  `claude -p`. And `scripts/agi-run.sh` / `agi-status.sh`, the rule's own tools, are **untracked**.
  Release-lane runs were logged as loose `*-RUN.log` files in their worktrees instead.

**P3-13 — Stale branches to delete, not merge.**
- `fix/hf-persistence` (10-02, pushed): **contradicts** the later `open-restore` decision ("a session ALWAYS opens in keyboard").
- `fix/telemetry-mode-awareness`: 4/5 already in via the wave; the rest is a claims line.
- `diag/session-ux`: fully merged.
- `fix/voice-stutter`, `fix/voice-switch`, `wave/rebuild`, `release/v0.9.0`: all ancestors of `lane2/merge`.
- Detached worktree `bifrost-rebuild` @ `ab00e73`.

**Open-claim status (stall audit):**

| Claim | Status |
|---|---|
| ygg-sim | Active, real progress: cycle-5 at 20:13 today. |
| worldtree-m6-github | Real progress (`9597fe7` 10-06). Claim not closed. realms.json /var/www cutover still waits on the user's go. |
| hardwar | Active, M4 receipts today. |
| yggdrasil-sandbox | Active (`e440d08` 10-06 19:33). Branch `lab/sandbox` conflicts with the live line on `page.tsx`/`package*.json`. |
| stutter-fix | Code merged in the wave. Waits on the user ear-pass; the claim should say "user-gated". |
| v09-notailscale | **Stale.** Superseded by the release lane; WIP orphaned (P1-7). |
| bifrost-net M1 | **Stale.** Superseded by V9/AP. |
| night-builder | **Stalled since 10-04.** M1/M2 landed (`ceb3724`); M5 onboarding and M6 dawn report never appeared. |
| artifact-meta-v1 | **Stalled on the user since 10-03.** Last touch `29e3d82`, "merge after user validation". |
| ux-mictap | **Silent since 10-02.** Code swept into `6405ead` (P2-8). |
| rung0-bvl | Code live but uncommitted. |
| ios-lab | Correctly BLOCKED=VISIBLE on the Safari remote-automation toggle (user). |
| fleet-lanes | An order list, not a lane. |

**Incidents — fixed vs recurring:**

| Incident | Status | Evidence |
|---|---|---|
| Wedge / turn death ("no reply") | **Fixed ×3 layers**, holding | event-liveness `5819137`; 300 s undici `40c6037`; agent-less room re-arm `49a61e6` |
| Duplicate agent | Fixed | agent-dup (agent.py bounded wait) |
| 10-06 voice outage (load gate, split brain, Mac restart) | Fixed today, plus guards | `79d53f1`; class = shared host state, **recurring** (see P1-6) |
| ChunkLoadError | **Recurring.** Rule 10-03 written, then violated 10-04 19:47 | `docs/android-lab.md:207` |
| Lost or misattributed commits (`git add -A`) | **Recurring risk.** Pathspec fix in one script only; 49 dirty paths in the shared tree today | `6405ead`, P1-7 |
| Driverless stalls (3×) | **Recurring.** The watchdog is blind (P1-6), and two claims are stalled now | `~/.fleet-labs` |
| History rewrite (165 MB blob) | Fixed, unpushed-only rewrite, verified safe | `git log --all -- lab/ygg-sim/target` = 0, pack 13 MiB |

---

## 3. MISSING — needs USER decisions

1. **What is v0.7.0 now?** The ladder has v0.7.0 ("reliable voice") *before* v0.9.0, but v0.9.0 was
   already cut locally and v0.7.0 never was. **Rec:**
   - Delete the unpushed local `v0.9.0` tag (it is free to move).
   - Ship the integrated line as **v0.7.0**: tailnet default, with devices mode/P2P present but
     labelled *experimental, off by default*.
   - Re-cut v0.9.0 only when LAN HTTPS, the relay leg and a real iPhone pass exist.
   - Tagging v0.7.0 on a descendant of a `v0.9.0` tag is semver-incoherent, so the order matters.
2. **v0.7.0 scope tonight.** Still missing on every line:
   - The `streaming_interval` knob: hardcoded `4.0` in `api/tts/stream/route.ts:115,126`, so the
     1.19 s → 0.19 s first-audio win was never taken.
   - The README known-limits iOS line: zero iOS mentions in either README.
   - The ux-mictap 300 ms regression spec.
   - The user's real-speaker A/B / stutter ear-pass (the v0.7 human gate in the AGI review).

   The edge sherpa no-docker default **exists only on the v0.9 line**
   (`lab/yggdrasil/install/install.sh:363-371`); `scripts/bootstrap.sh:151` on the live line is still docker.
   **Rec:** the knob as an env (`TTS_STREAMING_INTERVAL`, default 0.5) plus the iOS line are about
   an hour of AGI work. Do them tonight. Ear-pass is yours, tomorrow morning. Tag after the ear-pass,
   not before.
3. **Device revocation policy.** Should any paired device be able to revoke others and pull the
   global kill-switch? This is the current code; the review said admin-only. **Rec:** any device may
   *kill all* (safety reachable from the hand), but revoke-*others* and list stay admin. Record
   either choice as a named deviation in plan.md.
4. **LAN listener (:8082) — keep it?** **Rec:** stop it until devices mode + F1 + LAN HTTPS exist.
   Until then it is only an attack surface (P0-1).
5. **Push to the public repo.** 130 commits, including the swept `6405ead` (6,420 synthetic files, docs
   drafts, opencode prompt extractions in `artifacts/`). Checked: no secrets. **Rec:** OK to push
   after the wave. Decide whether the extracted opencode prompts (`a9d2444`, `8fd15c2`) belong in a
   public repo.
6. **Worldtree realms.json /var/www cutover.** This has waited on your go since 10-04. **Rec:** go.
   M2–M6 green, timer live.
7. **artifact-meta-v1** has waited on your phone validation since 10-03. **Rec:** accept or kill
   tonight; it is already live.
8. **Backup timers.** Not enabled by design; the last verified snapshot was 10-04. Snapshots are
   plaintext on the Mac (S5). **Rec:** enable the daily timer now, because the shared dirty tree is
   currently the *only* copy of live code. Age-encrypt the secrets set as the next S5 slice.
9. **ops/flip-automation** has 3 commits and conflicts with yggdrasil `main.rs`/`page.tsx`. **Rec:** rebase after the wave, or drop. It is not release-critical.

---

## 4. VERDICT

**Merge wave: NO-GO as-is, GO after six ordered steps (all doable tonight).**
**v0.7.0: cannot be tagged tonight with honest ladder content.** It is ready for a tag tomorrow,
after your ear-pass, if steps 1–6 land tonight. **v0.9.0: the branch is coherent as code (builds,
lab gates and selftests all green [ran]), but the tag is premature.** Demote it: no
off-tailnet phone voice, no relay, no real iPhone, F1 open, and a message that overclaims.

What must land first, in order:
1. **P0 exposure:** bind sandbox :8090 to loopback/tailnet; stop `lk-pwa-lan` (or devices mode + F1). Verify that LAN `GET /api/session` returns non-200.
2. **Freeze lanes and repair the watchdog.** Pause commits to `rebuild/cohesive-opus` during the
   wave. Restore the real `~/.fleet-labs`, and fix the `lk-verify` path (`npm run verify` → repo-root script).
3. **Triage the live tree with pathspec commits only (never `-A`):**
   - Commit: rung0 push/sw, bvl wake-lock, `speech.ts` one-piece fix, `fleet-watchdog.py`, Part 15
     addendum + android-lab docs, the native-eval/roadmap-v2/mini-agi docs, and `agi-run.sh`/`agi-status.sh`.
   - Save the orphan v0.9 WIP to `artifacts/v09-orphan-wip.patch`, then remove it.
   - Drop the dirty `backup.sh` (`main` has it).
   - Move hardwar debris into `hardware/`.
4. **Integrate** `main` → `origin/main` → `lane2/merge` → `lane3/runbook` into the live line. The
   only code conflict is `agent.py`: keep `inf` default + `AGENT_LOAD_THRESHOLD` override + `AGENT_NAME`.
   Also commit `lane2-merge`'s own dirty edits first.
5. **Fix-forward on the integrated line:** F1 (token mint in devices mode), F3 parse-fail no-wipe,
   the `streaming_interval` env knob, the iOS known-limits line, and remove `IS_VERCEL_PREVIEW`.
   Purge the 59 e2e tokens.
6. **Gate on the integrated tip:**
   - Clean-clone build plus tsc.
   - yggdrasil `verify.sh`; bifrost-net `selftest m0/m1/v9/ap`.
   - Full e2e on :8095 in tailnet mode, plus auth/pair-ladder in devices mode.
   - Deploy as build-in-worktree → restart `lk-pwa`/`lk-agent` → chunk probe.

   Then delete the local `v0.9.0` tag. Tag `v0.7.0` after your ear-pass.

---

## 5. The AGI-ceiling question (evidence-based)

**What the run proves the agents CAN do (capability is not the binding limit):**
- Hard root-causing from logs alone:
  - undici's 300 s `headersTimeout` (three runs, each ~300.8 s apart)
  - openrsync not creating dest roots, and BSD `cp -R` nesting
  - a garbage cgroup load metric silently dropping LiveKit dispatches
  - the bridge's `tokenHash`/`token_hash` seam mismatch
  - spoofable `X-Forwarded-For` under `next start`
- Real systems work: a Rust WireGuard-userspace mesh, a str0m SFU, a TLS access point with SPKI
  pinning and a path-normalizing gate, an opencode-compatible server passing 9 verify slices, and a
  self-evolving simulation harness.
- Strikingly honest *body* text: RELEASE-REPORT and AP-REPORT name every gap.

Each of these happened **when a session was pointed at the problem.** Time-to-fix after a pointer
is minutes to hours.

**What fails is procedure and coordination, and it fails the same way every time:**
1. **Nobody owns the integrated whole.** Each lane is locally correct and the system is globally
   incoherent:
   - two production lines
   - two fixes for one cgroup bug that now conflict
   - a tag cut on a side branch
   - five review fixes "handed to" a lane that implemented 2.5 of them and then closed
2. **Shared mutable host state is the dominant incident class.** One working tree serves prod and
   five lanes (the sweep, orphaned WIP, uncommitted prod code). One gitignored `agent/.env` caused
   the split-brain outage. One `~/.fleet-labs` was clobbered by a sim, leaving the watchdog blind.
   One `.next` under a live server caused the ChunkLoadError, twice.
3. **Nobody reads failure that nobody asked about.** `lk-verify` was red 4 days running; the
   watchdog has 404'd every 5 minutes since the registry was clobbered. Agents are reactive: they do
   not perform unprompted global monitoring.
4. **Calibration drifts at the summary layer, not the body.** The tag message and claim headlines
   ("FINAL", "user-owned relay", "DONE… live") overstate what the same sessions' own reports
   concede. Compression into one line loses the caveats.
5. **Rules don't enforce themselves.** Rule 10-03 was broken a day later; rule 10-04 (measured
   delegation) has no log lines after 10-04, and its scripts are untracked. Written procedure without
   a mechanical gate decays within ~24 h.

**Is there a ceiling?** On this evidence, the ceiling is **not** in reasoning or coding. It is in
**unprompted, long-horizon, cross-session state ownership**: noticing what nobody asked about, and
keeping N parallel actors' shared state consistent. The current setup *removes* the structures that
compensate for this: isolation, a single integrator, and mechanical gates. So the run cannot tell a
model ceiling apart from a harness ceiling. My best estimate is that it is mostly harness.

**The experiment that would find it (one week, cheap):**
- **A. Planted-fault detection.** Silently inject 6 faults across the fleet's surface:
  - break a nightly unit
  - flip a bind to 0.0.0.0
  - clobber a registry
  - leave a stale tag
  - add a claim/commit mismatch
  - add a conflicting duplicate fix

  Give every running session its normal work and **no hint**. Measure detection rate and
  time-to-detect. Then rerun with one dedicated **integrator agent** whose only job is a 30-minute
  sweep (git topology, unit status, listening sockets, claims vs commits). If the integrator finds
  most faults within hours and the lanes find none, the limit is role/attention, which is a harness
  problem and fixable. If even the integrator misses faults it was told to look for, that is a
  capability ceiling.
- **B. Isolation A/B.** Run the same two-lane task twice: shared tree and shared host env, versus a
  worktree per lane, an env per lane, and pre-commit pathspec + gate hooks. Count incidents of the
  sweep, split-brain and orphan-WIP classes. A large drop confirms these are procedure limits.
- **C. Calibration audit.** Sample 30 claim lines, then score each headline against its own evidence
  body and against the repo (as this review did). Report the overclaim rate per model and per
  layer: headline vs body. If the bodies are right and the headlines are wrong, the fix is
  a mechanical "claims must cite a commit plus a gate output" rule, not a better model.

---

## MERGE WAVE ORDER (exact sequence I would run)

All of this runs in `~/Work/bifrost` on `rebuild/cohesive-opus`, with lanes paused. Each step is
followed by `git status --short | wc -l`, and the expected result is 0 or the known remainder.

1. **Ops pre-flight, not git:**
   - `systemctl --user stop lk-pwa-lan`.
   - Set `Environment=HOST=127.0.0.1` in `bifrost-sandbox.service`, then `daemon-reload` and restart.
   - Check that `curl -s -o /dev/null -w '%{http_code}' http://192.168.1.89:8090/api/session` is 000.
   - Restore `~/.fleet-labs`.
2. **WIP triage with pathspec commits only:**
   - `git add pwa/lib/push.ts pwa/public/sw.js pwa/lib/speech.ts 'pwa/app/session/[slug]/page.tsx' && git commit -m "rung0 push+bvl, speech one-piece fix (was live, uncommitted)"`
   - Then the same for the docs, scripts and `fleet-watchdog.py`.
   - Then `git diff -- lab/bifrost-net pwa/app/api/token pwa/package*.json > artifacts/v09-orphan-wip.patch`,
     followed by `git restore` on those paths, `rm -r pwa/app/{pair,bridge} pwa/e2e/bridge.spec.ts`,
     and `git restore scripts/backup.sh`.
3. `git merge --no-ff main`: clean in the trial; brings `a81c37a`, the backup nest fix.
4. `git merge --no-ff origin/main`: `docs/claims.md` conflicts; take the union of both sides. Brings `b6d59bd` and `5fca3c6`.
5. In `~/Work/lane2-merge`, commit its own dirty `lab/yggdrasil/src/main.rs`, `messages/route.ts` and `token/route.ts` with pathspec. Back in `~/Work/bifrost`, run `git merge --no-ff lane2/merge`.
   - Resolve `agent/agent.py` to `AGENT_NAME = os.environ.get(...)` plus `load_threshold=float(os.environ.get("AGENT_LOAD_THRESHOLD","inf"))`.
   - Resolve `docs/claims.md` as the union.
   - This brings release/v0.9.0, the wave (stutter, switch, telemetry), AP, install and voice-mode.
6. `git merge --no-ff lane3/runbook`: clean in the trial.
7. **Fix-forward commits:**
   - F1: accept `devices` in `token/route.ts` and move the guard inside `try`.
   - F3: `readRegistry` throws on parse error, but not on ENOENT.
   - `TTS_STREAMING_INTERVAL` env in `api/tts/stream/route.ts`.
   - The README "Known limits: iOS" line.
   - Remove `IS_VERCEL_PREVIEW` from `.env.local` (not tracked).
   - Purge the e2e devices: `jq '.devices|=map(select(.name|test("^(e2e|probe|fail-closed)")|not))'`.
   - Fix the `lk-verify` path.
8. **Gate:**
   - `git clone --shared` to /tmp, then `npm ci && next build`.
   - `lab/yggdrasil/verify.sh`; `bifrost-net selftest m0 m1 v9 ap`.
   - `PW_BASE_URL=http://127.0.0.1:8095 npx playwright test` (tailnet), plus `auth` + `pair-ladder` in devices mode.
   - Then deploy: build in a worktree → restart `lk-pwa lk-agent` → page and chunk probe → push `rebuild/cohesive-opus`.
9. **Converge `main` and push:**
   - `git switch main && git merge --ff-only rebuild/cohesive-opus && git push origin main rebuild/cohesive-opus`.
   - `gh issue close 1`.
   - Delete the merged branches, local and remote (`git branch -d` / `git push origin --delete`):
     `fix/hf-persistence`, `fix/oc-timeout-300s`, `fix/telemetry-mode-awareness`, `diag/session-ux`,
     `fix/voice-stutter`, `fix/voice-switch`, `wave/rebuild`, `release/v0.9.0`, `lane3/runbook`, `lane2/merge`.
   - `git worktree prune`.
10. **Tags:** `git tag -d v0.9.0` (local only; never pushed). After the user ear-pass:
    `git tag -a v0.7.0 -m "v0.7.0 — the reliable voice (+ experimental devices-mode pairing, off by default)" && git push origin v0.7.0 && gh release create v0.7.0 …`.
    Re-cut v0.9.0 later, on LAN HTTPS + relay leg + a real iPhone pass.
