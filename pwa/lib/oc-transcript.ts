/** Tiny 60s cache of full transcripts, keyed by opencode session id —
 *  global search fans out over every session per query; without this each
 *  keystroke would re-fetch every transcript from opencode. */
import { ocFetch } from '@/lib/oc';

export type TMsg = { role: string; text: string; time: number };

const CACHE_MS = 60_000;
const MAX_SESSIONS = 100;
const cache = new Map<string, { at: number; msgs: TMsg[] }>();

export function getTranscript(sid: string): TMsg[] | null {
  const c = cache.get(sid);
  if (c && Date.now() - c.at < CACHE_MS) return c.msgs;
  return null;
}

export async function loadTranscript(sid: string): Promise<TMsg[]> {
  const cached = getTranscript(sid);
  if (cached) return cached;
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
    }))
    .filter((m) => m.text);
  if (cache.size >= MAX_SESSIONS) {
    // drop the oldest entry — crude but keeps long-lived proxies bounded
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(sid, { at: Date.now(), msgs });
  return msgs;
}

export function bustTranscript(sid?: string) {
  if (sid) cache.delete(sid);
  else cache.clear();
}
