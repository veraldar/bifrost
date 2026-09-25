/** Tracks in-flight async prompts per session: POST /message resolves only
 *  when the whole run finishes, so a set entry = opencode is actively
 *  working on that session right now. Definitive — the client's stable-state
 *  heuristic can't tell "thinking between steps" from "done".
 *  Persisted to disk: a server restart mid-run must not drop the flag
 *  (that made the session list "lose" its thinking dot once). */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { PENDING_TTL_MS } from './pending-ttl';

const FILE = path.join(process.cwd(), '.oc-live.json');
const STALE_MS = 15 * 60_000; // a restart-era entry older than this is garbage

const live = new Map<string, number>();
// epoch ms of the last finished run per session — the client uses it as an
// authoritative "your run is over" even when opencode leaves a message
// un-completed (its run-end bookkeeping is unreliable)
const runEnds = new Map<string, number>();

let loaded = false;
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  readFile(FILE, 'utf8')
    .then((raw) => {
      const now = Date.now();
      for (const [sid, since] of Object.entries(JSON.parse(raw) as Record<string, number>)) {
        if (now - since < STALE_MS) live.set(sid, since);
      }
    })
    .catch(() => {
      /* first boot or unreadable — start empty */
    });
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void writeFile(FILE, JSON.stringify(Object.fromEntries(live))).catch(() => {});
  }, 250);
}

/** @param since epoch ms the run started (lets the client show true elapsed) */
export const markRunStart = (sid: string, since = Date.now()) => {
  ensureLoaded();
  live.set(sid, since);
  persist();
};
/** @returns true if an entry was actually cleared (false = already gone —
 *  another end-of-run path like abort/poll-heal got there first) */
export const markRunEnd = (sid: string) => {
  ensureLoaded();
  const had = live.delete(sid);
  runEnds.set(sid, Date.now());
  if (had) persist();
  return had;
};
/** Epoch ms of the last finished run for this session (0 = none). */
export const runEndedAt = (sid: string) => runEnds.get(sid) || 0;
export const isRunLive = (sid: string) => {
  ensureLoaded();
  return live.has(sid);
};
export const liveSince = (sid: string) => {
  ensureLoaded();
  return live.get(sid) || 0;
};
