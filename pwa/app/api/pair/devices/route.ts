/**
 * S1 seam (v0.9): revoke a device. Admin token or any live device token.
 * DELETE /api/pair/devices { id } → { revoked: true }
 */
import { NextResponse } from 'next/server';
import { adminOk } from '@/lib/admin';
import { revokeDevice, validateToken } from '@/lib/devices';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(req: Request) {
  if (!adminOk(req)) {
    const raw = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    if (!(await validateToken(raw))) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || '');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const ok = await revokeDevice(id);
  return NextResponse.json({ revoked: ok }, { status: ok ? 200 : 404 });
}
