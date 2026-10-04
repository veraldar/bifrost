/**
 * S1 seam (v0.9): revoke a device. Admin or any live device (a phone can
 * retire a lost tablet). DELETE /api/pair/devices { id } → { revoked: true }
 * Lands on the device's next HTTP call and severs its live bridge peer
 * within ~1s (the bridge re-checks every peer against the registry).
 */
import { NextResponse } from 'next/server';
import { adminOrDevice } from '@/lib/admin';
import { revokeDevice } from '@/lib/devices';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(req: Request) {
  if (!(await adminOrDevice(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || '');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const ok = await revokeDevice(id);
  return NextResponse.json({ revoked: ok }, { status: ok ? 200 : 404 });
}
