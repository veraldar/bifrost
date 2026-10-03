import { NextResponse } from 'next/server';
import {
  AccessToken,
  type AccessTokenOptions,
  AgentDispatchClient,
  RoomConfiguration,
  type VideoGrant,
} from 'livekit-server-sdk';

// must match agent/agent.py: @server.rtc_session(agent_name=...)
const AGENT_NAME = 'bifrost';

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

// don't cache the results
export const revalidate = 0;

export async function POST(req: Request) {
  // make an exception for the vercel preview environment
  if (process.env.NODE_ENV !== 'development' && process.env.BIFROST_AUTH !== 'tailnet') {
    throw new Error(
      'THIS API ROUTE IS INSECURE. DO NOT USE THIS ROUTE IN PRODUCTION WITHOUT AN AUTHENTICATION LAYER.'
    );
  }

  try {
    if (LIVEKIT_URL === undefined) {
      throw new Error('LIVEKIT_URL is not defined');
    }
    if (API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }

    // Parse room config from request body.
    const body = await req.json();
    const roomConfig = body?.room_config
      ? RoomConfiguration.fromJson(body.room_config, { ignoreUnknownFields: true })
      : new RoomConfiguration();

  // Room = session slug passed by the sessions shell.
  const rawRoom = String(body?.room || '');
  console.log(`[token] raw room=${JSON.stringify(body?.room)} referer=${req.headers.get('referer')}`);
  const roomName = rawRoom.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  // a room-less mint used to fall back to `session_<random>` — the agent
  // then spawned a phantom opencode session titled after it (2026-09-29
  // session_6898 storm). Refuse instead: callers must name the room.
  if (!roomName) {
    return NextResponse.json({ error: 'room required' }, { status: 400 });
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
      serverUrl: LIVEKIT_URL,
      roomName,
      participantName,
      participantToken,
    };
    const headers = new Headers({
      'Cache-Control': 'no-store',
    });
    return NextResponse.json(data, { headers });
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return new NextResponse(error.message, { status: 500 });
    }
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
