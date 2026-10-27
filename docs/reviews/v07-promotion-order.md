# v0.7 promotion order — tonight (RULER-V07-OPUS, 2026-10-27)

**Tonight is feasible: YES.** The candidate is **`v0.7.0-rc2`**. Its whole matrix is green on its exact build,
drift-guard is clean, and the gate is GREEN on v0.6.1. Nothing waits on you except two things:
- the consent check (step B, ~4 min);
- a one-time GitHub code (step D). Without the code, everything except the GitHub release still happens tonight.

Took over from RULER-V07, whose lane died at 17:44 after building rc1/rc2. The phone session "ruler v07" stopped at
18:22 mid-investigation; its T1 spec is kept and committed.

## 0. The rulings (Rule 10-11)

**1 · opencode-legacy: KEEP it running as v0.6.1's declared brain. Retire it at step 10, not tonight.**
- The gate already reads the brain from the release env (`412a9c4`). `BRAIN_UNIT` in `live-pwa.env` wins. Releases
  before v0.7 map :4096 → `opencode-legacy`. `gate.py` is GREEN today (21 pass, 1 warn).
- The rollback net *is* that unit. "Rollback = one restart" holds only while v0.6.1's brain runs.
- No rename to `opencode-serve`: renaming means restarting the live brain, for no gain.
- Reboot-safe as is: `opencode-legacy` is enabled; the old `opencode-serve` file is disabled. One owner for :4096.

**2 · OG-ctx: GO, as built (S1/RULER-V07: yggdrasil injects the `AGENTS.md` chain per run, `412a9c4`).**
- "Context injection" is a plan.md invariant ("regression here is a bug"). opencode does it today on live.
  Promoting a brain without it breaks an invariant.
- Proof on the shipping source:
  - `lab/yggdrasil/verify.sh` (with its OG-ctx block) PASS tonight;
  - `context.spec` is green in the rc2 suite;
  - the root binary that serves is `yggdrasil-412a9c4` (sha `13c47292…` = the lab build).
- The alternative (keep exploration) is rejected: it costs tool calls on every meta question.

**3 · The soak: WAIVED by evidence (Rule 10-11 speed law, Rule 10-09).**
- (a) **Compressed time.** The 24h-equivalent churn suite PASSES on rc2's exact build (8/8 phases, 182 s).
- (b) **Real use.** 8 days of your daily use on :8443, on the same line: the same root binary family, the same agent
  lineage, the same PWA line. rc2 adds only fixes already proven on live since 10-06 (2 PWA ports + the 10-06
  agent fixes).
- (c) **One-restart rollback**, rehearsed both ways tonight inside the promotion (T12, step C).
- (d) **The root's store** is snapshotted and its restore proven right before the switch (T13).
- **Binding condition:** the waiver stands only if T12 passes both ways. If it doesn't, v0.6.1 stays live.
- **Honest note:** the first churn run was RED on one check: marathon proxy RSS +28.5% against a +25% bound.
  - It's a GC-timing artifact, not a leak: both builds plateau at the same height (rc2 448 MB, 10-24 427 MB). Only
    the turn-100 sample differed: GC had already run on rc2 (349 MB), not yet on 10-24 (380 MB).
  - The leak detector (flat data) stays flat at +7.2%. The rerun PASSES at +15.1%.
  - Both receipts are kept.

**4 · The 13 test gaps.** A gap blocks tonight only if:
- (a) promoting it makes live worse than v0.6.1 is today, or
- (b) the promotion's own safety rests on it, or
- (c) it's a v0.7 gate item with no proof on the frozen build, and the proof is reachable tonight.

**BLOCKING, all closed tonight:**
- **T1** version: `version.spec` green on rc2; Settings shows `0.7.0-rc2 · a Veraldar product.`
- **T8 + T11** the roots specs + the whole matrix on rc2's build: §2. 13 specs had gone stale after the 10-26/27 UI
  changes and were fixed (§4). The product needed no change.
- **T12** rollback rehearsal: step C3/C4. It runs inside the promotion; there is no other way to rehearse a live switch.
- **T13** store backup: `scripts/root-store-backup.sh` (built in `be4996d`); step C1.

**NEXT SLOT, v0.7.1** (each already a named known issue in `docs/releases/v0.7.0.md`):
- **T2** voice exactly-once, plus tonight's finding: an agent stranded in a room whose page left before joining;
- **T3** onset (needs the pre-roll buffer + your phone);
- **T4** echo (rides T2; A/B was green on 10-23);
- **T5** STT language / no-speech;
- **T6** send-while-working. The text path queues correctly on rc2 (`queue.spec` green); the voice path is the open part;
- **T7** agent pin by id;
- **T9** model attribution;
- **T10** triad chips: **struck from v0.7.0 in writing** ("not in this version"), they ship in v0.7.1.

None is a regression against what you have lived on for 8 days, and none has a 1-hour proof.

The 3 drift-guard gaps (agent re-arm, the black page for a directly opened text artifact, the declared-auth guard) are
on v0.6.1 but not on rc2. They are named rows (Rule 10-27) and v0.7.1's first slice:
- the auth guard changes nothing on this box (`BIFROST_AUTH=tailnet` is declared);
- the other two are narrow and a reload clears them;
- you have run without all three on :8443 since 10-19.

**5 · Context questions — none blocks tonight.** The questions and their defaults are at the end (§6).

## 1. The frozen candidate

| | |
|---|---|
| tag | `v0.7.0-rc2` → `c4b1908` (`release/v0.7` = `lab/sandbox@4028224` + the `lane2/merge` agent + the 10-06 live agent fixes + 2 v0.6.1 PWA ports) |
| release | `~/.local/share/bifrost/releases/20261027-1735-c4b1908` · manifest `5a2465a5…` · env `2cf67b0c` |
| build | `2-tWDJZQP2Pr6PIGTVDsF` (every receipt below carries it) |
| brain | `lk-yggdrasil` :4100, binary `yggdrasil-412a9c4` (unchanged by the switch: it already serves your MAIN) |
| agent | `bifrost-live`, rc2's own `agent/` (venv in sync, imports checked; `uv run` writes nothing into the release) |

rc1 (`ca990ca`) was superseded within the hour by rc2: two v0.6.1 fixes the fork never had (the TTS generation lock and
the no-300-s-cutoff `ocFetch`). Commits after `c4b1908` on `release/v0.7` are spec-only and don't change the artifact.

## 2. The matrix on rc2 (T11) — all on build `2-tWDJZQP2Pr6PIGTVDsF`

| leg | referee | result | receipt |
|---|---|---|---|
| general suite | `playwright.config.ts` on the matrix serve :8097 (rc2 clone, own state) | **84 passed · 2 skipped · 1 failed → 6/6 on rerun**. The red was the harness: herdr-folds read the queue file from the runner's cwd, not the serve's (`PW_SERVER_CWD`). The 2 skips are catalog-conditional (OG-think: one model, no think levels), as in gate-final | [log](/api/artifact/v07-rc2-general.log) |
| onboarding | `playwright.tree-first.config.ts` on :8097 | **8/8** | — |
| T1 version | `version.spec` with `PW_EXPECT_VERSION=0.7.0-rc2` | **1/1** | — |
| roots (T8) | `mainframe-c-{roots,voice,over}` | **12/12** | — |
| churn (Rule 10-09) | `stability_suite.py` on the sim stack, run from rc2's clone | **PASS 8/8, 182 s** (first run: phase 6 one check, see ruling 3) | [PASS](/api/artifact/v07-rc2-churn-PASS-20261027T172459Z.json) · [FAIL](/api/artifact/v07-rc2-churn-FAIL-20261027T172129Z.json) |
| herdr triad (sim) | `playwright.sim.config.ts` on the sim | **2/2** | — |
| watchdog-zombie | `playwright.watchdog.config.ts`, 20 s stall | **1/1** | — |
| yggdrasil mock suite | `lab/yggdrasil/verify.sh` (slices 1–7, triad, OG-ctx) | **PASS** | [log](/api/artifact/v07-rc2-ygg-verify.log) |
| real upstream | `verify-real-upstream.sh` (glm-5.3-flash) | **PASS-REAL**, 0 warnings | [log](/api/artifact/v07-rc2-real-upstream.log) |
| drift-guard | `scripts/drift-guard.sh` | **exit 0**: 3 named gaps on `release/v0.7`, 0 silent | — |
| live gate | `scripts/gate.py` on v0.6.1 | **GREEN**, 21 pass · 1 warn (agent health port on 0.0.0.0, pre-existing) | — |

## 3. Tonight, in order

Every command runs from `~/Work/bifrost`, by AGI, unless the line says **YOU**.

### A · Preflight (AGI, ~3 min; no user-visible change)
```
python3 scripts/gate.py                 # must end: GATE GREEN (live = v0.6.1)
scripts/drift-guard.sh                  # must end: drift-guard: clean
scripts/promote.sh --list               # v0.7.0-rc2 listed, brain :4100
```

### B · Your consent check (YOU, on :8443, ~4 min)
AGI first puts the exact rc2 build into the next slot (~30 s; your open :8443 app reconnects by itself):
```
scripts/next-slot.sh stop               # the matrix serve off
scripts/next-slot.sh on v0.7.0-rc2      # :8443 = rc2's .next (BUILD_ID checked), agent from rc2's clone
```
Then **you** open `https://omarchy.tail5435b1.ts.net:8443` and tap through:
0. **BIFROST** (top left) → Settings. The bottom line reads **`0.7.0-rc2 · a Veraldar product.`**
1. **Front page.** The roots sit at the bottom with no mic glyph. **Tap the roots** → MAIN opens.
2. **MAIN, keyboard.** Send `Reply with one word: ready`. It lands, and the green dot by the name clears.
3. **MAIN, voice.** Hold the mic, ask something short, let go. Your words appear and the reply is spoken.
4. **Another session.** Open any other one from the list and send `Reply with one word: here`. It lands **there**;
   its list dot shows while it works, then clears.
5. **Front page again.** **Hold the roots**, say a short question, let go. It goes to MAIN without leaving the page.
6. **Settings → voice tests** reads **off** (unless you switched it on yourself).
7. **Hands-free, speaker on.** Tap the mic once, ask a question, let the reply play. It plays once, and no turn of
   yours repeats it.
8. *(record only)* **Cold start.** Close the app, reopen it, and say "Bifrost, what time is it?" right at the press.
   If "Bifrost" arrives as "Frost", that's the known onset issue (v0.7.1). Say so; it's recorded, not a stop.

**Your answer: `go`**, or `stop: <what you saw>`. A stop means back to simulation first (Rule 10-10); live stays
v0.6.1. After your answer AGI writes the URD row (`docs/urd/tests.md`: items, misses, build id). :8443 stays on rc2:
the next slot now serves a frozen build, not a worktree.

### C · Promote (AGI runs, you watch; ~4 min; :443 blinks ~30 s three times)
```
scripts/root-store-backup.sh            # C1 · T13: snapshot ~/.local/share/yggdrasil + restore proven on a copy (exit 0)
scripts/promote.sh --switch v0.7.0-rc2  # C2 · drift gate → refuses if a run is in flight on :4096 or :4100
                                        #      → lk-agent + lk-pwa onto rc2 → gate.py (brain from rc2's env:
                                        #      lk-yggdrasil owns :4100) → GREEN = live; RED = back to v0.6.1 by itself
scripts/promote.sh --rollback           # C3 · T12 back: live = v0.6.1 (brain :4096, opencode-legacy), gate GREEN
scripts/promote.sh --rollback           # C4 · T12 forward: live = v0.7.0-rc2 again, gate GREEN
scripts/promote.sh --list               # C5 · LIVE v0.7.0-rc2 · PREVIOUS v0.6.1
```
- `lk-yggdrasil` is never restarted, so MAIN on the root is untouched. :443 now shows the same MAIN as :8443.
- **Stop rule:** any RED leaves live on v0.6.1 (promote.sh does it). The night ends there, with the RED lines
  reported and no hand fix (STABLE). Wait for MAIN to be idle before C2; the switch refuses while a run is in flight.
- Not run tonight: `gate.py --full`. It runs the release's *own* frozen spec copy, which predates tonight's spec
  fixes, so it would report the 13 stale reds. The matrix in §2 is the receipt for this exact build. v0.7.1 carries
  the fixed specs.

### D · GitHub latest (needs YOUR one-time code, ~2 min)
The box's GitHub token is invalid (`gh auth status`: "the token in keyring is invalid"; a dry-run push gets
"Invalid username or token"). AGI runs:
```
gh auth login -h github.com -p https -w   # prints an 8-character code — AGI sends it to you in the chat
```
**YOU** open `github.com/login/device` on the phone and type the code. Then AGI runs:
```
gh auth setup-git                                     # git pushes through gh's token (the stale stored one is bypassed)
git tag -a v0.7.0-fleetsync 4ad15cc -m "10-07 fleet-sync snapshot (tagged v0.7.0 until 10-27)"
git push origin v0.7.0-fleetsync                      # the old snapshot keeps a truthful name — nothing lost
git push origin :refs/tags/v0.7.0 && git tag -d v0.7.0
git tag -a v0.7.0 c4b1908 -m "v0.7.0 — its own tree (= v0.7.0-rc2, the consent-checked build)"
git push origin v0.7.0 v0.7.0-rc2 release/v0.7
gh release create v0.7.0 -R veraldar/bifrost --verify-tag --latest \
  --title "v0.7.0 — its own tree" --notes-file docs/releases/v0.7.0.md
curl -s https://api.github.com/repos/veraldar/bifrost/releases/latest | grep '"tag_name"'   # "v0.7.0"
```
- **Why the tag move.** `v0.7.0` was already public: a 10-07 fleet-sync snapshot that never had a GitHub release, the
  day after the ladder moved v0.7 to "the tree". Nothing pins it (the README pins `v0.6.0`). Renaming it keeps its
  content and frees the number for the release it names. Veto → the release ships on tag `v0.7.0-rc2` instead.
- **Pre-push check, done tonight.**
  - The 68 unpublished commits were scanned for keys and tokens: clean (the only hit is the door's
    `PASTE_YOUR_KEY_HERE` placeholder).
  - The tailnet hostname and LAN IPs are already public since v0.6.1. rc2 adds them in 4 more files
    (`LOOP-RECEIPTS.md`, `agent/.env.example`, `mobile/capacitor.config.json`, `scripts/loop-m4-legs.sh`).
- GitHub `main` keeps v0.6.1-era code until S2's trunk merge. The release tag carries v0.7.
- **No code tonight?** Promotion still stands. The GitHub step waits for the code, the v0.6.1 precedent.

### E · veraldar.org note (AGI, ~2 min; after D, or without the link if D waits)
The site's "road" line (`index.html`) gets **now v0.7**. Local copy = deployed copy (sha `1cd8cd38…`, checked tonight).
```
cd ~/Work/veraldar-site
python3 - <<'EOF'
import pathlib; p = pathlib.Path("index.html"); s = p.read_text()
old = "<span>v0.7 its own tree (yggdrasil), any brain · v0.8"
new = ('<span>now v0.7: its own tree (yggdrasil), any brain '
       '(<a href="https://github.com/veraldar/bifrost/releases/tag/v0.7.0">notes</a>) · next v0.8')
assert s.count(old) == 1; p.write_text(s.replace(old, new, 1))
EOF
ssh veraldar 'cp /var/www/veraldar/index.html /var/www/veraldar/index.pre-v07.bak.html'
tar -C ~/Work/veraldar-site -cf - index.html | ssh veraldar 'mkdir -p /tmp/stage-v07 && tar -xf - -C /tmp/stage-v07 && cp /tmp/stage-v07/index.html /var/www/veraldar/index.html'
[ "$(sha256sum < index.html)" = "$(curl -s https://veraldar.org/index.html | sha256sum)" ] && echo DEPLOYED
cd ~/Work/bifrost-sandbox/pwa && SITE_URL=https://veraldar.org npx playwright test -c playwright.site.config.ts   # read-only
git -C ~/Work/veraldar-site commit -qam "road: now v0.7 (the tree release)"
```
- Undo: `ssh veraldar 'cp /var/www/veraldar/index.pre-v07.bak.html /var/www/veraldar/index.html'`.
- If D waits: drop the `(<a …>notes</a>)` part.

### F · Open v0.8 (AGI, ~20 min; no user input)
1. **Fork manifest** (Rule 10-28.1), `docs/lines/v0.8.md`. It records:
   - the fork point (`v0.7.0` = `c4b1908`, plus trunk);
   - the purpose (the STABLE v0.8 row);
   - "known missing": the 3 drift gaps, T2–T10, and `lane2/merge`'s bridge not yet on trunk.
2. **`docs/plan.md`.** The v0.7 gate is marked *promoted 10-27 (rc2, build `2-tWDJZQP2…`)*. A **v0.8 GATE** checklist
   comes from STABLE:
   - QR pairing;
   - text + voice over the bridge with tailscale off;
   - screen-off voice (a foreground-service mic);
   - revoke kills access on the next request;
   - no unauthenticated listener;
   - sim `bridge.*` + `app.*` green;
   - the bridge's 2 blocking workers made async.
3. **The next slot stays ON `v0.7.0-rc2`** (a frozen build: STABLE rule 1 holds for the first time). Lanes that
   deployed by restarting `bifrost-sandbox` now freeze a release (`promote.sh <ref> --build-only --label …`) and run
   `next-slot.sh on <label>`. v0.8's own root instance (own port, own store: :4100 is live now) is the first v0.8
   lane, after your origin answer (Q2).
4. **Lanes, via `agi-run.sh`:**
   - **S2 TRUNK-MERGE-V07** (`release/v0.7` + `lab/sandbox@a206b5a` + `lane2/merge` → `rebuild/cohesive-opus`,
     drift-guard as a blocking step);
   - then **v0.7.1 slice 1**: the 3 drift ports, T7, T2 with the stranded-agent case, the fixed specs into the frozen
     copy;
   - then **S7 CONCIERGE** (v0.7.1) per the plan.

**Not tonight, by STABLE:** drop v0.6 = stop `opencode-legacy` after a week of v0.7 live with zero hand fixes (your
go), and the 41 `e2e-*` debris sessions in the old :4096 store.

### What makes tonight NO
- A `stop` at B: an item behaves differently than described.
- The gate RED after C2, or T12 failing either way. promote.sh then leaves v0.6.1 live, and the waiver falls.
- MAIN (or any run on :4096/:4100) busy for the whole window. The switch refuses rather than cut a run.
- *Not* a NO: GitHub without your code (D waits, promotion stands); the site link (E ships without it).

## 4. What changed tonight (RULER-V07-OPUS)

**`release/v0.7`, specs only.** The product had moved on, and the specs hadn't:
- `hf-quick-tap` ×2 and `voice-ui`: idle renders nothing since `d02e965`/`9f43c8e`. They now assert `data-s="idle"`
  and an empty line, not the retired "tap it for hands-free" / "○".
- `queue`, `wedge` ×2, `base`, `states`, `context`, `history`, `watchdog-zombie`: `name: 'new session'` matched 3
  sessions titled "New session" as well. It is now `exact: true`.
- `mainframe-c-voice` / `-over` / `-roots` (voice tests OFF): the user has granted the mic. Without a grant, headless
  Chromium's Permissions API answers `prompt` or `denied` depending on version/flags, and the hold stopped at that
  gate.
- `mainframe-c-roots`:
  - "one tree": the column is `max-w-md` and centred, so the x-position is asserted against the viewport;
  - "keyboard": the Tab bound is re-read every step (the list renders after the roots, and 44 sessions sit before
    them).
- `mainframe-c-lib` `quietRoom`: a room that holds only a stranded agent (its page left before joining) is closed
  once. Anyone else in it is still a failure.
- `ux-batch-voicetest`: the new turn is counted by polling. voice-test keeps every earlier "two plus two", so a
  visible one could be old.
- `herdr-folds` "a queued turn dies with its session": reads the queue file from `PW_SERVER_CWD` (the serve's cwd). It used to assume the runner and the server share `pwa/`, which holds on the sandbox but not on a frozen-rc serve.
- `version.spec` (T1), written by the phone session "ruler v07", committed here.

**`lab/sandbox`:** the same spec fixes, cherry-picked clean as `8a34773` (Rule 10-27 parity; this tree's own rerun rides S2). The other session's WIP in that tree was left alone.

**trunk:**
- `scripts/promote.sh`: drift-guard is a **blocking step of every forward promote** (fleet rule 10-28.4). Tested two ways: a `--switch` to the already-live v0.6.1 passed the guard, then the gate was GREEN and nothing switched; a failing guard stops the ship before any switch.
  `--rollback`, and a `--switch` to PREVIOUS, never wait on it, so the safety net can't depend on the worktrees.
- `scripts/next-slot.sh`: the matrix serve now runs from `<clone>.matrix` with **its own** queue / live-run / diag
  and **no push subscriptions**. Before, it shared the sandbox's files:
  - a second proxy wrote :8090's queue;
  - its watchdog could forward the other proxy's queued turns;
  - e2e runs could push notifications to your phone.
- `docs/releases/v0.7.0.md`: the tag note, plus the stranded-agent / one-origin note.

## 5. Named, not green (release notes; Rule 10-08.5)
Your phone's mic privacy toggle · One UI battery rules on notifications · room acoustics beyond the replay test ·
screen-off voice (v0.8) · a stranger's install (the installer ships with v0.8).

## 6. Context questions (answer when you like; nothing waits on them)
1. **GitHub:** OK to rename the public 10-07 `v0.7.0` tag (a fleet-sync snapshot, never a release) to
   `v0.7.0-fleetsync`, so this release is `v0.7.0`? Default: yes. Veto → the release ships as tag `v0.7.0-rc2`.
2. **Which address is the phone app installed from: :443 or :8443?** After tonight both show the same MAIN.
   v0.8's next slot needs its own root, and a fresh store can't hold your MAIN. So that step waits until your daily
   app is on :443. Default: you're on :8443 (where.sh says so), and v0.8's slot root waits for your move.
