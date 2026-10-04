import { expect, test } from '@playwright/test';

/**
 * S1 seam (v0.9): device tokens at the seam — mint, gate, revoke.
 *
 * Runs against the self-hosted server (:8080). The server must run with
 * BIFROST_AUTH=devices for the gating half (the tailnet mode is the
 * zero-change default and is what production runs until graduation).
 */

const ADMIN = process.env.BIFROST_ADMIN_TOKEN || '';
const authHeaders = (token?: string) => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  'Content-Type': 'application/json',
});

test('pair mints a device token that opens /api and revocation closes it', async ({
  request,
}) => {
  // mint through the pairing surface (admin/tailnet-gated)
  const mint = await request.post('/api/pair', {
    data: { name: 'e2e-device' },
    headers: authHeaders(ADMIN),
  });
  expect(mint.status()).toBe(200);
  const { id, token } = await mint.json();
  expect(token).toMatch(/^bfnd-/);

  // the token validates and lists devices
  const list = await request.get('/api/pair', { headers: authHeaders(token) });
  expect(list.status()).toBe(200);
  const devices = (await list.json()).devices as Array<{ id: string; revoked: boolean }>;
  expect(devices.some((d) => d.id === id && !d.revoked)).toBeTruthy();

  // a garbage token must NOT list devices (mint route fail-closed)
  const bad = await request.get('/api/pair', {
    headers: authHeaders('bfnd-not-a-real-token-value'),
  });
  expect(bad.status()).toBe(401);

  // revoke
  const rev = await request.delete('/api/pair/devices', {
    data: { id },
    headers: authHeaders(ADMIN),
  });
  expect(rev.status()).toBe(200);

  // revoked token can no longer list…
  const after = await request.get('/api/pair', { headers: authHeaders(token) });
  expect(after.status()).toBe(401);
  // …and is gone from the admin view
  const adminList = await request.get('/api/pair', { headers: authHeaders(ADMIN) });
  const rest = (await adminList.json()).devices as Array<{ id: string; revoked: boolean }>;
  expect(rest.find((d) => d.id === id)?.revoked).toBe(true);
});

test('pairing refuses garbage admin credentials (fail closed)', async ({ request }) => {
  // when an admin token IS configured, a wrong one must 403; without one the
  // route rides the declared auth layer — assert the route never leaks a
  // token to an unauthenticated caller in devices mode is covered by the
  // middleware spec; here we assert the shape stays honest in tailnet mode.
  const mint = await request.post('/api/pair', {
    data: { name: 'fail-closed-probe' },
    headers: authHeaders(ADMIN ? 'bfnd-wrong-admin-token' : undefined),
  });
  if (ADMIN) {
    expect([401, 403]).toContain(mint.status());
  } else {
    // tailnet mode: trusted network mints — but the response must be a token
    expect((await mint.json()).token).toMatch(/^bfnd-/);
  }
});

/**
 * S1 FULL semantics (v0.9): short-lived region-bound access tokens, rotating
 * refresh with theft detection, one-time pairing codes, per-device rate
 * limits, spoof-proof box console. Needs the devices-mode server (server.mjs,
 * BIFROST_AUTH=devices) — see RELEASE-REPORT.md "run the ladder":
 *   PW_DEVICES_MODE=1 PW_LAN_URL=http://<lan-ip>:8095
 * Server env the timings below assume: BIFROST_ACCESS_TTL_S=30
 * BIFROST_PAIR_TTL_S=20 BIFROST_ROTATE_GRACE_S=2 BIFROST_RATE_BURST=120
 * BIFROST_RATE_PER_SEC=2.
 */
test.describe('S1 full semantics', () => {
  const LAN = process.env.PW_LAN_URL || '';
  test.skip(
    process.env.PW_DEVICES_MODE !== '1' || !LAN,
    'needs the devices-mode server + PW_LAN_URL (RELEASE-REPORT.md)',
  );

  test('access token is bound to its network region; re-auth = refresh, which rebinds', async ({
    playwright,
    request,
  }) => {
    const lan = await playwright.request.newContext({ baseURL: LAN });
    const mint = await lan.post('/api/pair', { data: { name: 'region-probe' }, headers: authHeaders(ADMIN) });
    expect(mint.status()).toBe(200);
    const { id, accessToken, refreshToken } = await mint.json();
    expect((await lan.get('/api/ping', { headers: authHeaders(accessToken) })).status()).toBe(200);

    // same token, another network → refused with the way back
    const moved = await request.get('/api/ping', { headers: authHeaders(accessToken) });
    expect(moved.status()).toBe(401);
    expect(await moved.json()).toMatchObject({ why: 'region', reauth: 'refresh' });

    // the refresh credential re-authenticates from the new region
    const ref = await request.post('/api/pair/refresh', { data: { refreshToken } });
    expect(ref.status()).toBe(200);
    const fresh = await ref.json();
    expect(fresh.regionChanged).toBe(true);
    expect((await request.get('/api/ping', { headers: authHeaders(fresh.accessToken) })).status()).toBe(200);
    const list = await (await request.get('/api/pair', { headers: authHeaders(ADMIN) })).json();
    expect(list.devices.find((d: { id: string }) => d.id === id)).toMatchObject({
      region: expect.stringMatching(/^lan:/),
      lastRegion: 'loopback',
      regionChanges: 1,
    });
    await lan.dispose();
  });

  test('refresh rotates; a replayed refresh token revokes the device (theft signal)', async ({
    request,
  }) => {
    const { accessToken, refreshToken: r1 } = await (
      await request.post('/api/pair', { data: { name: 'theft-probe' }, headers: authHeaders(ADMIN) })
    ).json();
    const rot = await (await request.post('/api/pair/refresh', { data: { refreshToken: r1 } })).json();
    expect(rot.refreshToken).not.toBe(r1);
    expect(rot.accessToken).not.toBe(accessToken);
    await new Promise((r) => setTimeout(r, 2500)); // past the race grace
    const replay = await request.post('/api/pair/refresh', { data: { refreshToken: r1 } });
    expect(replay.status()).toBe(401);
    expect((await replay.json()).why).toBe('reuse');
    // the whole lineage is dead, including the legitimately rotated tokens
    const after = await request.get('/api/ping', { headers: authHeaders(rot.accessToken) });
    expect((await after.json()).why).toBe('revoked');
    const r2 = await request.post('/api/pair/refresh', { data: { refreshToken: rot.refreshToken } });
    expect(r2.status()).toBe(401);
  });

  test('access tokens are short-lived: expiry answers reauth=refresh', async ({ request }) => {
    test.setTimeout(90_000);
    const { accessToken, refreshToken } = await (
      await request.post('/api/pair', { data: { name: 'ttl-probe' }, headers: authHeaders(ADMIN) })
    ).json();
    expect((await request.get('/api/ping', { headers: authHeaders(accessToken) })).status()).toBe(200);
    await new Promise((r) => setTimeout(r, 31_000));
    const late = await request.get('/api/ping', { headers: authHeaders(accessToken) });
    expect(late.status()).toBe(401);
    expect(await late.json()).toMatchObject({ why: 'expired', reauth: 'refresh' });
    const ref = await request.post('/api/pair/refresh', { data: { refreshToken } });
    expect(ref.status()).toBe(200);
  });

  test('pairing codes: one use, expiring, revoke-on-repair; spoofed console refused', async ({
    playwright,
    request,
  }) => {
    test.setTimeout(90_000);
    const lan = await playwright.request.newContext({ baseURL: LAN });
    // a LAN client claiming to be the box console (loopback) is not
    const spoof = await lan.post('/api/pair/code', {
      headers: { 'x-bifrost-peer': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },
    });
    expect(spoof.status()).toBe(403);

    const codeOf = async () => {
      const r = await request.post('/api/pair/code'); // loopback = the box console
      expect(r.status()).toBe(200);
      return new URLSearchParams((await r.json()).url.split('#')[1]).get('code')!;
    };
    const c1 = await codeOf();
    const first = await lan.post('/api/pair/claim', { data: { code: c1, name: 'claim-probe' } });
    expect(first.status()).toBe(200);
    const devA = (await first.json()).id;
    const replay = await lan.post('/api/pair/claim', { data: { code: c1 } });
    expect(replay.status()).toBe(410);
    expect((await replay.json()).why).toBe('used');

    // re-pair from the same browser (it still holds A's refresh cookie) retires A
    const second = await lan.post('/api/pair/claim', { data: { code: await codeOf(), name: 'claim-probe' } });
    const devB = (await second.json()).id;
    const reg = await (await request.get('/api/pair', { headers: authHeaders(ADMIN) })).json();
    const byId = (x: string) => reg.devices.find((d: { id: string }) => d.id === x);
    expect(byId(devA)).toMatchObject({ revoked: true, revokedWhy: 're-paired' });
    expect(byId(devB).revoked).toBe(false);

    const stale = await codeOf();
    await new Promise((r) => setTimeout(r, 21_000));
    const late = await lan.post('/api/pair/claim', { data: { code: stale } });
    expect(late.status()).toBe(410);
    expect((await late.json()).why).toBe('expired');
    await lan.dispose();
  });

  test('rate limit is per device credential', async ({ request }) => {
    const mint = async (name: string) =>
      (await (await request.post('/api/pair', { data: { name }, headers: authHeaders(ADMIN) })).json())
        .accessToken as string;
    const noisy = await mint('rate-noisy');
    const calm = await mint('rate-calm');
    const codes = await Promise.all(
      Array.from({ length: 160 }, () =>
        request.get('/api/ping', { headers: authHeaders(noisy) }).then((r) => r.status()),
      ),
    );
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(100);
    // another device's bucket is untouched
    expect((await request.get('/api/ping', { headers: authHeaders(calm) })).status()).toBe(200);
  });
});
