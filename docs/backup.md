# backup — this box → Mac Studio

Script: `scripts/backup.sh` (systemd user timers `backup.{service,timer}`
exist but are NOT enabled). Manual run: `./scripts/backup.sh`.

## What is covered
opencode sessions/store (`~/.local/share/opencode`, consistent sqlite
`.backup` of the 442M live db), `~/Work/bifrost` (gitignored secrets
INCLUDED — `.env` files are the point), systemd user units, crontabs.
Excluded as rebuildable bulk: node_modules, .next, .venv, edge/models.

## Layout on the Mac
`~/Backups/omarchy/<YYYY-MM-DD>/{config,db,meta,state,store,systemd-user,work,work-root}`
— incremental via hardlink-seeded copies (`cp -Rl` seed + rsync --delete),
14 snapshots retained. Same-day re-runs update today's snapshot in place.

## Restore (drilled 10-04)
1. Single file: `ssh mac "cat Backups/omarchy/<date>/work/<path>"` — drilled
   byte-identical against live `pwa/.env.local` (REVIEW session, 10-04).
2. Full repo: `rsync -rlptD mac:Backups/omarchy/<date>/work/ ~/Work/bifrost/`
3. opencode store: restore `store/` + `db/opencode.db` into
   `~/.local/share/opencode/` (db lives OUTSIDE the mirrored tree by design).

## Evidence (REVIEW session, 10-04)
- first verified run: 48.9s, snapshot 2026-10-04, 7.5G (all: 7.9G),
  consistent db staged, all 8 sets verified by the script.
- restore drill: PASS (byte-identical round-trip of a secret-bearing file).

## Trust boundary (S5, AGI review Part 3)
Snapshots on the Mac are PLAINTEXT and include provider auth + VAPID +
LiveKit secrets; the Mac's own backup chain multiplies copies. Until the
secrets set is age-encrypted at the source, the Mac is inside the trust
boundary: disk-encryption there is load-bearing.
