/**
 * S1 seam (v0.9 no-tailscale): the device registry surface.
 *
 * POST { name } → direct mint for CLI/headless devices (admin only: the box
 *        console or BIFROST_ADMIN_TOKEN) → { id, accessToken, refreshToken,
 *        expiresIn, token } — shown ONCE; `token` = the access token (v1 shape).
 *        Phones pair through the QR instead (/api/pair/code → /api/pair/claim).
 * GET  → { devices, killEpoch, killedAt } (no hashes) — admin OR a live device.
 *        Presenting a garbage credential is never "trusted network".
 */
import { NextResponse } from 'next/server';
import { adminOk, adminOrDevice } from '@/lib/admin';
import { listDevices, mintDevice } from '@/lib/devices';
import { NO_STORE } from '@/lib/pairing';
import { regionOfReq } from '@/lib/region';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!adminOk(req)) {
    return NextResponse.json(
      { error: 'pairing not permitted here (box console, or BIFROST_ADMIN_TOKEN)' },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const issued = await mintDevice(String(body?.name || 'device'), regionOfReq(req));
  return NextResponse.json({ ...issued, token: issued.accessToken }, { headers: NO_STORE });
}

export async function GET(req: Request) {
  if (!(await adminOrDevice(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await listDevices(), { headers: NO_STORE });
}
