/**
 * Who may administer pairing (single source so the pair routes cannot drift).
 *
 *   admin  — Bearer BIFROST_ADMIN_TOKEN, or — presenting NOTHING — network
 *            trust: the declared tailnet (legacy, no admin token configured)
 *            or the box's own console = a loopback peer, which is provable
 *            only behind server.mjs (lib/region.ts).
 *   device — a live access token (Bearer or the bifrost_device cookie).
 *
 * A presented credential must be valid on its own: network trust never
 * upgrades a garbage or stale token (e2e: auth.spec).
 */
import { timingSafeEqual } from 'crypto';
import { checkAccess } from '@/lib/devices';
import { regionOfReq } from '@/lib/region';

export const bearerOf = (req: Request) =>
  req.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim() || '';

export function cookieOf(req: Request, name: string): string {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function adminOk(req: Request): boolean {
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  const presented = bearerOf(req);
  if (presented) return !!expected && same(presented, expected);
  if (!expected && process.env.BIFROST_AUTH === 'tailnet') return true;
  return process.env.BIFROST_PAIR_LOCAL !== '0' && regionOfReq(req) === 'loopback';
}

export async function adminOrDevice(req: Request): Promise<'admin' | 'device' | null> {
  const presented = bearerOf(req);
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  if (presented && expected && same(presented, expected)) return 'admin';
  const raw = presented || cookieOf(req, 'bifrost_device');
  if (raw) return (await checkAccess(raw, regionOfReq(req))).ok ? 'device' : null;
  return adminOk(req) ? 'admin' : null;
}
