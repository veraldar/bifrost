/**
 * Pairing plumbing shared by the /api/pair/* routes: device cookies and the
 * bridge identity the QR pins.
 *
 * Cookies (HttpOnly, SameSite=Strict): `bifrost_device` = access token (every
 * /api call carries it — existing fetches need no change); `bifrost_refresh`
 * = refresh token, path-scoped to /api/pair so it never rides ordinary calls.
 */
import { NextResponse } from 'next/server';
import { REFRESH_TTL_MS, type Issued } from '@/lib/devices';
import { bustCache } from '@/lib/oc-cache';
import { slugify } from '@/lib/slug';

export const NO_STORE = { 'Cache-Control': 'no-store' };

const secure = (req: Request) =>
  new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';

export function setDeviceCookies(req: Request, res: NextResponse, t: Issued): NextResponse {
  const base = { httpOnly: true, sameSite: 'strict' as const, secure: secure(req) };
  const maxAge = Math.round(REFRESH_TTL_MS / 1000);
  // the access cookie outlives its token on purpose: an expired token answers
  // 401 reauth=refresh (recoverable), a missing one would read as unpaired
  res.cookies.set('bifrost_device', t.accessToken, { ...base, path: '/', maxAge });
  res.cookies.set('bifrost_refresh', t.refreshToken, { ...base, path: '/api/pair', maxAge });
  return res;
}

export function clearDeviceCookies(res: NextResponse): NextResponse {
  res.cookies.set('bifrost_device', '', { path: '/', maxAge: 0 });
  res.cookies.set('bifrost_refresh', '', { path: '/api/pair', maxAge: 0 });
  return res;
}

export type BridgeIdentity = { name: string; fingerprint: string; signal: string };

/** The local bridge's DTLS fingerprint + the signaling URL phones dial. */
export async function bridgeIdentity(): Promise<BridgeIdentity | null> {
  const base = process.env.BIFROST_BRIDGE_URL || 'http://127.0.0.1:7890';
  try {
    const r = await fetch(`${base}/identity`, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const id = (await r.json()) as BridgeIdentity;
    return id.fingerprint ? id : null;
  } catch {
    return null;
  }
}

const OC = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
export const MAIN_TITLE = process.env.BIFROST_MAIN_TITLE || 'main';

/** MAIN — the brain session a freshly paired phone lands on (created on first pair). */
export async function ensureMain(): Promise<{ id: string; slug: string } | null> {
  const slug = slugify(MAIN_TITLE);
  try {
    const list = (await (await fetch(`${OC}/session`, { cache: 'no-store' })).json()) as Array<{
      id: string;
      title?: string;
    }>;
    let s = list.find((x) => slugify(x.title || '') === slug);
    if (!s) {
      const r = await fetch(`${OC}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: MAIN_TITLE }),
      });
      s = (await r.json()) as { id: string; title?: string };
      bustCache();
    }
    return s?.id ? { id: s.id, slug } : null;
  } catch {
    return null;
  }
}
