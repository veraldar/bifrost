# Labs registry (S17)

The standing answer to "are the labs running?". Source: `docs/reviews/v07-reflection-and-plan.md` §10.4–10.5 (evidence as of 10-27).
Live view: `scripts/where.sh labs` (probes the units, containers and last commits; prints this table's state / wake / owner).
**Edit rule:** change a row here when a lab wakes, sleeps or graduates, and keep the table format: `where.sh labs` parses the rows between the `<!-- labs -->` markers (`lab | state | wake trigger | owner`).

States: **alive** (a timer or loop runs) · **dormant** (assets, no driver) · **stalled** · **stillborn** · **graduated** (now product or tooling).
Owner = the lane or person who wakes it. A lab with no owner is unowned: say so, don't guess.

<!-- labs -->
| lab | state | wake trigger | owner |
|---|---|---|---|
| worldtree-data | alive (data loop, `worldtree-fetch.timer` 14:30 CET; method frozen at 0.6.0) | already on; method changes only by milestone brief | S17 (hygiene); run-health line in `lab/worldtree-data/ledger.jsonl` |
| ygg-sim | stopped (cycle 7 = ff434a2, 10-07; container `ygg-sim` idles on `sleep infinity`; no driver) | the user's go (§5.3): weekly + every trunk merge, ledger = cycle roll-up | S13 |
| voice-lab | dormant, hand-fed (last result 10-04; Mac prod `:8001` up, lab `:8002` silent) | S15 bench: radar daily · bench nightly · re-eval on a release (item 11) | S15 (+ S16) |
| edge / bifrost-lite | folded into the bench as the box-CPU device class (arm64 never run) | S16's APK bench on the S22 supersedes the Termux run | S15 / S16 |
| research-feed | dormant (declared weekly; pass 1 10-07, pass 2 overdue) | item 4: weekly pass, T/A/N counts per pass | S8 |
| field-watch | never ran (herdr receipt 0 by hand, 10-22) | item 4: monthly | S8 |
| hardware / PCB | dormant, stalled (10-06: 3 boards routed 89/81/54 %, DRC 67/114/381, not fab-ready) | the user names a board to fabricate. Then freerouting + DRC/ERC → 0, trended | the user |
| silicon | stillborn (10-08: a 748 MB CAD download started, nothing built) | only with a written done-check first: one RTL target + testbench + yosys/OpenROAD PPA number vs a published one | the user |
| mini-agi (halo-memory) | dormant (parked on the GPU-rental call) | dreaming (`spec-dream.md`, v1.0) needs continual learning; the GPU call is the user's | the user |
| bifrost-net | graduated → v0.8 track (`bifrost-bridge.service`, sim `bridge.*`) | — | v0.8 lane |
| android-lab | graduated → S12 (APK + `app.*` scenarios) | — | S12 |
| yggdrasil | graduated → the v0.7 root (`lk-yggdrasil` :4100) | — | product |
| agi-metrics | graduated → agi-run's ledger (`.agi-log/log.tsv`) | — | S14 |
| lk-verify | alive, **RED** (daily e2e, `lk-verify.timer` 12:00 CET) | already on; turn it green first | S3 |
| net-research | one-shot (10-05 → `docs/research/tailscale.md`) | — | — |
| the Mac | prod speech alive; the Mac's own root is unread | S9 needs the user's access | S9 |
<!-- /labs -->

Not labs: dbzcraft, monster3d, magic-closet, japan-booking (other projects under `~/Work`).

## Rules the registry keeps
- **Loop bar** (§10.5): a lab gets the wave chain + ledger only with a referee outside the lab, one ledger line per run, a done-check per run, a cadence/trigger, and a product rung it feeds.
- **A nightly leaves no trunk commit.** worldtree's per-run "published" marker is one line in its run ledger (`lab/worldtree-data/ledger.jsonl`, gitignored, box-backed-up), shaped for S14's JSONL: `lab, metric=worldtree.run_health, value 1|0, run_id, published, sources_fresh, published_sha_ok, fresh_run`. `value=0` means: not published, a stale/snapshot_age gate failed, the live `realms.json` sha ≠ ours, or the manifest isn't today's. Before S14's adapter lands, read it with `tail -1 lab/worldtree-data/ledger.jsonl`.
- **ygg-sim is not looping.** The 10-06 claim "SELF-IMPROVING LOOP running" was stale (closed 10-27); the law is in `src/sources.rs`, the driver is stopped.
