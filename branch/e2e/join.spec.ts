import { createHash } from 'crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import http from 'node:http';
import { join } from 'path';
import { type BrowserContext, devices, expect, test } from '@playwright/test';

/**
 * JOIN A NEW MACHINE (contract v1, docs/spec-join.md) — the hub side, end to end
 * on the isolated box scripts/v09-ladder.sh runs (app + brain + the trunk bridge
 * with its root-link dial-in plane on loopback):
 *
 *   pair a phone → a joiner (plain HTTP, its own source address) POSTs a join →
 *   the phone opens approve_url, compares the code, approves → the poller gets
 *   20 link tokens ONCE (second poll 410) → a minted token is ACCEPTED by the
 *   bridge's root-link plane (real ws dial; single-use; tamper refused) → the
 *   phone's roots allowlist in devices.json names the root (other records,
 *   v1 included, untouched) → refill with the root secret (+ its limit) →
 *   unique ids → refuse → expiry (pending and undelivered) → join rate limit.
 *
 * Ladder env: PW_DEVICES_MODE=1 PW_LAN_URL PW_V09_STATE PW_PEER_TOKEN
 * PW_JOIN_TTL_S (the app runs with BIFROST_JOIN_TTL_S to match).
 */

const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8095';
const LAN = process.env.PW_LAN_URL || '';
const STATE = process.env.PW_V09_STATE || '';
const ADMIN = process.env.BIFROST_ADMIN_TOKEN || '';
const PEER = process.env.PW_PEER_TOKEN || '';
const TTL_S = Number(process.env.PW_JOIN_TTL_S) || 600;
const MAIN_SLUG = process.env.PW_MAIN_SLUG || 'main';

test.skip(
  process.env.PW_DEVICES_MODE !== '1' || !LAN || !STATE,
  'needs the isolated box with the root-link plane (scripts/v09-ladder.sh e2e/join.spec.ts)'
);

type J = Record<string, unknown>;
type Res = { status: number; headers: http.IncomingHttpHeaders; body: J };

/** A plain HTTP call from a chosen source address (each joiner is its own client). */
function call(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; json?: unknown; from?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        localAddress: opts.from,
        headers: {
          ...(data
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(data)),
              }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let body: J = { raw: buf };
          try {
            body = JSON.parse(buf);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const LAN_HOST = LAN ? new URL(LAN).hostname : '';
/** joiner on the LAN (the box's own LAN address is the only one in the namespace) */
const fromLan = { from: LAN_HOST };
/** joiners on other addresses: loopback /8 gives the namespace as many as it likes */
const at = (n: number) => ({ base: BASE, from: `127.0.0.${n}` });

const joinFrom = (base: string, from: string, body: J) =>
  call('POST', `${base}/api/roots/join`, { json: body, from });
/** the poll URL names the public (LAN) origin; a loopback-sourced joiner dials it on loopback */
const poll = (url: string, secret: string, from = LAN_HOST) =>
  call('GET', from.startsWith('127.') ? url.replace(LAN, BASE) : url, {
    headers: { 'x-join-secret': secret },
    from,
  });

const payloadOf = (tok: string) =>
  JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString()) as {
    v: number;
    root: string;
    roots: string[];
    dev: string;
    iat: number;
    jti: string;
  };

/** Dial the bridge's root-link plane like a root does: ws, first frame = the link token. */
function dial(url: string, token: string): Promise<{ op: string; root?: string; err?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error('root-link dial timed out'));
    }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ op: 'root-link', token }));
    ws.onmessage = (ev) => {
      clearTimeout(t);
      ws.close();
      resolve(JSON.parse(String(ev.data)));
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('root-link ws error'));
    };
  });
}

const devicesFile = () => join(STATE, 'devices.json');
const readDevices = () =>
  JSON.parse(readFileSync(devicesFile(), 'utf8')) as {
    devices: Array<J & { id: string; roots?: string[] }>;
  };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** phone API calls ride the context's cookies; refresh first (the ladder's access TTL is 30 s) */
async function phoneApi(ctx: BrowserContext, method: 'get' | 'post', path: string) {
  expect((await ctx.request.post(`${LAN}/api/pair/refresh`)).status()).toBe(200);
  return ctx.request[method](`${LAN}${path}`);
}

test('join: QR approve → 20 link tokens once → bridge accepts → allowlist → refill · refuse · expiry · rate limit', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneCtx.newPage();
  let mainId = '';

  // the expiry case starts first so its clock runs while the rest goes on
  const expiring = await joinFrom(at(3).base, at(3).from, {
    name: 'slow box',
    os: 'linux',
    host: 'slow',
  });
  expect(expiring.status).toBe(201);
  const expiringAt = Date.now();

  let deviceId = '';
  await test.step('pair a phone (the box mints a code; the phone claims it and lands on home)', async () => {
    const code = await request.post(`${BASE}/api/pair/code`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(code.status()).toBe(200);
    const { url } = await code.json();
    expect(url.startsWith(`${LAN}/pair#`)).toBe(true);
    await phone.goto('about:blank');
    await phone.goto(url);
    await phone.waitForURL(`${LAN}/`, { timeout: 30_000 }); // home decides: the door or the list
    mainId = String(
      (await (await phoneCtx.request.get(`${LAN}/api/session/${MAIN_SLUG}`)).json()).id || ''
    );
    const pin = await phone.evaluate(() =>
      JSON.parse(localStorage.getItem('bifrost.pin') || 'null')
    );
    deviceId = pin?.deviceId;
    expect(deviceId).toMatch(/^dev_[0-9a-f]{8}$/);
  });

  let J1: J = {};
  await test.step('a joiner POSTs a join: 201 with req, secret, code, approve/poll URLs, expiry', async () => {
    const r = await joinFrom(LAN, LAN_HOST, {
      name: 'Mac Studio',
      os: 'macos',
      host: 'mac-studio.local',
    });
    expect(r.status).toBe(201);
    J1 = r.body;
    expect(J1.req).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(J1.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(J1.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(J1.approve_url).toBe(`${LAN}/join?r=${J1.req}`);
    expect(J1.poll_url).toBe(`${LAN}/api/roots/join/${J1.req}`);
    expect(J1.expires_in).toBe(TTL_S);
    expect((await poll(String(J1.poll_url), String(J1.secret))).body).toEqual({
      status: 'pending',
    });
    expect((await poll(String(J1.poll_url), String(J1.secret))).status).toBe(202);
    expect((await poll(String(J1.poll_url), 'f'.repeat(32))).status).toBe(401);
    expect((await poll(String(J1.poll_url), '')).status).toBe(401);
  });

  await test.step('approval needs a paired DEVICE: no session → /pair; console and admin token refused', async () => {
    const stranger = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await stranger.newPage();
    await page.goto(String(J1.approve_url));
    await page.waitForURL(/\/pair\?unpaired=1/, { timeout: 20_000 });
    await stranger.close();
    const approve = `/api/roots/join/${J1.req}/approve`;
    expect((await call('POST', `${LAN}${approve}`, fromLan)).status).toBe(401); // LAN, no token
    expect((await call('POST', `${BASE}${approve}`)).status).toBe(401); // the box console
    expect(
      (await call('POST', `${BASE}${approve}`, { headers: { Authorization: `Bearer ${ADMIN}` } }))
        .status
    ).toBe(401); // the admin token is not a device
    expect((await call('GET', `${LAN}/api/roots/join/${J1.req}/view`, fromLan)).status).toBe(401);
    expect((await call('GET', `${LAN}/api/roots`, fromLan)).status).toBe(401);
    expect((await poll(String(J1.poll_url), String(J1.secret))).status).toBe(202);
  });

  // a v1 record (non-expiring tokenHash + its own allowlist) shares the file:
  // the approval must leave it exactly as it was, and never hand out its root id
  const v1 = {
    id: 'dev_v1seed0',
    name: 'legacy-v1',
    tokenHash: sha256('bfnd-v1-legacy-seed-token-value'),
    created: new Date(0).toISOString(),
    revoked: false,
    roots: ['old-box'],
  };
  await test.step('the phone opens approve_url, sees the same code, adds the machine', async () => {
    // a fresh access token: no refresh (a registry write) can land between the seed and the check
    expect((await phoneCtx.request.post(`${LAN}/api/pair/refresh`)).status()).toBe(200);
    const reg = readDevices();
    reg.devices.push(v1);
    writeFileSync(`${devicesFile()}.seed`, JSON.stringify(reg, null, 2), { mode: 0o600 });
    renameSync(`${devicesFile()}.seed`, devicesFile());

    await phone.goto(String(J1.approve_url));
    await expect(phone.getByTestId('join-code')).toHaveText(String(J1.code));
    await expect(phone.getByTestId('join-name')).toHaveText('Mac Studio');
    await expect(phone.getByTestId('join-os')).toHaveText('macos');
    await expect(phone.getByTestId('join-host')).toHaveText('mac-studio.local');
    await phone.getByTestId('join-approve').click();
    await expect(phone.getByTestId('join-status')).toContainText('mac-studio');

    const after = readDevices();
    expect(after.devices.find((d) => d.id === deviceId)?.roots).toEqual(['mac-studio']);
    expect(after.devices.find((d) => d.id === v1.id)).toEqual(v1);
  });

  let A: J = {};
  await test.step('the poller gets the result ONCE: 20 link tokens, root secret, rootlink url, peer token', async () => {
    const r = await poll(String(J1.poll_url), String(J1.secret));
    expect(r.status).toBe(200);
    A = r.body;
    expect(A.status).toBe('approved');
    expect(A.root_id).toBe('mac-studio');
    expect(A.root_secret).toMatch(/^[0-9a-f]{32}$/);
    // the hub brain's root name, asked of the brain (the ladder's is "home"): the joined root's way home
    expect(A.hub).toBe('home');
    expect(A.peer_token).toBe(PEER);
    expect(A.rootlink_url).toMatch(/^wss?:\/\//);
    const toks = A.link_tokens as string[];
    expect(toks).toHaveLength(20);
    expect(new Set(toks).size).toBe(20);
    for (const t of toks) {
      const p = payloadOf(t);
      expect(p).toMatchObject({ v: 1, root: 'mac-studio', roots: ['mac-studio'], dev: deviceId });
      expect(Math.abs(p.iat - Date.now() / 1000)).toBeLessThan(120);
    }
    const again = await poll(String(J1.poll_url), String(J1.secret));
    expect(again.status).toBe(410);
    expect(again.body.status).toBe('expired');
  });

  await test.step('the bridge root-link plane ACCEPTS a minted token (single use; tamper refused)', async () => {
    const url = String(A.rootlink_url);
    const toks = A.link_tokens as string[];
    expect(await dial(url, toks[0])).toMatchObject({ op: 'root-link.ok', root: 'mac-studio' });
    const replay = await dial(url, toks[0]);
    expect(replay.op).toBe('root-link.error');
    expect(replay.err).toContain('already used');
    const [body, sig] = toks[1].split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...payloadOf(toks[1]), roots: ['mac-studio', 'other'] })
    ).toString('base64url');
    expect(forged).not.toBe(body);
    expect((await dial(url, `${forged}.${sig}`)).op).toBe('root-link.error');
    expect(await dial(url, toks[1])).toMatchObject({ op: 'root-link.ok', root: 'mac-studio' });
  });

  await test.step('at rest: roots.json (mode 600) holds only the root secret hash', async () => {
    const file = join(STATE, 'roots.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(String(A.root_secret));
    expect(text).not.toContain(String(J1.secret));
    for (const t of A.link_tokens as string[]) expect(text).not.toContain(t.split('.')[1]);
    const rec = JSON.parse(text).roots.find((r: J) => r.id === 'mac-studio');
    expect(rec).toMatchObject({
      name: 'Mac Studio',
      os: 'macos',
      host: 'mac-studio.local',
      dev: deviceId,
      secretHash: sha256(String(A.root_secret)),
    });
    expect(rec.delivered_at).toBeTruthy();
  });

  await test.step('GET /api/roots (device) lists the joined machine', async () => {
    const r = await phoneApi(phoneCtx, 'get', '/api/roots');
    expect(r.status()).toBe(200);
    const roots = (await r.json()).roots as J[];
    const mine = roots.find((x) => x.id === 'mac-studio');
    expect(mine).toMatchObject({ name: 'Mac Studio', os: 'macos', host: 'mac-studio.local' });
    expect(Date.parse(String(mine?.joined_at))).toBeGreaterThan(Date.now() - 300_000);
  });

  await test.step('refill: the root secret buys 20 more (a fresh one dials in); wrong secret 401; limited', async () => {
    const url = `${LAN}/api/roots/mac-studio/tokens`;
    const bad = await call('POST', url, {
      headers: { 'x-root-secret': 'a'.repeat(32) },
      ...fromLan,
    });
    expect(bad.status).toBe(401);
    expect((await call('POST', `${LAN}/api/roots/nope/tokens`, fromLan)).status).toBe(401);
    const ok = await call('POST', url, {
      headers: { 'x-root-secret': String(A.root_secret) },
      ...fromLan,
    });
    expect(ok.status).toBe(200);
    const more = ok.body.link_tokens as string[];
    expect(more).toHaveLength(20);
    const first = new Set(A.link_tokens as string[]);
    expect(more.every((t) => !first.has(t))).toBe(true);
    expect(payloadOf(more[0])).toMatchObject({ root: 'mac-studio', dev: deviceId });
    expect(await dial(String(A.rootlink_url), more[7])).toMatchObject({ op: 'root-link.ok' });
    // default limit 6 per hour per root: 5 more succeed, the next is 429
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await call('POST', url, {
        headers: { 'x-root-secret': String(A.root_secret) },
        ...fromLan,
      });
      codes.push(r.status);
      if (r.status === 429) expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  let undelivered: J = {};
  let undeliveredAt = 0;
  await test.step('ids are unique: never an allowlisted id, never local, never a taken one, never the hub brain', async () => {
    const cases: Array<[number, string, string]> = [
      [4, 'Old Box', 'old-box-2'], // the v1 record's allowlist already names old-box
      [5, 'Mac Studio', 'mac-studio-2'],
      [6, 'local', 'local-2'],
      [7, 'home', 'home-2'], // the hub brain is "home": a root by that name would be its own peer
    ];
    for (const [n, name, want] of cases) {
      const j = await joinFrom(at(n).base, at(n).from, { name, os: 'linux', host: `h${n}` });
      expect(j.status).toBe(201);
      const r = await phoneApi(phoneCtx, 'post', `/api/roots/join/${j.body.req}/approve`);
      expect(r.status()).toBe(200);
      expect((await r.json()).root_id).toBe(want);
      if (want === 'local-2') {
        undelivered = j.body; // never collected: expires below
        undeliveredAt = Date.now();
      } else
        expect(
          (await poll(String(j.body.poll_url), String(j.body.secret), at(n).from)).status
        ).toBe(200);
    }
    const mine = readDevices().devices.find((d) => d.id === deviceId);
    expect(mine?.roots).toEqual(['mac-studio', 'old-box-2', 'mac-studio-2', 'local-2', 'home-2']);
  });

  await test.step('refuse: the phone says no → the poller gets 410 refused; approve after is 409', async () => {
    const j = await joinFrom(at(2).base, at(2).from, {
      name: 'unknown laptop',
      os: 'windows',
      host: 'x',
    });
    expect(j.status).toBe(201);
    await phone.goto(String(j.body.approve_url));
    await expect(phone.getByTestId('join-code')).toHaveText(String(j.body.code));
    await phone.getByTestId('join-refuse').click();
    await expect(phone.getByTestId('join-status')).toContainText('refused');
    const r = await poll(String(j.body.poll_url), String(j.body.secret), at(2).from);
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ status: 'refused' });
    expect(
      (await phoneApi(phoneCtx, 'post', `/api/roots/join/${j.body.req}/approve`)).status()
    ).toBe(409);
  });

  await test.step('expiry: a pending join and an undelivered approval both answer 410 expired', async () => {
    const wait = expiringAt + (TTL_S + 1) * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const e = expiring.body;
    const r = await poll(String(e.poll_url), String(e.secret), at(3).from);
    expect(r.status).toBe(410);
    expect(r.body.status).toBe('expired');
    expect((await phoneApi(phoneCtx, 'post', `/api/roots/join/${e.req}/approve`)).status()).toBe(
      410
    );
    await phone.goto(String(e.approve_url));
    await expect(phone.getByTestId('join-status')).toContainText('expired');
    await expect(phone.getByTestId('join-approve')).toHaveCount(0);

    // approved but never collected: the raw secrets are dropped after the hold window
    const hold = undeliveredAt + (TTL_S + 1) * 1000 - Date.now();
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    const u = await poll(String(undelivered.poll_url), String(undelivered.secret), at(6).from);
    expect(u.status).toBe(410);
    expect(u.body).toEqual({ status: 'expired', why: 'undelivered' });
    const list = (await (await phoneApi(phoneCtx, 'get', '/api/roots')).json()).roots as J[];
    expect(list.find((x) => x.id === 'local-2')?.delivered_at).toBeNull();
  });

  await test.step('join is rate-limited per client address: 5 per 10 min, then 429', async () => {
    const codes: number[] = [];
    let retry = 0;
    for (let i = 0; i < 6; i++) {
      const r = await joinFrom(at(9).base, at(9).from, {
        name: `spam ${i}`,
        os: 'linux',
        host: 's',
      });
      codes.push(r.status);
      if (r.status === 429) retry = Number(r.headers['retry-after']);
    }
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
    expect(retry).toBeGreaterThan(500);
    expect(retry).toBeLessThanOrEqual(600);
    // another address is its own bucket
    expect((await joinFrom(at(10).base, at(10).from, { name: 'other', os: 'linux' })).status).toBe(
      201
    );
    // a join without a name or host is refused
    expect((await joinFrom(at(11).base, at(11).from, {})).status).toBe(400);
  });

  if (MAIN_SLUG !== 'main' && mainId) {
    await phoneApi(phoneCtx, 'get', '/api/ping');
    await phoneCtx.request.delete(`${LAN}/api/session/${mainId}`);
  }
  await phoneCtx.close();
});
