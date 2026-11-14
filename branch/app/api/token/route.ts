import { NextResponse } from 'next/server';
import {
  AccessToken,
  type AccessTokenOptions,
  AgentDispatchClient,
  RoomConfiguration,
  type VideoGrant,
} from 'livekit-server-sdk';
import { resolveId } from '@/lib/oc';

// must match branch/voice/agent.py: @server.rtc_session(agent_name=...)
const AGENT_NAME = process.env.AGENT_NAME || 'bifrost';

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

// NOTE: you are expected to define the following environment variables in `.env.local`:
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

// don't cache the results (GET reads the env at request time, never at build)
export const revalidate = 0;
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Voice is a state of the connection, not an error (lib/voice-token.ts): the
 *  app shows one calm line and stops asking. Always JSON — an empty 500 used
 *  to surface on the phone as "Unexpected end of JSON input". */
function unavailable(why: string) {
  return NextResponse.json({ error: 'voice-unavailable', why }, { status: 503, headers: NO_STORE });
}

/** why voice cannot work from here, or null when it can. LiveKit tokens are
 *  minted only where the network is the gate (the tailnet) or on a dev
 *  server. Devices mode — a phone paired through the trunk, via the access
 *  point — has no auth layer in front of this route's tokens and no LiveKit
 *  the phone can reach: voice over the trunk is not built yet (it comes with
 *  WebRTC through the access point's TURN). Not loosened here. */
function whyUnavailable(): string | null {
  if (process.env.NODE_ENV !== 'development' && process.env.BIFROST_AUTH !== 'tailnet') {
    return 'voice over the trunk is not built yet — it rides the tailnet today (BIFROST_AUTH=tailnet)';
  }
  if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
    return 'no LiveKit on this computer (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET unset)';
  }
  return null;
}

/** GET: can voice work from here? Mints nothing, dispatches nothing — the app
 *  asks before it would ask for the mic (lib/voice-token.ts voiceProbe). */
export async function GET() {
  const why = whyUnavailable();
  return why ? unavailable(why) : NextResponse.json({ voice: 'available' }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const why = whyUnavailable();
  if (why) return unavailable(why);

  try {
    // Parse room config from request body (an unreadable body = no room → 400 below).
    const body = await req.json().catch(() => ({}));
    const roomConfig = body?.room_config
      ? RoomConfiguration.fromJson(body.room_config, { ignoreUnknownFields: true })
      : new RoomConfiguration();

    // Room = session slug passed by the sessions shell.
    const rawRoom = String(body?.room || '');
    console.log(
      `[token] raw room=${JSON.stringify(body?.room)} referer=${req.headers.get('referer')}`
    );
    let roomName = rawRoom.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    // VOICE_ROOM_BY_ID=1 (a second stack on the same LiveKit, e.g. a preview): rooms are named by
    // session id, so they never collide with another stack's slug rooms ("main"). The voice agent
    // finds a session by slug OR id, so nothing changes on its side.
    if (process.env.VOICE_ROOM_BY_ID === '1' && roomName) {
      roomName = await resolveId(roomName).catch(() => roomName);
    }
    // a room-less mint used to fall back to `session_<random>` — the agent
    // then spawned a phantom opencode session titled after it (2026-09-29
    // session_6898 storm). Refuse instead: callers must name the room.
    if (!roomName) {
      return NextResponse.json({ error: 'room required' }, { status: 400, headers: NO_STORE });
    }

    // Stable identity per room so reconnects resume the same participant.
    const participantName = 'user';
    const participantIdentity = `user_${roomName}`;

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, name: participantName },
      roomName,
      roomConfig
    );

    // Explicit agent dispatch. LiveKit only auto-dispatches a job when a room
    // is CREATED, so rejoining a not-yet-deleted room (fast mode switch,
    // self-heal) used to land in an agent-less room: hot mic, "listening"
    // UI, nothing transcribed (2026-09-25 veraldar-org---home). Dispatching
    // per mint guarantees an agent for every fresh phone connect. Best-effort:
    // a failed dispatch still returns the token (voice just stays agent-less
    // and the session page surfaces it).
    try {
      // LIVEKIT_URL is the phone-facing TLS alias (proxied websockets only —
      // its Twirp path 404s into the PWA); the server API needs the direct
      // host. Same box, so 127.0.0.1:7880 is the sane default.
      const apiHost = (process.env.LIVEKIT_API_URL || 'http://127.0.0.1:7880').replace(
        /^ws(s):/,
        'http$1:'
      );
      const dispatchClient = new AgentDispatchClient(apiHost, API_KEY, API_SECRET);
      await dispatchClient.createDispatch(roomName, AGENT_NAME);
    } catch (dispatchError) {
      console.error(`agent dispatch failed for room ${roomName}:`, dispatchError);
    }

    // Return connection details
    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL!, // whyUnavailable() checked all three
      roomName,
      participantName,
      participantToken,
    };
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: 'token failed', why: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE }
    );
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  roomConfig: RoomConfiguration | undefined
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: '15m',
  });
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
  at.addGrant(grant);

  if (roomConfig) {
    at.roomConfig = roomConfig;
  }

  return at.toJwt();
}
