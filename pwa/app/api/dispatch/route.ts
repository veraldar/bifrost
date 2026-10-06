import { NextResponse } from 'next/server';
import { AgentDispatchClient } from 'livekit-server-sdk';

// must match agent/agent.py: @server.rtc_session(agent_name=...)
const AGENT_NAME = 'bifrost';

// Re-arm the voice agent for a room the phone is ALREADY connected to.
// A room's dispatch dies with its first agent job; when the phone's link
// flaps, the LiveKit SDK self-reconnects into a fresh server-side room
// without re-minting a token — so no dispatch exists there and every
// client-side agent wait runs out ("voice agent missing from the room",
// diag 2026-10-06 14:35 hands-free + tap-to-send, lk-agent healthy the
// whole time). Dispatching into the existing room heals it without a
// re-dial (the link was the flaky part).
export async function POST(req: Request) {
  // same gate as the token route
  if (process.env.NODE_ENV !== 'development' && process.env.BIFROST_AUTH !== 'tailnet') {
    throw new Error(
      'THIS API ROUTE IS INSECURE. DO NOT USE THIS ROUTE IN PRODUCTION WITHOUT AN AUTHENTICATION LAYER.'
    );
  }
  const API_KEY = process.env.LIVEKIT_API_KEY;
  const API_SECRET = process.env.LIVEKIT_API_SECRET;
  if (API_KEY === undefined || API_SECRET === undefined) {
    return NextResponse.json({ error: 'livekit not configured' }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const roomName = String(body?.room || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 60);
  if (!roomName) {
    return NextResponse.json({ error: 'room required' }, { status: 400 });
  }

  try {
    // same seam as the token route: LIVEKIT_URL is the phone-facing TLS
    // alias (proxied websockets only); the server API needs the direct host
    const apiHost = (process.env.LIVEKIT_API_URL || 'http://127.0.0.1:7880').replace(
      /^ws(s):/,
      'http$1:'
    );
    await new AgentDispatchClient(apiHost, API_KEY, API_SECRET).createDispatch(
      roomName,
      AGENT_NAME
    );
  } catch (e) {
    console.error(`agent re-dispatch failed for room ${roomName}:`, e);
    return NextResponse.json({ error: 'dispatch failed' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
