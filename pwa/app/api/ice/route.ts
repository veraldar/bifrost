/**
 * /api/ice — TURN credentials for the WebRTC join (vps-turn-tcp seam).
 *
 * GET with the device bearer (or admin) token → { iceServers } to feed
 * `new RTCPeerConnection({ iceServers })`. The bridge page calls this right
 * before creating the pc, so a join never needs a long-lived TURN password.
 * 401 without a live credential, 503 until TURN_SECRET is configured.
 */
import { NextResponse } from 'next/server';
import { validateToken } from '@/lib/devices';
import { turnCreds, turnSecret, adminTokenOk } from '@/lib/ice';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const presented = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!turnSecret()) {
    return NextResponse.json({ error: 'TURN_SECRET not configured' }, { status: 503 });
  }
  const ok = presented ? await validateToken(presented) : adminTokenOk(null);
  if (!ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(
    { iceServers: [turnCreds(turnSecret())] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
