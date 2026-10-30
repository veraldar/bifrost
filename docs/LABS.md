# LAB REGISTRY — veraldar (standing labs, 10-28)

NAMING LAW (owner, 10-28): `[LAB]` = a LONG-RUNNING, iterating program of R&D — it produces
trend reports and pushes artifacts. One-shot measurements are `[RUN]`, spawned freely, deleted
or archived freely. Never mint a `[LAB]` session per battery turn (that was the 10-28 mess:
77 [LAB] sessions, ~70 noise — retitled `[RUN] bench …`).

## Standing labs (the registry — this file is the source of truth)

| lab | status | home | trend/artifacts | note |
|---|---|---|---|---|
| **harness-bench** | ACTIVE v1 | `~/Work/bifrost/lab/harness-bench/` | ledger `~/.local/share/bifrost/bench/*.jsonl` + scorecard; reports → `pwa/artifacts/harness-bench-*.md` | the instrument: any harness × model × category, trendable. v1.1 owes: agentic tool-use + endurance-after-compaction categories; fix = runner must NOT mint a session per turn |
| **tool-policy** | RUNNING | `~/Work/bifrost/lab/tool-policy/` | report → `pwa/artifacts/tool-policy-report.md` | MAIN tool scopes: full vs coordinator vs minimal; feeds ROOT-CONTRACT |
| **rule-eval** | ACTIVE v1 | `~/Work/bifrost/lab/rule-eval/` | ledger `~/.local/share/bifrost/bench/rule-eval.jsonl` + `scorecards/`; report → `pwa/artifacts/rule-eval-v1.md` (sandbox copy) | the improvement-validation loop: no rule binds until the state machine (protocol.md) validates target+guard+≥3-point trend, else AUTO-SUNSET |
| **voice-sim** | DORMANT (v0.6 era) | opencode store :4096 `[LAB] voice` (read-only) + Mac Studio MLX :8001 stack | recover as `[LAB] voice v0.7` via continuity-bridge (v06-bridge design, 10-27) | the owed STT/TTS repro (10-19 URD row) lives here |
| **nous-sim** | STANDING HARNESS | `~/Work/bifrost/lab/nous-sim/` | `pwa/artifacts/nous-sim-report.md` (first result: async MAIN 0ms blocked vs 21.8s sync) | fake-nous driver for coordination patterns; rerun on every coordination change |
| **surface-familiarity** | BLOCKED — first run gated on root schema-override (tool-policy finding) | `~/Work/bifrost/lab/surface-familiarity/` | ledger vs harness-bench baselines | law: GLM likely trained on opencode-shaped surfaces (hypothesis); each root surface change = one [RUN] mutation experiment; drop-vs-distance = "how far is too far" |
| **ygg-sim** | DORMANT (v0.6 pair: app 0.6.0 ↔ sim 0.6.0) | `~/Work/bifrost/lab/ygg-sim/` | VERSIONS.md cycle evidence | the full-cycle simulator; revival owed when the client format changes (trunk-apk finding: sim never tested the artifact the user held) |
| **proxy-sessions** | DESIGN (10-30, no build) | plan `docs/reviews/proxy-sessions-plan.md` (no lab dir until P3) | report → plan + sandbox artifact copy; sim report owed before any build | single-home LAW: a session lives on ONE root; every other appearance = proxy (relayed) or inert archive. [V06] verdict: hybrid — closed history stays archived copies, live-written labs (`[LAB] Veraldar` measured 10-30) proxy their originals. Root change = S guard only; relay = extension (ygg-relay) per root-contract §2. Kill-the-remote sim is the build gate. Route #1 verified 10-30 (Mac Studio trunk, tailnet, warm TTFB ~51 ms, list = trunk aggregation shape → third 'trunk' dialect shim in Appendix B); sim leg read-only per addendum |
| **layman-deploy** | BUILDING (10-29) | `~/Work/bifrost/lab/layman-deploy/` | plan+sim → `pwa/artifacts/layman-deploy-plan.md`; scripts `lab/layman-deploy/` | the owner's target: friend installs root on any box → trunk auto-deploys to a VPS → phone scans → talks. Provider+price decided in-plan; ALL phases simulated before any real VPS (rule 10-09/10-10). Constraint: no real VPS touched, human gate owns real-world execution |

## DRAFT RULES — not binding until validated (owner 10-28: "no rules before simulation of gain/loss metric and validation of improvement in the trend")
Status: hypotheses. Each must state its metric, baseline, target; promotion needs a validated trend, demotion is automatic.
1. A lab session's LAST message always names: home dir, artifact path, ledger path.
2. Trends append to the ledger, never overwrite. Scorecards are dated files.
3. A `[LAB]` that stops iterating gets DORMANT in this file, not deleted — old labs stay
   accessible across harnesses (continuity bridge).
4. Bench batteries run as `[RUN]` sessions and may be purged; their numbers live in the
   ledger, not the session list.
| **mac-council** | DONE v1 (10-30) | `~/Work/bifrost/lab/mac-council/` | report → `docs/reviews/mac-council.md` + `pwa/artifacts/mac-council-report.md` (sandbox copy); raw runs in `lab/mac-council/runs/` | the Mac council study: route #1 read-only extraction (50 sessions; 13/13 single-brief subagents; council inboxes 257–1,834 msgs) + theory review + adoption design (grove-context extension, flow law, letters loop) + tier-3 head-to-head: marathon vs flow-of-fresh on glm-5.3-flash — **accuracy tie at ~46k/200k tok est + interference (36/36, 12/12, 24/24 both arms)**; flow wins cost (-97% ctx/answer, -59% wall) and structural immunity; digest fidelity = the new load-bearing surface. Verdict: adopt the architecture, hold the "always beats" claim as falsified-as-accuracy |
