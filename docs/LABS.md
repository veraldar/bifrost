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
| **voice-sim** | DORMANT (v0.6 era) | opencode store :4096 `[LAB] voice` (read-only) + Mac Studio MLX :8001 stack | recover as `[LAB] voice v0.7` via continuity-bridge (v06-bridge design, 10-27) | the owed STT/TTS repro (10-19 URD row) lives here |
| **nous-sim** | STANDING HARNESS | `~/Work/bifrost/lab/nous-sim/` | `pwa/artifacts/nous-sim-report.md` (first result: async MAIN 0ms blocked vs 21.8s sync) | fake-nous driver for coordination patterns; rerun on every coordination change |
| **ygg-sim** | DORMANT (v0.6 pair: app 0.6.0 ↔ sim 0.6.0) | `~/Work/bifrost/lab/ygg-sim/` | VERSIONS.md cycle evidence | the full-cycle simulator; revival owed when the client format changes (trunk-apk finding: sim never tested the artifact the user held) |

## Rules
1. A lab session's LAST message always names: home dir, artifact path, ledger path.
2. Trends append to the ledger, never overwrite. Scorecards are dated files.
3. A `[LAB]` that stops iterating gets DORMANT in this file, not deleted — old labs stay
   accessible across harnesses (continuity bridge).
4. Bench batteries run as `[RUN]` sessions and may be purged; their numbers live in the
   ledger, not the session list.
