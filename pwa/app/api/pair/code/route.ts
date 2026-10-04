/**
 * POST { name? } → one-time pairing code + the QR that carries it. Admin only
 * (the box's own console or BIFROST_ADMIN_TOKEN) — a device can never mint a
 * new device, so a leaked device token cannot buy persistence.
 *
 * The QR is a security artifact (Part 15 §a.3/§d.2), trust-on-first-scan:
 *   <BIFROST_PUBLIC_URL>/pair#v=1&code=<bfnp-…>&fp=<bridge DTLS sha-256>
 *                             &bridge=<bridge signaling url>&box=<name>
 * The fragment never reaches a server or its logs; the phone's /pair page
 * redeems the code and pins the fingerprint for every later P2P connect.
 */
import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { adminOk } from '@/lib/admin';
import { mintPairCode } from '@/lib/devices';
import { NO_STORE, bridgeIdentity } from '@/lib/pairing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!adminOk(req)) {
    return NextResponse.json(
      { error: 'pairing codes come from the box console (or BIFROST_ADMIN_TOKEN)' },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const [{ code, exp }, id] = await Promise.all([
    mintPairCode(String(body?.name || 'phone')),
    bridgeIdentity(),
  ]);
  const base = (process.env.BIFROST_PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, '');
  const frag = new URLSearchParams({ v: '1', code });
  if (id) {
    frag.set('fp', id.fingerprint);
    frag.set('bridge', id.signal);
    frag.set('box', id.name);
  }
  const url = `${base}/pair#${frag}`;
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  return NextResponse.json(
    {
      url,
      svg,
      exp,
      fingerprint: id?.fingerprint ?? null,
      bridge: id?.signal ?? null,
      ...(id ? {} : { warning: 'bridge unreachable — HTTP pairing only, no pinned P2P transport' }),
    },
    { headers: NO_STORE },
  );
}
