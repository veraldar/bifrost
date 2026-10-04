/**
 * POST { code, name } → redeem a one-time pairing code (the phone's half of
 * the QR). Single use — a replay answers 410 why=used; expired 410
 * why=expired; unknown 401. On success: device cookies set + the access token
 * returned for the P2P transport. Revoke-on-repair: if this browser still
 * holds an old refresh cookie, the device it belonged to is retired.
 * `main` = the MAIN brain session (created on first pair) the phone lands on.
 */
import { NextResponse } from 'next/server';
import { cookieOf } from '@/lib/admin';
import { claimPairCode } from '@/lib/devices';
import { NO_STORE, ensureMain, setDeviceCookies } from '@/lib/pairing';
import { regionOfReq } from '@/lib/region';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const r = await claimPairCode(
    String(body?.code || ''),
    String(body?.name || 'phone'),
    regionOfReq(req),
    cookieOf(req, 'bifrost_refresh') || undefined,
  );
  if (!r.ok) {
    return NextResponse.json(
      { error: 'pairing code rejected', why: r.why },
      { status: r.why === 'invalid' ? 401 : 410 },
    );
  }
  const main = await ensureMain();
  const res = NextResponse.json(
    { id: r.id, name: r.name, accessToken: r.accessToken, expiresIn: r.expiresIn, main },
    { headers: NO_STORE },
  );
  return setDeviceCookies(req, res, r);
}
