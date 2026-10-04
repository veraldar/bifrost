/**
 * S1 seam (v0.9 no-tailscale): the ONE middleware in front of /api/*.
 *
 * Modes (BIFROST_AUTH):
 *   tailnet (default today) → behave exactly as before: no device tokens
 *     required; the tailnet is the gate. Zero behavior change for existing
 *     deployments.
 *   devices → every /api/* request requires a live device token
 *     (Authorization: Bearer …) EXCEPT /api/pair, which mints them and is
 *     gated by BIFROST_ADMIN_TOKEN / tailnet inside the route itself
 *     (fail-closed there).
 *
 * Revocation: devices.ts re-reads the registry per request (no cache), so a
 * settings-page revoke kills in-flight devices on their next call.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { validateToken } from '@/lib/devices';

export const config = {
  matcher: '/api/:path*',
  // devices.ts uses node:crypto + fs — the registry check needs the node runtime
  runtime: 'nodejs',
};

export async function middleware(req: NextRequest) {
  if (process.env.BIFROST_AUTH !== 'devices') {
    return NextResponse.next();
  }

  const path = req.nextUrl.pathname;
  if (path.startsWith('/api/pair')) {
    return NextResponse.next(); // the route itself decides (fail-closed)
  }

  const raw =
    req.headers.get('authorization')?.replace(/^Bearer /, '') ||
    req.cookies.get('bifrost_device')?.value ||
    '';
  if (await validateToken(raw)) {
    return NextResponse.next();
  }
  return NextResponse.json({ error: 'device token required' }, { status: 401 });
}
