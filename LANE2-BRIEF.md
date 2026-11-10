# LANE 2 — reconcile the live line with v0.9.0

`~/Work/lane2-merge` (branch lane2/merge = release/v0.9.0 tip ff428c8, the
gate-verified tagged release). Task: merge the live line's divergence into
it so ONE branch carries tonight's product:

- `git merge rebuild/cohesive-opus` — their side has: the compression-order
  plan docs (2b46049), possible S1/pairing work of their own (they wrote
  `pwa/app/pair/`, `lab/bifrost-net` changes uncommitted — IGNORE their
  uncommitted files, merge only their COMMITTED work), docs updates.
- `docs/claims.md` and any docs conflicts: UNION, lose no line from either
  side.
- Code conflicts: the tagged release side wins by default (it is gated:
  ladder 8/8, regression 47/0-failed) — take theirs ONLY for docs/plan
  files. If their committed code contradicts the release code in a way that
  is not docs, do not invent a semantic merge: keep release side, note it
  in LANE2-REPORT.md as a follow-up for the operator.
- Gate: `cd pwa && npm install && npm run build` green. The full playwright
  suite needs the live server discipline — do NOT run it (the operator
  gates the deployed build). Run ONLY the auth + pair-ladder specs in
  devices mode if a server is trivial to start on :8095 with
  PW_BASE_URL; otherwise state so honestly.
- Commit the merge. Write LANE2-REPORT.md (what merged, what was skipped,
  the exact branch/SHA the operator should deploy).

Territory: this worktree only. ~25 min. Blocked twice → stop, write the
blocker, exit.
