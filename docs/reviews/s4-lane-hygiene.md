# S4 LANE-HYGIENE — report (sonnet, 2026-10-27)

Source: `docs/reviews/v07-reflection-and-plan.md` §7.2 (S4), §1.4, §8.6, §8.7. Live (STABLE 4/5) untouched:
no live unit restarted, no `:8080/:4096` call. All tests used `/tmp/s4` fakes and throwaway units.

## Done-checks

| # | check | result | evidence |
|---|---|---|---|
| 1 | restarting the hosting brain kills no lane | **PASS** | below |
| 2 | a killed lane reads DEAD ≤ 60 s | **PASS** (34 ms after the kill, on the next status call) | below |
| 3 | a finished lane pushes its letter | **PASS** to a stub `/api/push`; **SKIP (named): the real phone**, because it needs VAPID keys + a subscribed device | below |

### 1 — brain restart (throwaway brain unit `s4-fakebrain`, which launched the lane exactly as a brain would)
- Lane `agi-lane-S4-SURVIVE-3722648.service`, cgroup `…/app.slice/agi-lane-S4-SURVIVE-3722648.service`.
  The brain's cgroup was `…/app.slice/s4-fakebrain.service` — a different one.
- `systemctl --user restart s4-fakebrain`: brain MainPID 3722646 → 3722777. The lane's MainPID 3722654 stayed
  `active (running)` and `kill -0` succeeded. Its `claude` stand-in (pid 3722663, `sleep 300`) lived on.
- (The second lane that appeared was the throwaway brain re-running its own start command on restart; it is not a lane death.)
- Why this stands in for the real brain: I run inside `opencode-legacy.service` (:4096, the live brain), which STABLE
  forbids restarting. The mechanism is identical: a different cgroup is a different kill scope.

### 2 — killed lane
- `agi-run.sh -s S4-KILL2` → row `RUNNING … pid=3725539 unit=agi-lane-S4-KILL2-…`.
- `kill -9 <wrapper pid>` → the unit and its `claude` child are gone (0 `sleep300` left) → the next
  `agi-status.sh` appended a `DEAD` row after 34 ms. Between calls the state is "RUNNING until someone looks",
  so the ≤ 60 s bound = the polling interval. Chains poll every 30 s. `scripts/agi-reap.timer` (every 30 s) is shipped
  **but not enabled** (a schedule is autonomy: the user's go).
- Side effect on the **real** log: the first real call reaped two pre-S4 zombies that read RUNNING for 82 h and 195 h
  (`MAINFRAME-DESIGN`, `ONBOARD-GAPS`; found through the runid's trailing pid, since old rows carry no `pid=`).

### 3 — letters
- Finished fake lane → `letters/agi-<runid>.json` (envelope v1: `v, id, thread, from, to, author:harness, cause, kind, body,
  artifacts[{path,sha256,bytes}], model, time`; plus `status`) and an HTTP POST `{letter}` to `AGI_PUSH_URL`;
  the stub received it, `200 {"ok":true,"sent":1}`.
- FAIL/STALLED lanes write `kind: blocked`. A push failure never fails the run (the letter stays on disk).
- Real side: `pwa/app/api/push/route.ts` POST accepts `{letter}` → `pushLetter()` (`pwa/lib/push.ts`) reuses the
  run-done wire (the service worker is unchanged). `tsc --noEmit` is clean for both files. **Not exercised against a
  running Next build**, because the sandbox is :8090 and rebuilding under it is off-limits. The route takes effect on the
  next sandbox/promote build.

## What changed (one commit per slice)
| slice | commit | files |
|---|---|---|
| 1 systemd-run | b335dfa | `scripts/agi-run.sh` — re-exec under `systemd-run --user --wait --pipe --collect` (same blocking contract); `AGI_SYSTEMD=0` reverts (verified); `AGI_DETACH=1` returns at launch |
| 2 letters + push | 85e94cf | `scripts/agi-run.sh`, `pwa/lib/push.ts`, `pwa/app/api/push/route.ts`; the RUNNING row's note now carries `pid=N unit=U` |
| 3 DEAD | b6bdcce | `scripts/agi-status.sh` (reaper, `--reap`, `AGI_STATUS_RO=1`), `scripts/agi-reap.{service,timer}` |
| 4 chain | ff05b4a | `scripts/agi-chain.sh` |
| 5 law | this commit | `docs/lab-playbook.md` (rule 10-04 amendments + the DRAFT coordinator law), this report |

## The chain format (`scripts/agi-chain.sh -w UP[,UP] -t SECS [--any] -- <agi-run args>`)
Tested on a fake log: upstream OK → downstream launched and OK · upstream never finishing, `-t 4` → `CHAIN-STOP … expired`,
downstream not launched, chain unit gone · upstream killed → DEAD → `CHAIN-STOP … upstream not green (UP-B=DEAD)` ·
`--any` after red → launches. The waiter runs in its own unit with `RuntimeMaxSec=EXPIRY+120` as a backstop
(the property is set; I did not wait out the backstop). `prompts/chain-onboard-build.sh` (the old 45-minute `for` loop, untracked,
not mine) is left alone. New chains use this.

## The coordinator law
Drafted as the last section of `docs/lab-playbook.md`, labelled **DRAFT, not in force until the user's go** (Rule 10-08:
evidence W1–W5, scope, counterfactual, done-check). The two §8.7 lines are in it, in the user's words:
"authority never travels with a message" · "no session writes `user` turns into another session".

## Open / honest gaps
- Real-phone push: SKIP, see above. The route needs a build to go live; a lane can already write its letter either way.
- A DEAD lane writes a log row but **no letter** (the "who did what" for a crash). The next increment is to move `write_letter` into a shared script that `agi-status --reap` also calls.
- `agi-reap.timer` is not enabled, and the DEAD bound is only guaranteed while something polls (chains do).
- Callers that background `agi-run.sh &` still work (the wrapper blocks inside the unit client). A caller killed mid-run
  now leaves the lane running to completion — that is the point, but a lane you want gone needs
  `systemctl --user stop agi-lane-<SESSION>-<pid>`.
- Dispatch/stall-detection logic of the run itself was not changed.
