/** Shared opencode REST helpers for the Next API proxy. */

export const OC = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';

export async function ocFetch(path: string, init?: RequestInit) {
  const t0 = Date.now();
  const r = await fetch(`${OC}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  console.log(`[oc] ${init?.method || 'GET'} ${path} → ${r.status} ${Date.now() - t0}ms`);
  if (!r.ok) throw new Error(`opencode ${r.status} on ${path}`);
  // 204s (v2 switch endpoints) have no body — null, not a JSON parse error
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/** The header a session page sends with the session id it opened. */
export const PIN_HEADER = 'x-session-pin';

/** Accepts a real session id (sess_*) or a room slug (title with dashes).
 *  `pin` (the page's PIN_HEADER) wins over the name (herdr §1.4 — pin the
 *  occupant, never the name): it resolves only to that session, so a page
 *  that opened one session is never served another one wearing the same
 *  slug (a duplicate name, or the replacement of a deleted session); a
 *  rename elsewhere keeps reaching it. Nothing found throws a `session_gone`
 *  error (see sessionGone). */
export async function resolveId(idOrSlug: string, pin?: string | null): Promise<string> {
  if (!pin && idOrSlug.startsWith('sess_')) return idOrSlug;
  type Sess = { id: string; title?: string };
  const sessions = (await ocFetch('/session')) as Sess[];
  const hit = pin
    ? sessions.find((s) => s.id === pin)
    : sessions.find((s) => slugify(s.title || '') === idOrSlug || s.id === idOrSlug);
  if (!hit) {
    throw Object.assign(new Error(`no session for ${idOrSlug}`), { code: 'session_gone' });
  }
  return hit.id;
}

/** The typed answer for a request whose session is gone (deleted, or never
 *  was): 404 `session_gone` — never a 500, never another session's data.
 *  null when `e` is any other failure. */
export function sessionGone(e: unknown): Response | null {
  if ((e as { code?: string })?.code !== 'session_gone') return null;
  return Response.json(
    { error: 'this session is gone — it was deleted', code: 'session_gone' },
    { status: 404 }
  );
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 60) || 'session'
  );
}
