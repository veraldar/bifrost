# v0.6 → v0.7 session store mapping

Derived by reading both stores directly (recon 2026-10-28). Source read strictly
read-only: `sqlite3 'file:…/opencode.db?mode=ro'` (URI mode; no write, no vacuum,
no file moves). Everything below was verified against real rows.

## Scope (what "ALL v0.6 sessions" is)
- Source db has 283 sessions total, but 58 of them were created **after** the
  10-27 17:35 promote to v0.7 (e2e probes, lab spawns, today's work) — those are
  v0.7-era sessions living on the legacy port, NOT v0.6 history.
- v0.6 scope = `parent_id IS NULL AND time_created < 2026-10-28 00:00 local` →
  **exactly 221 sessions** (matches the mission's ~221).
- Excluded on purpose: 12 subagent-child sessions (`parent_id IS NOT NULL`, the
  `@explore`/`@general` spawns — children of sessions inside scope; 10 have
  transcripts), and 6+2 sessions in `/tmp` scratch dirs (2 pre-today are
  child sessions anyway, so the 221 filter already excludes them).

## Session info
| opencode `session` row (sqlite) | yggdrasil `info` |
|---|---|
| `id` (`ses_…`, opencode alphabet) | `id` — KEPT VERBATIM (0 collisions with target store, checked all 15,478 msg / 56,280 part ids) |
| `title` | `title` = `"[V06] " + title` |
| — | `archived: true` (mission: imported = archived; source has 0 archived) |
| — | `v06id` = original source id (kept also as `id`; `v06id` is the law-mandated pointer) |
| `time_created` / `time_updated` (ms) | `time.created` / `time.updated` |
| `directory`, `version`, `slug`, `agent`, `model`, `cost`, `tokens_*`, `share_url`, `summary_*`, `revert`, `time_archived`, `parent_id`, `project_id` | `v06meta` = full original row (JSON) — nothing dropped |
| — | `directory` promoted to top of info (target UI's sessions carry it when set) |

## Messages
| opencode | yggdrasil |
|---|---|
| `message` row → `data` JSON + row `time_created/time_updated` | `messages[].info` |
| `data.id` | `info.id` (verbatim, 0 collisions) |
| `data.role` | `info.role` |
| `data.time` (has `created`, `completed`) | `info.time` (normalized: always has `created`; `completed` kept; assistant gets `first_delta` = `completed-created` if missing) |
| `data.*` all other keys (`agent`, `modelID`, `providerID`, `cost`, `tokens`, `mode`, `path`, `parentID`, `error`, `finish`, `summary`, `variant`, `model`) | kept verbatim inside `info` (target's assistant info carries the same vocabulary) |
| row `time_updated` > data `time` | `info.time.updated` added when row time_updated > created (target vocab has this) |

## Parts
`message.parts[]` = all `part` rows for the message, ordered by
`(time_created, id)`. Part JSON kept **verbatim** — source vocabulary is a
subset of target's: `text`, `reasoning`, `step-start`, `step-finish`, `tool`
(`state`: input/metadata/output/status/time/title/attachments), `file`
(`{mime,url}` — same shape as target's file parts), `compaction`. Verified
overlap on every key set that occurs in source. No placeholders needed: 0 of
56,280 parts dropped. `messageID`/`sessionID` fields stay valid (ids kept).

## Todo
opencode `todo` table (session_id, content, status, priority, position) →
`todo: [{id: position, content, status, priority}]` — matches the target's
observed todo item shape (`id` string, 27 source sessions / 164 rows). Sessions
without todos: `todo` key omitted (matches target).

## Safety laws honored
- MAIN (`ses_770b899884cf47718e054f6f2702630c`) not in source; importer
  refuses to write that id regardless.
- Existing `ses_*.json` never overwritten (importer skips + records skip).
- Fresh sessions are written atomically (tmp file + rename, never in-place).
- Zero writes to :4096 / opencode.db (read-only URI mode enforced; WAL files
  untouched — ro mode doesn't create them).

## Counting law for VERIFY
Per-session message count = rows in `message` for that session (target file's
`messages[]` length must equal it). The [WEBSITE] session has 1,025 messages.
