/**
 * GET /api/ice → { iceServers } for the bridge's WebRTC join (/bridge, /p2p).
 *
 * The user's own access point (lib/ice.ts, BIFROST_TURN_*) or — the default —
 * `[]`: LAN host candidates only, no third party ever learns of the box or the
 * phone. Time-limited REST credentials, so admin or a live device only (the
 * same rule as the device list); 401 otherwise.
 */
import { NextResponse } from 'next/server';
import { adminOrDevice } from '@/lib/admin';
import { iceServers } from '@/lib/ice';
import { NO_STORE } from '@/lib/pairing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!(await adminOrDevice(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ iceServers: iceServers() }, { headers: NO_STORE });
}
