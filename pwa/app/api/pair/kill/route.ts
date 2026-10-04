/**
 * POST → KILL-SWITCH, "sever all bridges": every device revoked, every pairing
 * code burned, the kill epoch bumped — the bridge drops every live peer when
 * it sees the epoch move. Admin or any live device may pull it (a safety
 * control must be reachable from the phone in your hand). Recovery = re-pair.
 */
import { NextResponse } from 'next/server';
import { adminOrDevice } from '@/lib/admin';
import { killSwitch } from '@/lib/devices';
import { NO_STORE, clearDeviceCookies } from '@/lib/pairing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!(await adminOrDevice(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const out = await killSwitch();
  return clearDeviceCookies(NextResponse.json(out, { headers: NO_STORE }));
}
