# LANE 2 — report: the live line reconciled into v0.9.0

**Verdict: merged. The build gate is GREEN, and the auth + pair-ladder specs are GREEN (8 passed) in devices mode on :8095.**
All of the live line's committed work is in, through `601d3f2`. It is docs plus
`lab/worldtree-data/`, with no code. The deployable trees (`pwa/`, `agent/`, `deploy/`, `edge/`,
`scripts/`, `lab/bifrost-net/`) are **byte-identical to the `v0.9.0` tag (`ff428c8`)**.

## Deploy this

| | |
|---|---|
| branch | **`lane2/merge`** |
| code SHA | **`c180e9a`** (`c180e9add0385e09b5e2b20d407a92564b12bf52`, the 2nd merge below). The branch tip is the commit that adds this report on top of it and changes nothing else. |
| live line merged up to | `rebuild/cohesive-opus` @ **`601d3f2`** |
| release under it | tag `v0.9.0` = `ff428c8`, plus `41b421f` (the lane-2 brief) |

Two merge commits, both with no conflicts:

1. **`e17a183`** merges `d108299`, the `rebuild/cohesive-opus` tip when the run started.
2. **`c180e9a`** catches up to `601d3f2`. The live line moved during this run and gained 2 commits, both `lab/worldtree-data/` only.

Check it yourself:
- `git diff --stat v0.9.0 lane2/merge` → only `LANE2-*.md`, `docs/agi-guide.md`, `docs/plan.md`, `lab/worldtree-data/**`.
- `git diff v0.9.0 lane2/merge -- pwa agent deploy edge scripts lab/bifrost-net` → empty.

## What merged: all of their committed work since the merge-base `9c0425e`

| commit | content | result |
|---|---|---|
| `2b46049` | `docs/plan.md`: the v0.8.0 and v0.9.0 rows are compressed into one v0.9.0 row ("no-tailscale direct pairing, tokens built first inside the arc") | taken as-is (docs/plan = theirs) |
| `3767eb9` | "run 20261004T115730Z: published": an **empty commit** with no tree change | carried in history |
| `d108299` | `docs/agi-guide.md`: the "model ladder (Opus + Sonnet 5.5)" section | taken as-is (docs = theirs) |
| `f8ab003` | "run 20261004T135801Z: published": worldtree briefs M4a/M5, `scripts/nightly.sh`, `scripts/publish.sh`, `nightly.log` | taken as-is (new files) |
| `601d3f2` | worldtree M5 run A D1: `worldtree-fetch.{service,timer}` and `.gitignore` | taken as-is (new files) |

- **Conflicts: none.** Their side touched files the release had not touched since the merge-base. That is two docs files plus new files under `lab/worldtree-data/`.
- **`docs/claims.md`, union: no line lost.** Their committed `claims.md` is the merge-base copy. The union is therefore the release copy, which adds the `telemetry` and `voice-switch` lines over the base.
  - Checked line by line: 0 of their 54 lines are missing from the result, and 0 of the release's 56 are missing.
- **Code contradictions: none.** Their committed side contains no product code, so release-side-wins never had to apply.
- **Why I took the catch-up (`f8ab003`, `601d3f2`):** the enabled `worldtree-fetch.timer` runs `scripts/nightly.sh` from `~/Work/bifrost/lab/worldtree-data`. A deploy branch without those files would delete them when the live checkout switches to it.

## What was skipped, and why

The brief says to ignore **their uncommitted work** in `~/Work/bifrost`, so none of it is in this merge. As of this run it holds:

- **A parallel S1 / pairing implementation** (code):
  - untracked `pwa/app/pair/page.tsx`, `pwa/app/bridge/page.tsx`, `pwa/e2e/bridge.spec.ts`, `pwa/e2e/fixtures/`
  - modified `lab/bifrost-net/src/{bridge,bridge_main,opencode,relay,tokens}.rs`, `Cargo.toml`, `Cargo.lock`
  - `pwa/package.json` adds `qrcode` + `@types/qrcode`
- **Docs and tooling:**
  - `docs/reviews/agi-roadmap-review.md` (+134). This includes **Part 15, the review law `RELEASE-REPORT.md` cites**.
  - `docs/lab-playbook.md` (+49), `docs/claims.md` (+4/−1), `.gitignore`
  - new: `docs/roadmap-proposal-v2.md`, `docs/reviews/native-app-eval*.md`, `docs/worldtree/requirements-from-history.md`, `scripts/agi-run.sh`, `scripts/agi-status.sh`, `prompts/`

## Follow-ups for the operator

1. **The live line keeps moving.** Its nightly job commits "run …: published" daily at 14:30.
   - Before switching the live checkout, run `git log --oneline lane2/merge..rebuild/cohesive-opus`.
   - Merge anything it lists first. Otherwise the switch deletes those files from the live tree.
2. **The live checkout cannot simply switch to `lane2/merge` today.**
   - Their untracked `pwa/app/pair/page.tsx` collides with the release's tracked file of the same path.
   - Their modified `lab/bifrost-net/src/*`, `pwa/package.json` and `docs/claims.md` all differ between the two branches.
   - So `git checkout` refuses. First commit that work to a side branch. Use a commit, not a stash: the stash stack is shared across worktrees.
3. **Their parallel /pair + bridge code contradicts the release. Do not auto-merge it.**
   - The release implementation is the gated one: ladder 8/8 rungs, regression 49 passed / 6 skipped / 0 failed (`RELEASE-REPORT.md`).
   - Anything unique on their side should come back as its own slice with its own gate. For example, a `qrcode` dependency: the release renders the QR without it.
4. **Commit the docs-only uncommitted pieces and fold them in as a docs follow-up.**
   - These are: Part 15 of the review, the lab-playbook fleet rule, the `agi-run.sh` / `agi-status.sh` scripts and their claim lines.
   - Part 15 matters most: `RELEASE-REPORT.md` cites a law that exists in no commit.
   - For `claims.md`, take the three-way union: their additions vs the merge-base, never their stale base copies.
5. **`lab/worldtree-data/nightly.log` is tracked.** `601d3f2` gitignores it and its message says "untracked", but both new commits commit it, and `.gitignore` does not untrack a tracked file. Needs `git rm --cached lab/worldtree-data/nightly.log` on the live line.
6. **Version stamp.** `npm run build` stamps `git describe` into `pwa/package.json`.
   - On this branch it reads `0.9.0-N-g<sha>`. The gate build stamped `0.9.0-1-g41b421f` and that was reverted, not committed.
   - The live line still stamps `0.6.0-…` until this merge lands there.

## Gate evidence (this worktree)

- **Build:** `cd pwa && npm install && npm run build` → **exit 0** ("✓ Compiled successfully in 50s", `BUILD_ID qTtYUEFfVeTTmRyYT-S1U`). `npm install` changed nothing but the version stamp.
- **Bridge:** `cd lab/bifrost-net && cargo build --release` → **exit 0** (2m 36s).
- **Auth + pair ladder, devices mode, built from this tree:**
  - Command: `V09_STATE=/tmp/lane2-ladder scripts/v09-ladder.sh <box LAN address>`. This is `server.mjs` with `BIFROST_AUTH=devices` on **:8095** and the bridge on :7890 / udp :7891.
  - **8 passed (1.2m), `LADDER EXIT 0`**: `auth.spec.ts` **7/7** and `pair-ladder.spec.ts` **1/1 (8 rungs)**.
  - Bridge log corroborates rung 6 (`severed peer 0 — revoked`) and rung 7 (two `— kill-switch` lines).
  - Torn down afterwards: :8095, :7890 and :7891 are free.
- **What that run covers:** the run was against `e17a183`. `c180e9a` changes only `lab/worldtree-data/`, and the `pwa`, `agent`, `deploy`, `edge`, `scripts` and `lab/bifrost-net` tree hashes are identical between the two, so the result applies to `c180e9a` too.
- **Not run, by brief:** the full playwright suite, and the default-mode (tailnet) regression. The operator gates the deployed build; the release session measured 49 / 6 / 0 on the same code.
- **Untouched:** live services (lk-pwa :8080, lk-agent, opencode-serve, LiveKit) were never stopped or restarted. Nothing was written to `~/Work/bifrost` or to the release session's `/tmp/v09-ladder`. The ladder's disposable MAIN `e2e-ladder-main` is deleted by the spec.
