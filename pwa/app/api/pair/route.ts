/**
 * S1 seam (v0.9 no-tailscale): /api/pair mints per-device tokens.
 *
 * Pairing is the bootstrap surface: it mints the credentials everything else
 * requires. It must never be publicly reachable — the trust story:
 *   - BIFROST_AUTH=tailnet  → the tailnet/local is the gate (today's default)
 *   - BIFROST_ADMIN_TOKEN set → minting requires that header (public deploys)
 * If neither holds, minting refuses (fail closed).
 *
 * POST { name } → { id, token }   (token shown ONCE)
 * GET  → device list (no hashes) — admin OR a live device token.
 *        Presenting a garbage credential is never "trusted network".
 */
import { NextResponse } from 'next/server';
import { listDevices, mintDevice, validateToken } from '@/lib/devices';
import { adminOk } from '@/lib/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function adminOrDevice(req: Request): Promise<boolean> {
  // A presented credential must be LIVE — network trust (tailnet/admin)
  // never upgrades a garbage token. Network trust only applies when the
  // caller presents nothing (the bootstrap case).
  const raw = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (raw) return validateToken(raw);
  return adminOk(req);
}

export async function POST(req: Request) {
  if (!adminOk(req)) {
    return NextResponse.json(
      { error: 'pairing not permitted here (set BIFROST_ADMIN_TOKEN for public deploys)' },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || 'device');
  const { id, token } = await mintDevice(name);
  return NextResponse.json({ id, token, name }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(req: Request) {
  if (!(await adminOrDevice(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ devices: await listDevices() });
}
