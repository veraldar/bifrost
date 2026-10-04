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
