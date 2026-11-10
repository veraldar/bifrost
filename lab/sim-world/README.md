# sim-world — tier-3 simulation as standing infrastructure

Owner canon: `docs/TESTING.md` (10-30). Simulation = LLM agents acting as users AND
engineers inside a sandboxed-but-real stack, driven by procedures/skills/loops to
validate the system. Required for release gates, trust/security/pairing, cross-route
behavior, onboarding. **Sim failures are findings, not noise.**

## The world (P2) — EXISTING assets, nothing rebuilt (owner addendum 10-30)

The spine was NOT built by this lab; it already exists and is reused as-is:

| piece | what it is | where | status |
|---|---|---|---|
| **sim stack spine** | sim-pwa (:8096, the app) + sim-ygg (:4111, the root, production binary + hardening) + sim-mock (:18190, upstream brain) | `~/Work/bifrost-sandbox/scripts/sim-stack.sh up\|down\|status` | REUSED verbatim |
| **scratch real-brain root** | same release binary, real glm-5.3-flash upstream, own data/proj dirs, `{ROOT}`-templated context file | `~/Work/bifrost/lab/tool-policy/boot.sh <tag> <port>` | REUSED pattern; sim-world's own boot is `boot-world.sh` |
| **LLM batteries** | tasks-as-data, adapters (base http/sse + opencode + yggdrasil-scratch), ledger rows | `~/Work/bifrost/lab/harness-bench/` | REUSED as python modules |
| **dispatch probe** | "a dispatch nobody answers" — create room → dispatch → agent joins or RED | `~/Work/bifrost/scripts/gate.py` `dispatch_probe()` | REUSED as the voice leg of scenarios that need it |
| **personas** | layman friend (retrospective-1019 §5), pushing user (tool-policy A/B/C prompts + driver), engineer (tool-policy B), batteries (harness-bench), dispatch probe (gate.py) | see `personas/` | EXTRACTED, not reinvented |

Personas with real brains hit the **scratch root** (`boot-world.sh`, glm-5.3-flash via the
user's coding-plan upstream) through the root's HTTP API the way the PWA proxy does.
Browser-leg scenarios drive the sim-pwa UI with Playwright (jitless rules apply inside
the lk-yggdrasil cgroup: `node --jitless` + `--js-flags=--jitless`, see runner).
A scenario needing voice dispatch uses the gate.py probe against the sim's
`AGENT_NAME=sim-none` seam (proves the dispatch path dies loudly, which IS the finding
the probe exists for — nobody-serves-sim-rooms is the designed sim posture).

## The home (single-home law)

sim-world's long-running home is the PROXY target `[LAB] Veraldar` (`ses_f28e2fdf4ffeWng5LZZnYbCpnm`,
opencode :4096) — per owner addendum: proxy, never copy. Today the relay (`ygg-relay`) is
DESIGNED but NOT BUILT (proxy-sessions plan §3; build gate = its 8-flow kill-test), so the
link is currently a **registration write to the home root** (`home-link.py`): one message in
`[LAB] Veraldar` recording this lab's status artifact + ledger paths. When the relay lands,
the same lab mints its proxy handle on :4100 (`info.proxy` shape, plan §2b) and the
registration message becomes stale history, not a second home.

## Layout

    personas/     persona cards — goal, procedure, tools, stop conditions (P1)
    scenarios/    versioned procedures: <name>@<ver>.md + machine part in the runner (P3)
    runner.py     one command: scenario → trace jsonl → verdict + findings (P4)
    boot-world.sh scratch root(s) for persona brains + 429-injector root
    inject.py     quota-outage injector (mock-key "mock-1310" → z.ai's exact 429 body)
    home-link.py  registration message to the home root [LAB] Veraldar (:4096, write = 1 msg)
    ledger.py     append rows to ~/.local/share/bifrost/bench/sim-world.jsonl

## Verdicts (P4 law)

- `PASS` — every assertion green.
- `FINDINGS(n)` — scenario completed; n findings filed (each finding = ledger row + line in the run report). This is a SUCCESSFUL sim that found things — the normal good case.
- `FAIL` — the scenario itself could not run (world broken, persona harness crashed). Also files a finding (the world is the first suspect).

## Running

    cd ~/Work/bifrost-sandbox && bash scripts/sim-stack.sh up        # the world
    python3 lab/sim-world/runner.py --scenario cold-visitor-onboarding
    python3 lab/sim-world/runner.py --battery                        # full battery (release gate)
    python3 lab/sim-world/runner.py --rotate                         # nightly: one scenario, rotating
