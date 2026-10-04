/**
 * S1 seam (v0.9 no-tailscale): the ONE middleware in front of /api/*.
 *
 * Modes (BIFROST_AUTH):
 *   tailnet (default today) → behave exactly as before: no device tokens
 *     required; the tailnet is the gate. Zero behavior change for existing
 *     deployments.
 *   devices → every /api/* request requires a live, unexpired access token
 *     issued in the request's network region (Authorization: Bearer … or the
 *     bifrost_device cookie), rate-limited per device. /api/pair/* mints and
 *     rotates credentials and authenticates inside each route (fail-closed);
 *     here it only gets the per-peer brute-force guard.
 *
 * 401 bodies say what the client must do next (`reauth`): `refresh` (expired
 * or region changed — present the refresh credential) or `pair` (scan again).
 * Revocation and the kill-switch land on the next call: devices.ts re-reads
 * the registry per request (no cache).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { checkAccess, type Deny } from '@/lib/devices';
import { rateTake } from '@/lib/ratelimit';
import { peerOf, regionOfReq } from '@/lib/region';

export const config = {
  matcher: '/api/:path*',
  // devices.ts uses node:crypto + fs — the registry check needs the node runtime
  runtime: 'nodejs',
};

const REAUTH: Record<Deny, 'refresh' | 'pair'> = {
  expired: 'refresh',
  region: 'refresh',
  missing: 'pair',
  invalid: 'pair',
  revoked: 'pair',
  used: 'pair',
  reuse: 'pair',
};

const PAIR_BURST = Number(process.env.BIFROST_PAIR_BURST) || 60;

const tooMany = (retryAfter: number) =>
  NextResponse.json(
    { error: 'rate limited' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );

export async function middleware(req: NextRequest) {
  if (process.env.BIFROST_AUTH !== 'devices') {
    return NextResponse.next();
  }

  const path = req.nextUrl.pathname;
  if (path.startsWith('/api/pair')) {
    const rl = rateTake(`peer:${peerOf(req) || 'unknown'}`, PAIR_BURST, 1);
    return rl.ok ? NextResponse.next() : tooMany(rl.retryAfter);
  }

  const raw =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    req.cookies.get('bifrost_device')?.value ||
    '';
  const gate = await checkAccess(raw, regionOfReq(req));
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'device token required', why: gate.why, reauth: REAUTH[gate.why] },
      { status: 401 },
    );
  }
  const rl = rateTake(`dev:${gate.device.id}`);
  return rl.ok ? NextResponse.next() : tooMany(rl.retryAfter);
}
