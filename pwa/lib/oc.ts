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

/** Accepts a real session id (sess_*) or a room slug (title with dashes). */
export async function resolveId(idOrSlug: string): Promise<string> {
  if (idOrSlug.startsWith('sess_')) return idOrSlug;
  type Sess = { id: string; title?: string };
  const sessions = (await ocFetch('/session')) as Sess[];
  const hit = sessions.find((s) => slugify(s.title || '') === idOrSlug || s.id === idOrSlug);
  if (!hit) throw new Error(`no session for slug ${idOrSlug}`);
  return hit.id;
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
