import { type ChildProcess, spawn } from 'child_process';
import { createHmac } from 'crypto';
import { existsSync, mkdtempSync } from 'fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { expect, test } from '@playwright/test';

/**
 * /api/token per mode, against the BUILT app (`node server.mjs` on a free loopback port, its
 * own env — nothing live is touched, no LiveKit needed: a mock answers its Twirp API):
 *   tailnet + LIVEKIT_* → mints exactly as before: a JWT for the room (HS256, the API secret),
 *     the voice agent dispatched (the mock sees CreateDispatch); GET says available
 *   tailnet, no LIVEKIT_* → 503 {error:"voice-unavailable"} — JSON, never an empty 500
 *   devices (a phone paired through the trunk) → 503 voice-unavailable even with LIVEKIT_* set:
 *     no mint, no dispatch (the auth is not loosened); a garbage credential is still 401 at
 *     the edge (the middleware's gate, unchanged)
 *   unreadable or room-less bodies → a JSON 400, never an empty answer
 */
const APP = resolve(__dirname, '..');
test.skip(!existsSync(join(APP, '.next/BUILD_ID')), 'needs the built app (npm run build)');
test.describe.configure({ mode: 'serial' });

const SECRET = 'lk-test-secret-0123456789abcdef0123456789';
const LK_ENV = {
  LIVEKIT_URL: 'wss://lk.test',
  LIVEKIT_API_KEY: 'lk-test-key',
  LIVEKIT_API_SECRET: SECRET,
};

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = net.createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => done(port));
    });
  });
}

/** a LiveKit server API that records every call and answers `{}` */
async function mockLiveKit() {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url || '', auth: String(req.headers.authorization || ''), body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((done) => srv.listen(port, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${port}`, calls, close: () => srv.close() };
}

/** the built app, its own process and env (env -i style: nothing from this shell leaks in) */
async function serve(env: Record<string, string>) {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: APP,
    env: {
      PATH: process.env.PATH || '',
      HOME: mkdtempSync(join(tmpdir(), 'voice-token-home-')),
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      OPENCODE_URL: 'http://127.0.0.1:9', // no brain: the token route never needs one
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${base}/api/ping`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 60_000, message: `the app did not come up:\n${log}` }
    )
    .toBeGreaterThan(0);
  return { base, stop: () => child.kill('SIGTERM'), log: () => log };
}

async function call(base: string, init: { method?: string; body?: string; bearer?: string } = {}) {
  const r = await fetch(`${base}/api/token`, {
    method: init.method || 'POST',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body,
  });
  const text = await r.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — every case below fails on it */
  }
  return { status: r.status, type: r.headers.get('content-type') || '', text, json };
}

/** HS256, checked by hand: the token is LiveKit's, signed with the API secret */
function verifyJwt(token: string, secret: string): Record<string, unknown> {
  const [h, p, sig] = token.split('.');
  const want = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  expect(sig, 'the JWT signature (HS256, LIVEKIT_API_SECRET)').toBe(want);
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
}

test('tailnet + LIVEKIT_* (mocked): /api/token still mints and dispatches the agent', async () => {
  const lk = await mockLiveKit();
  const app = await serve({ BIFROST_AUTH: 'tailnet', ...LK_ENV, LIVEKIT_API_URL: lk.url });
  try {
    const r = await call(app.base, { body: JSON.stringify({ room: 'main' }) });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({
      serverUrl: 'wss://lk.test',
      roomName: 'main',
      participantName: 'user',
    });
    const claims = verifyJwt(String(r.json!.participantToken), SECRET);
    expect(claims).toMatchObject({ iss: 'lk-test-key', sub: 'user_main' });
    expect(claims.video).toMatchObject({ room: 'main', roomJoin: true, canPublish: true });
    // the agent was dispatched to the room, as before
    expect(lk.calls.map((c) => c.url)).toEqual([
      '/twirp/livekit.AgentDispatchService/CreateDispatch',
    ]);
    expect(JSON.parse(lk.calls[0].body)).toMatchObject({ room: 'main', agentName: 'bifrost' });
    // can voice work here? yes — and asking mints nothing
    const g = await call(app.base, { method: 'GET' });
    expect(g.status).toBe(200);
    expect(g.json).toEqual({ voice: 'available' });
    expect(lk.calls).toHaveLength(1);
    // bad bodies answer JSON, never an empty 500
    for (const body of ['{}', 'not json', '']) {
      const b = await call(app.base, { body });
      expect(b.status, `${JSON.stringify(body)} → ${b.text}`).toBe(400);
      expect(b.json).toEqual({ error: 'room required' });
    }
  } finally {
    app.stop();
    lk.close();
  }
});

test('tailnet without LIVEKIT_*: 503 voice-unavailable, as JSON', async () => {
  const app = await serve({ BIFROST_AUTH: 'tailnet' });
  try {
    for (const method of ['POST', 'GET']) {
      const r = await call(app.base, {
        method,
        body: method === 'POST' ? '{"room":"main"}' : undefined,
      });
      expect(r.status, r.text).toBe(503);
      expect(r.type).toContain('application/json');
      expect(r.json).toMatchObject({ error: 'voice-unavailable' });
      expect(String(r.json!.why)).toContain('LiveKit');
    }
  } finally {
    app.stop();
  }
});

test('devices mode (the trunk): 503 voice-unavailable, nothing minted, the edge gate unchanged', async () => {
  const lk = await mockLiveKit();
  const dir = mkdtempSync(join(tmpdir(), 'voice-token-dev-'));
  const app = await serve({
    BIFROST_AUTH: 'devices',
    BIFROST_DEVICES_FILE: join(dir, 'devices.json'),
    ...LK_ENV,
    LIVEKIT_API_URL: lk.url,
  });
  try {
    // the box's own console (loopback, no credential) clears the gate — and still gets no token
    for (const method of ['POST', 'GET']) {
      const r = await call(app.base, {
        method,
        body: method === 'POST' ? '{"room":"main"}' : undefined,
      });
      expect(r.status, r.text).toBe(503);
      expect(r.json).toMatchObject({ error: 'voice-unavailable' });
      expect(String(r.json!.why)).toContain('trunk');
      expect(r.json).not.toHaveProperty('participantToken');
    }
    expect(lk.calls, 'no dispatch, no LiveKit call at all').toEqual([]);
    // a presented credential must stand on its own: garbage is refused at the edge, as before
    const bad = await call(app.base, { body: '{"room":"main"}', bearer: 'bfnd-not-a-real-token' });
    expect(bad.status).toBe(401);
    expect(bad.json).toMatchObject({ why: 'invalid', reauth: 'pair' });
  } finally {
    app.stop();
    lk.close();
  }
});
