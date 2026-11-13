/**
 * GET /api/search?q=… → global transcript search across ALL sessions.
 *
 * Case-insensitive substring match (same semantics as the in-session search).
 * Returns only sessions that hit, each with hit count + up to 2 context
 * snippets, ranked: exact title match > title contains q > text-only, then
 * by time of the newest match. Transcripts come from the sticky cache
 * (re-fetched only when a session's `updated` stamp moves); identical
 * queries within 15s are served from a result memo. Queries < 2 chars are
 * rejected — a single letter scans everything for noise.
 */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';
import { getSearchResult, loadTranscript, setSearchResult } from '@/lib/oc-transcript';

export const dynamic = 'force-dynamic';

const MAX_SESSIONS = 50;
const SNIPPETS = 2;
// before-context must stay SHORT: result rows are single-line truncated,
// and a deep window start hides the match past the phone's cut-off point
// (seen live: "theme" never visible in the snippets). ~1.5 words of lead-in
const CTX_BEFORE = 24;
const CTX_AFTER = 70;

/** Text around the first match, ready for client-side <mark> splitting.
 *  The match lands near the START of the snippet (window start snaps
 *  forward to a word boundary), so truncation can't swallow it. */
function excerpt(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return '';
  let start = Math.max(0, i - CTX_BEFORE);
  // partial word at the window edge → drop it entirely (start moves
  // TOWARD the match, which only pulls the match closer to the front)
  while (start > 0 && start < i && /\S/.test(text[start])) start++;
  const end = Math.min(text.length, i + q.length + CTX_AFTER);
  return (
    (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
  );
}

export async function GET(req: Request) {
  try {
    const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return NextResponse.json({ sessions: [] });
    const memo = getSearchResult(q);
    if (memo) return NextResponse.json(memo, { headers: { 'Cache-Control': 'no-store' } });
    const sessions = (await ocFetch('/session')) as Array<{
      id: string;
      title?: string;
      time?: { updated?: number };
    }>;
    const found = await Promise.all(
      sessions.slice(0, MAX_SESSIONS).map(async (s) => {
        try {
          const msgs = await loadTranscript(s.id, s.time?.updated || 0);
          const hits = msgs.filter((m) => m.low.includes(q));
          if (!hits.length) return null;
          return {
            id: s.id,
            title: s.title || s.id,
            hits: hits.length,
            lastHit: hits[hits.length - 1].time,
            snippets: hits.slice(-SNIPPETS).map((m) => ({
              role: m.role,
              time: m.time,
              text: excerpt(m.text, q),
            })),
          };
        } catch {
          return null; // one dead session must not kill the search
        }
      })
    );
    const out = found
      .filter((x): x is NonNullable<(typeof found)[number]> => !!x)
      // "find that session": exact name > name contains the word > text-only
      // hits; recency orders within each tier
      .sort((a, b) => {
        const rank = (s: (typeof found)[number] & { title: string }) =>
          s.title.toLowerCase() === q ? 2 : s.title.toLowerCase().includes(q) ? 1 : 0;
        return rank(b) - rank(a) || b.lastHit - a.lastHit;
      });
    const payload = { sessions: out };
    setSearchResult(q, payload);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
