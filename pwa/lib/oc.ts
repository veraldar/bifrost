/** Shared opencode REST helpers for the Next API proxy. */

import { Agent, fetch as undiciFetch } from 'undici';

export const OC = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';

// ported from v0.6.1 (40c6037) by RULER-V07 10-27 — the fork never had it (drift-guard: oc-headers-timeout)
/** undici's global fetch defaults to a 300s headersTimeout — and POST
 *  /session/:id/message only returns headers when the WHOLE run finishes, so
 *  every run over 5 minutes died mid-flight with "TypeError: fetch failed"
 *  (diag 10-05: three consecutive runs each killed at ~300.8s, the phone
 *  showing "no reply — the run seemed stuck"). A dedicated Agent with 0
 *  disables both timeouts; OC_HEADERS_TIMEOUT_MS re-arms one for tests.
 *  undici's own fetch instead of the global one: Next patches global fetch
 *  and its wrappers have eaten/blocked requests before (oc-watchdog went raw
 *  node:http for the same reason). One shared agent: pooled, no per-call cost. */
const ocAgent = new Agent({
  headersTimeout: Number(process.env.OC_HEADERS_TIMEOUT_MS) || 0,
  bodyTimeout: 0,
});

export async function ocFetch(path: string, init?: RequestInit) {
  const t0 = Date.now();
  const r = await undiciFetch(`${OC}${path}`, {
    method: init?.method,
    body: init?.body as any,
    signal: init?.signal as AbortSignal | undefined,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    dispatcher: ocAgent,
  } as Parameters<typeof undiciFetch>[1]);
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
