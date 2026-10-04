/**
 * POST → rotate the refresh credential, mint a fresh access token bound to the
 * CURRENT network region (this is the re-auth on region change). Browsers use
 * the path-scoped refresh cookie; headless clients post { refreshToken } and
 * get the rotated one back in the body. A replayed old refresh token (outside
 * the 30s race grace) revokes the device — theft signal.
 */
import { NextResponse } from 'next/server';
import { cookieOf } from '@/lib/admin';
import { refreshDevice } from '@/lib/devices';
import { NO_STORE, setDeviceCookies } from '@/lib/pairing';
import { regionOfReq } from '@/lib/region';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const headless = typeof body?.refreshToken === 'string';
  const raw = headless ? body.refreshToken : cookieOf(req, 'bifrost_refresh');
  const r = await refreshDevice(raw, regionOfReq(req));
  // a refusal never clears cookies: it may race a concurrent claim on the same
  // page and wipe the credentials that claim just set (stale ones are inert)
  if (!r.ok) {
    return NextResponse.json({ error: 'refresh rejected', why: r.why, reauth: 'pair' }, { status: 401 });
  }
  const res = NextResponse.json(
    {
      id: r.id,
      name: r.name,
      accessToken: r.accessToken,
      expiresIn: r.expiresIn,
      regionChanged: r.regionChanged,
      ...(headless ? { refreshToken: r.refreshToken } : {}),
    },
    { headers: NO_STORE },
  );
  return setDeviceCookies(req, res, r);
}
