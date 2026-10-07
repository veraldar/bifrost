
---

## v6 — the co-evolution law, mechanized (landed 10-06/07, this cycle)

**Order**: when does the SIM evolve vs when does the ENVIRONMENT around it
evolve — fold the three evolution sources into the cycle.

**The law, now with teeth**:
1. **Incident-to-scenario pipeline** (`INCIDENTS.md` + gate): every production
   incident becomes a scenario in the next version. The register holds 9 mined
   from claims/diag/journal evidence (agent-dup, chunk-race, tts-stutter,
   oc-timeout 300s, zai-429, send-lost, sse-wedge, hf-restore, ptt-arm); each
   names its covering scenario. The cycle FAILS when an incident stays
   uncovered past one cycle of grace — 4 are uncovered now
   (agent-worker, pwa-build-race, concurrent-tts, long-run) and are v7's
   obligations, enforced.
2. **Environment scan** (`ENVIRONMENT.md` manifest + drift diff): 10 facts
   (zai dialects, str0m transport, bridge no-BWE/no-ICE-restart laws, speaches
   models, opencode SQLite store, proxy undici, network classes) hashed into
   every cycle snapshot; drift since the last version = a chaos profile or
   scenario dimension owed in the next version.
3. **Usage shifts** (live store scan): the cycle reads the real opencode
   SQLite read-only (221 sessions / 14,065 messages / deepest session) and
   flags ±15% swings — the matrix's life is moving under it.

**Cycle evidence** (`report/cycles/cycle-7.json`): MATRIX 30 ran · 23 pass ·
4 break · 3 known · 0 skip · 0 FAIL · SLO 44/45 · CYCLE 7 VALID. Digest:
"incidents: 9 tracked, 4 uncovered (grace until next cycle) · environment
drift: 0 changed, 10 new · pairing app 0.6.0 ↔ sim 0.6.0".

**Delta vs v5**: +1 source module (`src/sources.rs`), +2 manifests, +1 cycle
gate (stale incidents fail), +3 digest sections, +3 snapshot fields, 0 FAIL.

app-version pairing: app 0.6.0 ↔ sim 0.6.0

**Mined for v7** (the register's enforced obligations): agent-worker scenario
(duplicate-prompt stacking through the bridge), pwa-build-race fixture (serve
a build while swapping it), concurrent-tts (two peers' voice rounds at once),
long-run (a single >60s turn completing through the proxy's uncapped
timeouts) — plus v5's carryovers (S22 real-phone lane, mic foreground
service, French in-process gate, bifrost-net's fix queue).
