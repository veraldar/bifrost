# S5 MAIN-CONTEXT — report

Lane S5 (v07-reflection-and-plan §7.2). Closes F2 (the meta tax) and the recipe half of F6.
Nothing live was touched: `where.sh` is read-only (`promote.sh --list`, `gate.py`, `curl`, `systemctl is-active/show`, `AGI_STATUS_RO=1`).

## Shipped
| slice | what | where |
|---|---|---|
| 1 | `scripts/where.sh [version\|url\|runs\|next\|all]` + its spec `scripts/test-where.sh` | bifrost `e1e122f` (+ spec fix in the report commit) |
| 2 | sandbox AGENTS layer: jitless build recipe, restart rule, `deploy.sh` warning, artifacts rule, fork warning | bifrost-sandbox `228ab5c` (`lab/sandbox`, AGENTS.md only) |
| 3 | pointer lines in `~/Work/AGENTS.md` and `~/Work/CLAUDE.md` (identical copies) | not a git repo — edited in place, no commit possible |

## Spec: each question from ONE call
`scripts/test-where.sh` asserts, per section of a single `where.sh` call:
- **what version** — live release label, the build id actually served on :8080, sandbox commit; plus a `MISMATCH` flag when :8090 serves a different build than the built tree.
- **what URL** — stable `https://<tailnet>` → :8080, next `https://<tailnet>:8443` → :8090, with HTTP codes.
- **what runs** — 8 units with state + pid, listening ports, lanes (agi-status), gate verdict + FAIL lines.
- **what to test next** — the newest URD row, the open URD rows, claims in flight, the exact sandbox `PW_BASE_URL` command.

Result: 15/15 PASS ("where.sh spec GREEN"). Full call takes ~2 s with the gate skipped, a few seconds more with it.

## Demo output (12:2x, full call)
```
where.sh · 2026-10-27 12:23

== VERSION ==
stable (frozen)  LIVE      v0.6.1                 20261006-2221-232b25c                    brain :4096  env 1af7ddfa  2026-10-06T22:23
rollback target  PREVIOUS  v0.6-stable.1          20261006-2138-c6a1b2d-wip0a104fa7        brain :4096  env 1af7ddfa  2026-10-06T21:39
  :8080 serves build ObBMjXoE6LBPUY_5bcLrR  (release build ObBMjXoE6LBPUY-5bcLrR)
sandbox (daily)  lab/sandbox@228ab5c · app 0.5.0-75-g9fd022e · 10-27 12:23
  :8090 serves build V_QtxgF2ifLRiaUnRR40R · built tree V_QtxgF2ifLRiaUnRR40R
  sandbox tree has 8 uncommitted pwa/agent path(s)
trunk            rebuild/cohesive-opus@e1e122f · S5 slice 1: scripts/where.sh — version / URL / runs / next-test in one

== URL ==
stable  https://omarchy.tail5435b1.ts.net        → :8080  lk-pwa + lk-agent (bifrost-live)   200
next    https://omarchy.tail5435b1.ts.net:8443   → :8090  bifrost-sandbox + lk-agent-ygg (bifrost-ygg)   200
  the user's daily stack is next/:8443. :8443 and :443 are separate origins (own mic/notifications/storage).

== RUNS ==
  lk-pwa            active    pid 1341586
  lk-agent          active    pid 3964651
  opencode-legacy   active    pid 1350425
  opencode-serve    inactive  pid 0
  lk-yggdrasil      active    pid 1616362
  bifrost-sandbox   active    pid 3608302
  lk-agent-ygg      active    pid 1481567
  bifrost-bridge    active    pid 4008544
  ports: :8080 live pwa · :8090 sandbox pwa · :4096 live brain (opencode) · :4100 yggdrasil brain · :7880 LiveKit
  listening: 8080 8090 4096 4100 7880
  lanes:
    RUNS TODAY: 6 (ok 6, fail 0, stalled 0, dead 0)
    RUNNING: 20261027T112311Z-a1-3733614 session=S6-PHONE-SHOT model=sonnet started=2026-10-27 12:23:11+0100 elapsed=00:00:44
    RUNNING: 20261027T112141Z-a1-3729877 session=S5-MAIN-CONTEXT model=sonnet started=2026-10-27 12:21:41+0100 elapsed=00:02:14
  gate: GATE RED — 1 failed: port.4096
    FAIL  port.4096            1 listener(s) pids=['1350425'] expected opencode-serve pid 0

== NEXT ==
last URD row (newest = bottom of docs/urd/tests.md):
  10-19 v0.7 | **the STT leg of the v0.7 FAIL — phone-class repro, RED→GREEN** (reproduce-first law): the repro (mobile UA on => PASS — **user mic retest still open**
open URD rows (the tests still owed):
  10-06 v0.7 **the first conversation with the root** — sandbox :8443, the rust PWA + yggdrasil :4100
  10-19 v0.7 **the STT leg of the v0.7 FAIL — phone-class repro, RED→GREEN** (reproduce-first law): the repro (mobile UA on :8443, co
claims in flight (docs/claims.md '- [ ]', 12 total; first 6):
  worldtree-m6-github
  ygg-sim
  v09-notailscale
  bifrost-net M1 full build
  stutter-fix
  rung0-bvl
run it against the sandbox (never plain 'npx playwright test' — that targets live :8080):
  cd /home/dweeb_xyz/Work/bifrost-sandbox/pwa && PW_BASE_URL=http://127.0.0.1:8090 npx playwright test e2e/<spec>
  jitless session (cat /proc/self/cgroup shows lk-yggdrasil)? see /home/dweeb_xyz/Work/bifrost-sandbox/AGENTS.md
```

## Findings the demo surfaced
- **Gate is RED on `port.4096`**: the v0.6.1 release expects an `opencode-serve` pid, but the brain is the `opencode-legacy` unit (pid 1350425). Known step-0 item (the `opencode-legacy` unit decision) and S3's "brain unit from the release env" — not fixed here (out of scope, and the gate is not mine).
- `lk-verify.service` is `failed` (F11, S3 owns it).
- The sandbox's old `scripts/deploy.sh` requires branch `main` and restarts **lk-pwa :8080**. The AGENTS layer says not to run it; S3 owns the replacement.
- The sandbox AGENTS.md carried a `systemctl --user restart lk-pwa lk-agent opencode-serve` verify line (live units). Replaced.
- `promote.sh --list` has no NEXT row yet, so `where.sh` treats the sandbox as the "next" slot from git + the served build; when S3 adds `--slot next`, the `NEXT` line prints automatically.

## Limits
- "What do I test next" is derived from the URD ledger's *Open tests* rows and claims; it does not rank them. `where.sh labs` is S17's.
- The sandbox has 8 uncommitted pwa/agent paths belonging to other sessions; only `AGENTS.md` was committed there (pathspec).
- OG-ctx (injecting AGENTS.md into yggdrasil) is a user decision (item 2 of §7.1) and was not done.
