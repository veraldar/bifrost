/** Sticky per-session transcript cache — entries live until the session's
 *  `updated` stamp moves (or a send busts them), so repeat global searches
 *  are pure in-memory scans instead of a 50-session opencode fan-out.
 *  Each message also stores a one-time lowercased copy for search. */
import { ocFetch } from '@/lib/oc';

export type TMsg = { role: string; text: string; time: number; low: string };

const MAX_SESSIONS = 100;
const cache = new Map<string, { updated: number; msgs: TMsg[] }>();

export async function loadTranscript(sid: string, updated = 0): Promise<TMsg[]> {
  const c = cache.get(sid);
  if (c && c.updated === updated) return c.msgs;
  const raw = (await ocFetch(`/session/${sid}/message`)) as Array<{
    role?: string;
    info?: { role?: string; time?: { created?: number } };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
  const msgs: TMsg[] = raw
    .map((m) => ({
      role: m.info?.role || m.role || '',
      text: (m.parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('\n')
        .trim(),
      time: m.info?.time?.created || 0,
      low: '',
    }))
    .filter((m) => m.text);
  for (const m of msgs) m.low = m.text.toLowerCase();
  if (cache.size >= MAX_SESSIONS) {
    // drop the oldest entry — crude but keeps long-lived proxies bounded
    const oldest = [...cache.entries()].sort((a, b) => a[1].updated - b[1].updated)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(sid, { updated, msgs });
  return msgs;
}

export function bustTranscript(sid?: string) {
  if (sid) cache.delete(sid);
  else cache.clear();
}

/** 15s memo of search responses — typing a word fires y → yg → ygg… queries;
 *  retries and re-focuses must not re-scan. */
const RES_TTL = 15_000;
const resCache = new Map<string, { at: number; data: unknown }>();

export function getSearchResult(q: string): unknown | null {
  const c = resCache.get(q);
  if (c && Date.now() - c.at < RES_TTL) return c.data;
  return null;
}

export function setSearchResult(q: string, data: unknown) {
  if (resCache.size >= 50) resCache.clear();
  resCache.set(q, { at: Date.now(), data });
}

export function bustSearchResults() {
  resCache.clear();
}
