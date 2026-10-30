import { expect, test } from '@playwright/test';

/**
 * layman-qr-1600 — e2e referee for the ON-NETWORK layman QR flow (run against
 * the STAGE :8145, never live). Full flow lives in scripts/layman-scan-sim.mjs
 * (QR decode → join → voice); this spec pins the details the flow depends on:
 *   A. the stage's /pair still mints through the real pairing surface
 *   B. /bridge picks up the QR query params (?t=&b=) — the 5-line QR-pickup fix
 *   C. the trunk gate is fail-closed from a browser (bad token never signals)
 */
const BRIDGE_HTTP = process.env.LAYMAN_BRIDGE_HTTP || 'http://127.0.0.1:8148';
const ADMIN = process.env.LAYMAN_ADMIN_TOKEN || '';

test('A: stage /pair renders; mint is admin-gated (devices mode), admin mint works', async ({
  page,
  request,
}) => {
  await page.goto('/pair');
  await expect(page.getByText('Pair this device')).toBeVisible();
  // the stage runs BIFROST_AUTH=devices + BIFROST_ADMIN_TOKEN — an unauthenticated
  // mint must refuse (fail-closed); this is WHY the bootstrap mints the first
  // device itself with the admin token it printed
  const refused = await request.post('/api/pair', {
    data: { name: 'spec-no-auth' },
  });
  expect(refused.status()).toBe(403);
  const minted = await request.post('/api/pair', {
    data: { name: 'spec-admin-phone' },
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  expect(minted.ok()).toBeTruthy();
  const j = await minted.json();
  expect(j.token).toMatch(/^bfnd-/);
});

test('B: /bridge picks up QR query params (t= token, b= bridge url)', async ({ page }) => {
  await page.goto(
    '/bridge?t=bfnd-QRPARAM-pickup-check-0001&b=' + encodeURIComponent('http://127.0.0.1:8148')
  );
  await expect(page.getByTestId('bridge-token')).toHaveValue(/^bfnd-QRPARAM-pickup-check-0001$/, {
    timeout: 10000,
  });
  const stored = await page.evaluate(() => localStorage.getItem('bifrost_bridge'));
  expect(stored).toBe('http://127.0.0.1:8148');
});

test('C: bridge gate is fail-closed from a browser context', async ({ request }) => {
  const res = await request.post(`${BRIDGE_HTTP}/offer`, {
    data: { type: 'offer', sdp: 'v=0 bogus', candidates: [] },
    headers: { Authorization: 'Bearer bfnd-definitely-not-a-real-token-value' },
  });
  expect(res.status()).toBe(401);
});
