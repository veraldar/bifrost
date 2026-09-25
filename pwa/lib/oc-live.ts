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
export const markRunEnd = (sid: string) => {
  ensureLoaded();
  if (live.delete(sid)) persist();
};
export const isRunLive = (sid: string) => {
  ensureLoaded();
  return live.has(sid);
};
export const liveSince = (sid: string) => {
  ensureLoaded();
  return live.get(sid) || 0;
};
