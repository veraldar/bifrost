# RETROSPECTIVE 10-29 — what happened, why nothing moved, how it stops happening

Written 2026-10-29 ~20:00 CET by the RETROSPECTIVE lane (sonnet 5.5). Read-only on the system: nothing was restarted, promoted, pushed or moved. Every claim carries its evidence (command or file). `[U]` = unverified / inference.

## 0 · Where the brief's facts differ from the record (read first)

The mission's CONTEXT block is partly contradicted by the logs. These matter because the fix depends on the true cause.

| brief says | the record says | evidence |
|---|---|---|
| "NO wave ran 10-27 evening → 10-29" | Waves ran on 10-28: TOOL-SCOPE (opus, 59 min, OK) and PROVIDER-WAVE (opus, 62 min, OK). The root also deployed itself at 11:00 on 10-29, and layman-deploy P1 landed. What did NOT run: anything between 10-28 21:38 and now except those. | `.agi-log/log.tsv` rows 20261028T173421Z, 20261028T193622Z; `journalctl --user -u lk-yggdrasil` 11:00:20 |
| "root silent since 10-28 evening, quota resets 03:44" | The root was silent ~20:23 → 20:41 on 10-28 (empty assistant turns while z.ai returned 429/1310), then answered ("back", 200). It answered again 10-29 06:58 and every turn after. Silence ≈ 18 min, not a night. The 03:44 reset was the root's stated estimate; the quota came back earlier. | root session ses_770b…, messages 10-28 20:23–20:41, 10-29 06:58 |
| "the user was away 2w" | The root session shows the user active 10-28 15:51 → 10-29 19:37 (dozens of turns), and urd has a user verdict on 10-14. The only genuine two-week hole is **10-05 → 10-18**: agi-log has zero rows, git has 1 commit/day, all of them the worldtree timer's `run …: published`. | `git log --since=2026-10-09 --until=2026-10-19`; log.tsv gap 10-04 → 10-19 |
| "lk-yggdrasil STOPPED 7h" | True, and worse than a quiet stop: 11:50:07 → 19:34:57 (7 h 45 min). The journal has **no "Stopping" line and no exit status** at 11:50:07, only `Consumed … 49min` and the PWA proxies logging `event stream lost: aborted` the same millisecond. It was not a promotion rehearsal (the last rehearsal was 10-27 17:26). Cause **unknown** `[U]`; it died, and `Restart=on-failure` does not restart a clean exit. | `journalctl --user --since "10-29 11:49:55"`; `~/.config/systemd/user/lk-yggdrasil.service` |
| ":443 was flipped to rc2 — user expected v0.6" | Correct. 10-27 17:36 `promote.sh` made rc2 LIVE with v0.6.1 as PREVIOUS. The plan always said the consent door was :8443; the promote went through anyway because the user's 9-tap consent check is still an open URD row. | `where.sh` VERSION; urd open rows |
| "GitHub last commit 10-10" | `origin/main` = `2c0f65c`, 10-10 09:43. Local HEAD is **78 commits ahead**. The cause is auth, not inactivity (see §4). | `git rev-list --count origin/main..HEAD` = 78; `gh auth status` |

Consequence: the failure was not "nothing ran for two weeks". It was **three different silent failure modes stacked**: quota, a dead driver, and dead auth. Each one stayed invisible because the only failure surface was the phone.

## 1 · Chronology (honest)

| when (CET) | event | evidence |
|---|---|---|
| 10-04 → 10-18 | The real hole. Last lane 10-04 20:35 (SCREEN-OFF-PROBE). 14 days of zero lane runs; worldtree commits only. User verdict "v0.7 root test FAIL" lands 10-14 and 3 diagnostics are dispatched, but no lane runs until 10-19. | log.tsv; urd 746e439 |
| 10-19 → 10-26 | Wave burst: ONBOARD-GAPS/BUILD/UX, DOOR-V3, FILM, UX-BATCH, V07-GATE-FINAL, MAINFRAME, ARTIFACT-PLUMB. Two rows reaped DEAD ("wrapper gone while RUNNING") 10-27 12:20. | log.tsv |
| 10-27 06:33–08:55 | V07-REFLECTION Q8–Q10 + HF-CLICK, all OK. | log.tsv |
| 10-27 12:16–14:03 | S4/S5/S6/S14/S17 (sonnet) + THEME-PORT, OK. | log.tsv |
| 10-27 15:39, 16:20 | UX-SPACING FAIL ×2 in 5 s: **"You've hit your session limit · resets 5:10pm"**. The third try ran 17:14 and passed. | outputs/20261027T143908Z…txt |
| 10-27 17:26–17:36 | RULER-V07: root promoted to rc2, :443 flipped, rollback rehearsal BACK+FORTH green ×2. | URD row; lk-yggdrasil journal 17:26:29 |
| 10-27 19:31–20:18 | **Four lanes die the same way**: UX-CALM (47 min, lost), DRAIN-DRIFT (30 min, lost), YGG-VS-OC (10 min): "session limit, resets 10:10pm". Longest lost work: ~1.5 lane-hours. Nothing re-queued them. | outputs/…202305, …225937, …273614 |
| 10-27 20:18 → 10-28 06:52 | Nothing dispatched for 10 h. | log.tsv |
| 10-28 06:52 | Three lanes at once (ROOT-CONTRACT, TRUNK-APK, V06-BRIDGE) all FAIL in 5 s: **"Failed to authenticate: OAuth session expired and could not be refreshed"**. A second, different outage (claude login, not quota). Fixed by the user re-logging in `[U]`; the three briefs were not re-run by any driver (V06-BRIDGE's import was later done through the root's own sub-session). | outputs/20261028T055259Z… |
| 10-28 17:34–19:33 | TOOL-SCOPE OK. | log.tsv |
| 10-28 ~20:23 | z.ai quota 429 (code 1310): the root answers with **empty messages** (nine `?`/`yo?` from the user). The root was healthy (`/session` 3 ms); the UI had no way to say why. | root session 20:23–20:35 |
| 10-28 20:36 | PROVIDER-WAVE launched **twice** (…2208543 and …2210459). The first finished OK 21:38; the second is still `RUNNING` 23 h later (dup, no reaper). | log.tsv; where.sh "STALE?" |
| 10-28 12:56 and 10-29 12:56 | lk-verify's `git push` fails: `Invalid username or token`. Unit "failed" in both days' journals. | `journalctl --user -u lk-verify` |
| 10-29 07:45 | User asks why AGI is idle. Honest answer: **nothing was queued**; every dispatched mission had landed and the next steps were gated on user review. | root session 07:45 |
| 10-29 08:04 | Root deploy watcher fires, deploys 885122c, **rolls back a good deploy** (its own gate-read had a shell bug). | root session 10:21; journal 08:04:16/23 |
| 10-29 11:00 | Fixed watcher flips the root to 885122c (provider system + error turns + tool profiles). Gate GREEN 21/0. | journal 11:00:20 |
| 10-29 11:50 → 19:34 | **lk-yggdrasil down 7 h 45 min**, cause unlogged. The gate reads brain-down as a warn. Nobody saw it until the user opened the phone. | journal |
| 10-29 19:37 | User raises the GitHub/veraldar mess; repo-reshape dispatched; `gh auth` found dead. | root session 19:37 |

### The exact gap (why the chain died)

There is **no enabled thing that launches a lane**. Verified now:
- `fleet-watchdog.timer` → `is-enabled: disabled`. `agi-reap.timer` → `not-found` (the unit file sits in `scripts/`, never installed). Only 3 timers are active: `push-audit` (new, today), `lk-verify` (failing), `worldtree-fetch`.
- `pgrep -af 'ygg-driver|fleet-watchdog|agi-chain'` → nothing running. `ygg-driver.sh` is a detached `while true; sleep 900` loop pointed at an old opencode session (`:4096`); it is not a unit and does not survive a reboot.
- `agi-chain.sh` is correct by design ("when X is done, launch Y — and it STOPS", expiry, never on red). That is exactly what killed the chain: the 10-27 evening fails were *red upstreams*, so every downstream `-w` waited out its expiry or stopped. Nothing retries a lane that died on quota/auth.
- Doctrine law 4 ("active driver or death … 3 strikes escalate") is written in `docs/veraldar-doctrine.md` and **has no implementation** on omarchy. The Thor fleet's driver (19 delegations/night) never had a counterpart here. The roadmap review calls Squid "named, never built".
- Every lane is launched by a human prompt or the root session's judgement. When the user is in the chat, work flows. When they leave, nothing is prompted. That is the single root cause behind the 10-05→10-18 hole and the 10-28 night.

### Breaks that went unfixed (open now)

| break | since | evidence | fix lives in |
|---|---|---|---|
| GitHub push auth dead (gh keyring token invalid) | ≥ 10-28 (earlier unknown) | `gh auth status`; lk-verify journal | §4, needs user |
| `lk-verify` fails daily (7 e2e passed in 27.9 min, then push 128) | ≥ 10-28 | where.sh LABS; journal | §3 / §7 |
| lk-yggdrasil unexplained stop; no auto-restart for a clean exit | 10-29 | journal | §3 |
| Dup PROVIDER-WAVE row RUNNING 23 h, RULER-V07 RUNNING 50 h (rows never reaped) | 10-27/28 | where.sh "STALE?" | install `agi-reap.timer` |
| `ygg-sim` (cycle 7 = 10-07), `voice-lab` (10-04): no driver | 10-07 | where.sh LABS | Squid |
| Next slot (:8443 = rc1) is **behind** live (rc2) | 10-28 | where.sh two-roots line | §2 |
| 4 prompts lost to quota (UX-CALM, DRAIN-DRIFT, YGG-VS-OC, UX-SPACING ×2) and 3 to OAuth (ROOT-CONTRACT, TRUNK-APK, V06-BRIDGE) never re-run | 10-27/28 | log.tsv | Squid: re-queue on red-by-infra |
| Open URD rows: first conversation with root; STT leg FAIL; rc2 consent check; promote receipt | 10-06…10-27 | where.sh NEXT | user + wave |
| 78 commits unpushed; `docs/metrics/`, `scripts/metrics.py`, 30+ prompts, 9 reviews all **untracked** | 10-29 | git status in session header | §4, §7 |
| Mac SSH: `Connection refused` (host up, sshd off, Remote Login off) | ≥ 2w | `ssh mac true` → refused (not timeout) | §6 |

## 2 · MAJORS-PARALLEL — the architecture

**Law (user 10-29):** every major is its own running root//stack. :443 is **always** the stable. Promotion is the user's validation, not a script's.

### 2.1 Ground truth today
- Two PWA builds, **one brain.** `:8080` (lk-pwa) serves rc2 and `:8090` (bifrost-sandbox) serves rc1, but both proxy to the root `:4100`. Only v0.6.1's own release env points at opencode `:4096` (`opencode-legacy` is active). So "v0.6 stable" is one `promote.sh --switch v0.6.1` away and already rehearsed green ×2 (URD 10-27).
- Tailnet map (`tailscale serve status`): `:443 → 8080` (+ `/livekit → 7880`), `:8443 → 8090`. Nothing else.
- `promote.sh` models **time** (current / previous / next) via `--rollback`, `--switch`, `--next <label|off>` and the TWO-ROOTS LAW (:443 ≠ :8443 build). It has no concept of two *lines* running at once.

### 2.2 Port map (stable, one row per major; reserved, not reassigned)

| major | tailnet URL | PWA | brain | voice agent | state |
|---|---|---|---|---|---|
| **v0.6** (stable) | `:443` | `:8080` | opencode `:4096` | `bifrost-live` | **owns :443 always**; only patch releases (v0.6.x) |
| **v0.7** | `:8443` | `:8090` | yggdrasil `:4100` | `bifrost-ygg` (`lk-agent-ygg`) | what the user lives on today |
| **v0.8** | `:9443` | `:8100` | yggdrasil `:4110` | `bifrost-v08` | reserved; opens when v0.7 is validated |
| candidate (next evolution **inside** a major) | `:10443` | `:8110` | the major's brain, or a scratch root `:4111` (sim stack `scripts/sim-stack.sh`) | `bifrost-cand` | the consent door; replaces "next slot = :8443" |

- Each origin has its own mic/notification/storage (already true for :443 vs :8443), so no cross-major state bleed. Ports `:4101–:4124` stay scratch (tool-scope sims used :4121–24); `:8096` is the sim PWA.
- Tailscale gives only 443, 8443, 10000 (serve/funnel limit) as HTTPS ports `[U]` — **verify before committing to :9443/:10443**; if refused, serve v0.8 and the candidate on path prefixes behind one reverse proxy (`/v08`, `/cand`) with a per-origin storage prefix. This is the one real design risk in the map.
- Brain isolation: the v0.7 and v0.8 roots share one invariant, `~/.local/share/yggdrasil` store. v0.8 gets its **own store dir** (`YGG_DATA=…/yggdrasil-v08`), fed by a one-way snapshot copy, never a shared write path.

### 2.3 What changes in `promote.sh`

| stays | rebuilt |
|---|---|
| frozen releases under `~/.local/share/bifrost/releases/<ts>-<sha>` with `RELEASE.json`, build + env | `--line <v0.6\|v0.7\|v0.8\|cand>` — each line has its own `current` / `previous` pointers and unit set (`lk-pwa@v07.service` template units) |
| the gate (`gate.py`, 21 checks) and RED→auto-rollback | gate takes `--line`; probes that line's port + brain only |
| backup before switch (`root-store-backup.sh`, 29/29 restore) | the **TWO-ROOTS law generalises to "no two lines share a build"**; the `--next` flag becomes `--cand` |
| drift-guard (rule 10-28.4) | **`:443` guard**: `promote.sh` refuses to point :443 at anything not tagged `stable` unless `--user-validated <urd-row-id>` is given, so 10-27 cannot repeat |
| `--rollback` semantics inside a line | `where.sh` prints the port table above, one row per line |

Communication between lines is **grove lanes** (Q8 in the reflection): each root exposes the same small read API (`GET /health`, `/version`, `/metrics`), and lines exchange *letters* (async one-way messages, never shared state) via a directory `~/.local/share/bifrost/grove/<line>/inbox/`. Today the grove is a doc (veraldar-doctrine "sap"); building the inbox is ~1 lane.

### 2.4 The trend instrument (majors over time)
S14 exists, is better than the brief assumes, and is **uncommitted**: `scripts/metrics.py` (CLI `append/backfill/report/month`), `docs/metrics/` (27 waves backfilled), `scripts/test-metrics.sh` 25/25 green, `artifacts/metrics-2026-10.svg`. But **only 1 of its 6 metrics is collected** (e2e pass rate); flake rate, voice round-trip, wedge count, gate items green and session uptime read "— not collected" (`docs/reviews/s14-metrics-ledger.md`). So the answer to "why did the trend instrument not exist" is: it was built 10-27 and left half-wired and untracked, with no timer feeding it.
Spec to revive it for majors:
1. Add the dimension `line` to every row (`v0.6`, `v0.7`, `v0.8`); the report prints one column per line.
2. A **nightly probe timer per line** (cheap, no LLM): gate-items-green, `/health` latency p50/p95, session uptime (probe every 5 min → % up), one scripted text turn round-trip, wedge count from `.diag`.
3. A **weekly sim run per line** on the sim stack: voice turn, churn suite, e2e with `--retries=1` for the flake rate. The Playwright JSON → `append --from playwright` adapter exists.
4. The ledger and chart are **committed on every run** (S14 files joined to `push-audit`), so a missed week is visible as a hole.
5. Decision rule: a line is promoted only when its 14-day trend is ≥ the stable's on gate-green and uptime and ≤ on round-trip p95.

## 3 · AWAY-MODE — the self-driving system

**Design rule:** the system must make progress and stay safe with *no* user and *no* coordinator session. Everything below is deterministic shell + systemd (no LLM scheduler), per the 10-27 Squid ruling.

### 3.1 Squid v0 — a declared schedule
- A file `docs/schedule.tsv` (the declared truth): `id | cron | lane brief | model | max_runtime | retries | class`. `class` ∈ `nightly | weekly | on-red | oneshot`.
- ONE systemd user timer, `squid.timer` every 15 min → `scripts/squid.sh`: reads the file, runs due rows through the existing `agi-run.sh` (it already writes log.tsv, detaches, handles stall), enforces **concurrency ≤ 2**, a **daily lane budget**, and a **catch-up-once** policy on missed slots (a laptop asleep 3 days gets ONE catch-up per row, not three).
- **Retry on infra-red**: if a lane fails with `session limit` or `OAuth session expired` within 10 s (the two real signatures from log.tsv), re-queue it after the printed reset time (parse "resets 5:10pm"). This alone would have saved UX-CALM, DRAIN-DRIFT, YGG-VS-OC, UX-SPACING ×2, ROOT-CONTRACT, TRUNK-APK, V06-BRIDGE.
- Install the pieces that already exist: `agi-reap.timer` (not installed), `fleet-watchdog.timer` (**enable after reading what it does** — I did not read its body; it appears to be the revive-corpses loop `[U]`).
- `loginctl show-user $USER -p Linger` must be `yes` or none of this survives a logout `[U]` — check, do not assume.

### 3.2 What runs regardless (proposed schedule)

| cadence | job | exists? |
|---|---|---|
| every 5 min | `heal.sh` (3.3) + heartbeat push (3.4) | to build |
| every 15 min | `squid.sh` (dispatcher) | to build |
| nightly 04:17 | `push-audit` (unpushed count → ledger) | **exists (new today)** |
| nightly 02:30 | metrics probes per line (2.4) + backup (`backup.timer`, `root-store-backup.sh`) | backup exists; probes to build |
| nightly 14:30 | worldtree-fetch | exists, healthy |
| daily 12:00 | lk-verify e2e — **move it off trunk**: it commits and pushes into the worktree (locations-audit flagged this) and is currently failing | exists, broken |
| weekly Sun 03:00 | sim sweep per line; ygg-sim cycle; docs-archive sweeper (§4.4); dependency/CVE check | to build |
| weekly | letter digest of the week (3.4) | to build |

### 3.3 Self-healing (the brain down → auto-restart + surface)
- `lk-yggdrasil.service`: `Restart=on-failure` → `Restart=always`, `RestartSec=5`, `StartLimitBurst=5/300s`. A clean exit (what 11:50 most likely was `[U]`) is then also revived. **This edits a live unit**, which AGENTS.md forbids by hand; it needs one explicit user go (see §8) and is then a gated drop-in via the env-only promote path.
- `heal.sh` (timer, 5 min): `curl :4100/session` → if down 2 probes in a row and `systemctl --user is-active` ≠ active → `systemctl --user restart` that unit, **max 3 per hour**, every action appended to `~/.local/state/bifrost/heal.log`. After 3 strikes: stop healing, write the `AWAY-HALT` marker (3.5). Same for `lk-pwa`, `lk-agent`, `bifrost-bridge`, `opencode-legacy`.
- The gate must treat **brain-down as RED**, not warn, for the line that owns :443 (a stable with a dead brain is not stable).
- Quota/OAuth: probe the provider with a 1-token call each hour; if 429/401, write `provider: down, until <time>` to the status file and stop dispatching lanes that need it (the 10-28 PROVIDER-WAVE banner already shows the same state to the phone).

### 3.4 The failure surface (WHERE it shows when the phone can't reach)
The phone's only path is tailnet → this machine. If this machine or tailnet is the failure, **the surface must live elsewhere**. Proposal, in order of cost:
1. **Heartbeat on veraldar.org** (already reachable: `ssh veraldar`, tar-over-ssh deploys work, site was updated 10-29 13:34). Every 5 min `heal.sh` pushes `status.json` (`{ts, lines:{v0.6:ok,v0.7:ok}, brain, provider, last_lane, unpushed, halt}`) to `/var/www/veraldar/status/`. A static `veraldar.org/status` page renders it and turns **red when `ts` is older than 15 min**, which catches machine-down and network-down, the cases nothing on the box can report. No secrets in it.
2. **Push notification on a state change** (red / halt / recovered). Channel is the user's choice: ntfy.sh topic (no account), email (the user's address is known to the harness), or Telegram. `[U]` which they have on the phone; default = ntfy topic with a long random name.
3. **Daily letter digest**: one markdown file per day (`artifacts/digest-YYYY-MM-DD.md`, shown in the PWA gallery on return) — lanes run/failed, commits, unpushed count, heal actions, what is waiting for the user. Mac Letters is the eventual transport (unread, §6).

### 3.5 Escalation → the safe stop
- Strike counter per failure class in `~/.local/state/bifrost/strikes.json`. 3 strikes of the same class → the matching job pauses and the status page says why.
- **AWAY-HALT** (written on 3 strikes, or provider down > 6 h, or push auth dead > 24 h, or disk > 90 %): `squid.sh` stops dispatching; `promote.sh` refuses anything except `--rollback`; `deploy-root-when-quiet.sh` is disabled; **no network-facing change, no spend, no force-push, ever, while halted**. Reads, probes, backups, heal-restarts stay on. A single file `rm ~/.local/state/bifrost/AWAY-HALT` resumes.
- Autonomy ceiling while the user is away: lanes may build, test, simulate, commit locally, push branches, write reports. They may **not** promote a major, touch :443, change DNS/VPS, delete data, or rotate keys. (The 10-29 11:00 self-deploy of the root is the precedent for the *line below* this ceiling: gated, quiet-window, auto-rollback. It was acceptable because the user was present and asked for it; away it stays gated by AWAY-HALT.)
- The user-unreachable state is detected by absence: no phone `last_seen` > 72 h → digest-only mode (fewer lanes, no new missions, existing schedules continue).

## 4 · STORY COHERENCE — veraldar.org vs GitHub vs the repos

### 4.1 What is true now
- **veraldar.org**: live and fresh (landing last changed 10-29 13:34, repo `~/Work/veraldar-site` HEAD `a571a00`).
- **GitHub**: `veraldar/bifrost`, **one** repo, `origin/main` = 10-10, tags stop at v0.3.1, `gh release list` → 401 Bad credentials. 78 local commits unpublished. A second remote-less repo `~/Work/yggdrasil` is in `scripts/push-repos.txt` with "no remote configured".
- **The naming** (`docs/brand/brand.md` §1 header): the 09-30 map ("roots = the network, yggdrasil = the trees, bifrost = bridges") is **superseded for public copy since 10-22 by `naming-ladder.md`**: root = the tree's brain, trunk = the private line, branch = bifrost (the app in your hand), yggdrasil = the tree. The glossary in `~/Work/CLAUDE.md` adds veraldar = world, bifrost = the bridge on the phone, wells = mimir/urd/hvergelmir. The brand book itself still carries both versions — that is the incoherence a reader hits.
- One monorepo named `bifrost` holds the root (`lab/yggdrasil`, Rust), the trunk (`pwa/`, `agent/`, `deploy/`), the labs, the bridge (`lab/bifrost-net`) and 30 prompts. The org says veraldar → yggdrasil → (root, trunk, branches); the repo says the opposite.

### 4.2 One roadmap, one name set
1. **One roadmap file** `docs/roadmap.md` (≤ 1 page): the majors ladder (v0.6 stable / v0.7 / v0.8 bridge+tokens+APK / v0.9 bridge-first / v1.0 grove), with the date of each promote. `docs/plan.md` (193 lines, mixes 09-26 base items with 10-29 laws) shrinks to *this week's board* ≤ 60 lines. `STABLE.md` stays as the release contract. veraldar.org's roadmap section is generated from `roadmap.md`, not hand-copied.
2. **One vocabulary** table at the top of `brand.md`, replacing the 09-30 lore block with the naming-ladder one; delete the "Public copy since 10-22…" disclaimer once merged. Check veraldar.org copy with a grep against the glossary words (a 10-line script in the weekly sweep).
3. **Repo layout** (adopt the repo-reshape lane's proposal, it matches the org): `veraldar/yggdrasil` (root brain + trunk services, release tags on the commits that run — `412a9c4`, `885122c`) and `veraldar/bifrost` (PWA, agent, the bridge, promote flow). History split via filter-repo on a **copy**, source untouched. Trunk placement (agent/deploy in which repo) is the reshape lane's call; this review's vote: trunk services with yggdrasil, because `bifrost` per the glossary is the phone-side gate.

### 4.3 GitHub sync (ordered; the first step is the user's)
1. **User**: `gh auth login --web -h github.com` (60 s) — the single blocker. Until then nothing else here can finish. Check afterwards: `gh auth status` and `gh release list --repo veraldar/bifrost` both 200.
2. Wave: `scripts/push-all.sh` (exists, untracked) pushes every branch with an upstream and reports stragglers; first run with `-c` only after the user has read the straggler list (it creates remote branches, outward-facing). **Secrets sweep first**: `scripts/push-audit.sh` + a `gitleaks`-style grep over the 78 commits; the root session reported nothing real is tracked — recheck, don't inherit.
3. Tag only what runs: `v0.6.1`, `v0.7.0-rc2`. **Release v0.7.0 waits on the device code** (the user's term; the 9-tap consent check is also open) — do not cut it.
4. Make the push the end of every lane: add to the lane epilogue "done = pushed" and let `push-audit.timer` (04:17) write the unpushed count into the metrics ledger; >0 for 48 h = a strike (§3.5).
5. Move `lk-verify` out of the trunk tree; it must never commit/push from the worktree the lanes use.

### 4.4 The docs archive (no files moved by this lane)
Rule: a **living doc ≤ one page** and each answers one question; history is kept in `docs/archive/YYYY-MM/` (git history stays intact, `git mv`). Inventory (`docs/*.md` = 31 files, 1.8 MB, 34 reviews, no `docs/archive/` exists):

| keep living (and trim to ≤ 1 page) | archive candidate (superseded / one-shot; last touched) |
|---|---|
| `plan.md` (trim 193→60), `STABLE.md`, `open-questions.md`, `claims.md`, `labs.md`, `veraldar-doctrine.md`, `journal.md`, `AGENTS.md`, `brand/brand.md`, `lab-playbook.md` (378 lines → split rules vs history) | `mission-mic-tap.md` 10-04, `mission-rebuild.md` 10-01, `mission-report.md` 10-01, `MERGE-NOTES.md` 10-01, `roadmap-proposal.md` 10-04, `roadmap-proposal-v2.md` 10-07 (→ merged into the one roadmap), `wireframes.md` 09-24, `phase-log.md` 09-26, `android-lab.md` 10-07 (move into `labs/`), `LABS.md` **duplicate of** `labs.md` (case-collision; delete one) |
| `spec.md`, `spec-onboard.md`, `spec-bridges.md` | `spec-connectors.md` and `spec-dream.md` — parked by the plan itself (demoted 09-28 / v1.0+); keep, but under `docs/parked/` so they stop looking active |
| `reviews/` 34 files | everything older than 7 days **and** whose findings are folded into plan/STABLE: onboarding-*, door-v3, film-*, theme-port, ux-batch, native-app-eval(+verify), opus-critique, sonnet-critique, sonnet-design-eye, full-fleet-review, s1/s4/s5/s6/s17 — ~18 files. Keep: this file, `v07-reflection-and-plan.md` (1495 lines → add a 1-page index on top; archive the body), `provider-wave`, `layman-deploy-spec`, `locations-audit`, `root-contract`, `s14-metrics-ledger` |

Executed by one lane (`DOCS-ARCHIVE`, sonnet) with a pre-image check (`git mv` only, a `docs/archive/INDEX.md` with one line per file, links rewritten with a grep, `scripts/where.sh` + `npx playwright test e2e/context.spec.ts` as the referee). Then a weekly sweeper flags any living doc > 80 lines.

## 5 · THE INSTALL STORY — honest status

"A root installs easily with the trunk WebRTC ready" is **not true today**, and the gap is mostly assembly, not invention.

| piece | state | evidence |
|---|---|---|
| Root installer kit (`install.sh`, `PKGBUILD`, `yggdrasil.service`, `.env.example`) | exists in `lab/yggdrasil/install/`; **not run by this lane on a clean machine** `[U]`; Arch-centric (`PKGBUILD`), no `.deb`/`.rpm`/Homebrew | `ls lab/yggdrasil/install` |
| `scripts/bootstrap.sh` | single-machine "trunk-local" setup; **clones tag `v0.6.0` from `github.com/veraldar/bifrost`** — which is stale (tags end v0.3.1 on GitHub; v0.6.0 is not even published) and, if private, unreachable to a stranger. So the one-command path fails at line 15 for anyone but the owner. | `bootstrap.sh` L13–15; `git tag` |
| Bridge (`bifrost-net`, `bifrost-bridge.service`) | running, device tokens + `/pair` + `BIFROST_AUTH=devices` e2e-proven (`pwa/e2e/bridge.spec.ts`: pair → data channel → message → voice). The unit's binary lived in `lane2-merge`; a fixed copy `~/.local/share/bifrost/bridge/bifrost-net-104b03b4a489` now exists and the unit drop-in was updated 10-28 21:36 | locations-audit; `ls ~/.local/share/bifrost/bridge` |
| "M1" | I could not find a definition of "bridge M1" in `plan.md`/`STABLE.md` (grep `M1\b` returned nothing) `[U]`; I take it as the first bridge milestone = the e2e-proven pairing above | grep |
| Trunk → VPS deploy | **spec only.** `layman-deploy-spec.md` (P1, commit 1591975): 6 locked decisions, Hetzner CX22 ≈ €5.89–5.94/mo all-in, real domain + DNS-01, PWA-install first and APK later, secrets never leave their machine. **No `trunk-deploy.sh`, no sim, no VPS.** | spec; `ls scripts` has no trunk-deploy |
| Phone app | PWA installable (manifest standalone). APK: signing/Play track absent (trunk-apk-readiness gap 5) | spec §1.3 |
| What a new user actually does today | there is no stranger path. The owner path = clone → `bootstrap.sh` (needs GitHub access to a stale repo) → tailscale → `docs/local.md`-style hand configuration → LiveKit docker → mic needs a secure origin (tailnet HTTPS works; plain IP does not) | bootstrap.sh; spec §1.5 |

**Gap list (ordered by what unblocks a friend):** (1) public/reachable repo + a published release tag the installer pins; (2) `install.sh` verified on a clean Debian/Ubuntu container and a clean Arch container, with the root up and `/health` 200; (3) `trunk-deploy.sh` (idempotent, `--redact`, health-gated, rollback-safe); (4) QR pairing wired to `/pair` in the printed instructions; (5) the layman sim: scripted fake friend + scratch box + fake VPS + headless phone, with the failure paths (bad QR, expired token, quota mid-onboard); (6) the human runbook; only then (7) one real VPS under the owner's account; (8) APK as a separate track.
**Plan:** P2 sim is already the next phase of the layman-deploy lab (continue, don't restart). If GitHub stays blocked, **honestly park** step (1) and say so on veraldar.org ("early access: install from a source tarball") rather than shipping a bootstrap that 404s.

## 6 · THE MAC EXTENSIONS — the concrete ask-list

Evidence: `ssh mac true` → `Connection refused` on port 22 (not a timeout), so the Mac is up and **Remote Login is off**. Existing alias: `mac`, user `yggdrasil`, key `~/.ssh/opencode_mac` (docs/local.md). The Mac currently serves speech (MLX voice `:8001`, launchd `com.opencode.mlxvoice`, 200); the voice-lab `:8002` is down. Its own organs (Squid, Flow, Workers, Letters) are unread.

**Copy-paste, on the Mac (≈ 3 minutes, in this order):**
```
1. System Settings → General → Sharing → Remote Login: ON
   "Allow access for": Only these users → add: yggdrasil
   (Do NOT use "All users".)
2. In Terminal on the Mac, as user yggdrasil:
     mkdir -p ~/.ssh && chmod 700 ~/.ssh
     # paste the PUBLIC key printed on omarchy by:  cat ~/.ssh/opencode_mac.pub
     echo '<paste public key>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
3. System Settings → Network → Firewall: allow incoming for "sshd-keygen-wrapper"
   (only if the Mac firewall is on)
4. Make sure Tailscale is signed in on the Mac (so we can use the tailnet name,
   not the LAN address).
5. Say "mac ssh on" in the chat.
```
**Optional, only if we need them (ask later, one at a time):**
- *Full Disk Access* for `/usr/libexec/sshd-keygen-wrapper` (System Settings → Privacy & Security → Full Disk Access): needed **only** to read `~/Library/` (Letters/Squid stores) or protected folders over ssh. Skip it first; we try without.
- *Xcode + iOS Simulator* installed: for the real WebKit/iPhone class of tests (S9 line 992).
- *A dedicated macOS user* with no admin rights for the extensions (`yggdrasil` already is a standard user `[U]`).
- No `sudo`, no screen-sharing, no Apple ID, no keychain access are requested.

**What we do with it (week 1 is read-only; we would restrict the key to a read-only command wrapper first).**
1. S9 MAC-REVIEW, the §3.3 list: Letters (storage, delivery, addressing, loop guard, usage), Squid (schedule format, missed-run policy, caps, who may create a schedule, failures in 30 days), Flow (step state, retries, resume), plus the **limitations audit** the user added 10-27: what each tool *prevents*, not only enables. Output: `docs/research/mac-yggdrasil-tools.md` (usage counts from the data, not the docs).
2. The extensions the user wants: **scheduled agent-call flows** (Squid's declared schedule → our `squid.sh`), **project-follow / global context** (a session watches a project dir and keeps a shared context file; Letters as transport between roots), the Mac as a second root in the grove (§2).
3. Away-mode value: a second machine that can hold the status heartbeat when omarchy dies (§3.4) and run the weekly sim sweep off the daily box.
Risk to state: giving sshd to an AI-driven agent widens the attack surface of the user's best machine; the key-restriction + user-limited login + read-only first week is the mitigation, and the user can revoke by flipping Remote Login off.

## 7 · PAST / PRESENT / FUTURE — does the mechanism work?

| layer | mechanism | verdict | evidence |
|---|---|---|---|
| **past** | urd (`docs/urd/tests.md`, one row per test) + `journal.md` + git | **works for tests, thin for incidents.** The 10-27 session-limit deaths and the OAuth outage appear nowhere in urd or journal; only in `outputs/*.txt`. `journal.md` is 75 lines and last-entry-dated early. | log.tsv vs journal |
| **present** | `where.sh` + `docs/labs.md` + `agi-status` | **works** — it is how this review found the STALE rows, the two-roots warning and the 3 timers in one call. Gaps: shows a dead lane only as "STALE? >1h"; says nothing about *driver absent*; brain stop was invisible to it; no heartbeat. | where.sh run at 19:53 |
| **future** | `plan.md` / roadmap | **fails**: plan.md is a 193-line layering of 5 eras (09-26 base → 10-29 laws), not a forward list. There are two roadmap proposals + a ladder in STABLE.md + the reflection plan — four sources, none authoritative. | wc, §4.4 |
| **trend** | S14 metrics ledger | built 10-27, untracked, 1 of 6 metrics fed, no timer (see §2.4) | s14 report |

Why the trend instrument did not exist: nobody owned a *feeder*. The S14 lane built the schema and the report (and was told "nothing live written"), the feeders needed the quick-gate probe timer and a `voice.turn` diag line (S1/T2) that were never dispatched, and no scheduler existed to run them anyway (§1 gap).
**Fix spec:** (a) commit S14 + schema; (b) wire the 5 missing metrics to the timers in §3.2; (c) add `line` (§2.4); (d) `where.sh` gets two new lines: `DRIVER: squid.timer last fired <t> (N rows due)` and `TREND: <metric> v0.6 / v0.7 now vs 7d ago`; (e) incidents get a one-line row in urd when a lane dies for infra (squid.sh writes it).

## 8 · THE PLAN — ordered, dated, owned

Owner key: **W** = wave lane, **S** = scheduler (once §3 exists), **U** = user's hands.

### Tonight (10-29)
| # | item | owner | done-check |
|---|---|---|---|
| T1 | `gh auth login --web` | **U** | `gh auth status` green |
| T2 | Provider is already answering (root probe OK 10-29 06:58; the 03:44 reset passed). One-token probe at start of any lane: run before dispatch | W | probe 200 |
| T3 | Dispatch **SQUID-V0** (opus, supervised): `docs/schedule.tsv`, `squid.sh`, `heal.sh`, install `agi-reap.timer`, enable `fleet-watchdog.timer` after review, re-queue-on-infra-red. Tested on the sim stack, not live | W | a lane killed with a fake "session limit" is re-queued by the timer |
| T4 | Dispatch **STATUS-HEARTBEAT**: `veraldar.org/status` + `status.json` push, red after 15 min | W | page renders; unplugging the push turns it red |
| T5 | Dispatch **PUSH-NOW** after T1: `push-all.sh`, secrets sweep, report stragglers (no `-c` yet) | W | `origin/main` = local |
| T6 | Investigate the 11:50 brain stop: gather `coredumpctl`, `dmesg`, cgroup OOM, `RuntimeMaxSec`; do not restart anything | W (sonnet) | cause named or "unknowable" with the log gaps listed |
| T7 | Reap the dup PROVIDER-WAVE and RULER-V07 rows (`agi-status` reaper) | W | where.sh shows 0 STALE |
| T8 | Commit the untracked set (S14, prompts, reviews, scripts) on a review branch | W | `git status` clean except secrets |

### This week
| day | item | owner |
|---|---|---|
| Fri 10-30 | Mac Remote Login on (§6 list) | **U** |
| Fri | `:443` back to v0.6.1 via the rehearsed path, with the `--user-validated` guard in `promote.sh`; v0.7 stays on `:8443`; do **not** promote until the user's consent taps | **U** says go, **W** executes |
| Fri–Sat | MAJORS-PARALLEL build: `--line`, port map, `where.sh` table, tailscale port feasibility check (HTTPS-port limit `[U]`) | W |
| Sat | repo-reshape (yggdrasil split, tags `412a9c4`/`885122c`), then the `DOCS-ARCHIVE` lane and `roadmap.md` | W |
| Sat–Sun | S9 MAC-REVIEW (read-only) | W |
| Sun | metrics feeders wired + first per-line trend report committed | S |
| Mon–Tue | layman-deploy P2 sim (scripted friend, scratch box, fake VPS) | W |
| Wed | away-mode dry run: the user does nothing for 24 h; the digest and status page are the only reporting | S, review by **U** |

### User-action list (THE MINIMAL ONE — everything else is a lane)
1. **`gh auth login --web -h github.com`** (60 s, tonight) — unblocks the push, the tags, the release and the CI-less backup of 78 commits.
2. **Mac: Remote Login ON for user `yggdrasil`, paste the one public key, say "mac ssh on"** (the §6 list, ~3 min, Fri).
3. **Three consents** (one word each): (a) "heal-restart the brain + `Restart=always`" (edits a live unit, once); (b) "away-mode ceiling as in §3.5" (what lanes may not do alone); (c) "`:443` back to v0.6.1 now" (the rehearsed `--rollback`; pending 9-tap check on `:8443` stays yours).
4. **Pick the alert channel**: ntfy topic / email / Telegram (default if no answer: ntfy topic with a random name, shown in the chat).
5. **The device code** for the v0.7.0 release (the brief: "release v0.7.0 pending the device code") — I found no further definition of it `[U]`; name it and it is a one-line task.
6. *(optional, not blocking)* a second provider key (OpenRouter/Anthropic/another coding plan) — the root runs `providers: env (0 fallback)`, so the next quota stop is explained on the phone but is still a stop.

## 9 · What this review did not do
It did not run the installer, ping Hetzner, test `fleet-watchdog.py`, read the 1495-line reflection beyond §3.3/Q3, check `loginctl` linger, nor probe the z.ai quota right now (a probe is a billable turn). It changed no running process and committed nothing (AGENTS.md: no commits unless asked). The one file it wrote is this one.
