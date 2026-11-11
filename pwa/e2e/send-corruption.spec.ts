import { expect, test } from '@playwright/test';

/** Live 11-11 regression: the phone's POST body lost its front bytes in
 *  transit (degraded tailscale-serve h2 hop) — the server's req.json()
 *  threw a raw "SyntaxError: Unexpected non-whitespace character after
 *  JSON at position 1" 500, the user saw V8 internals, and the picked
 *  attachments were destroyed on every failed retry (×3, ~20 min). The
 *  route must answer an honest, actionable 400 — and the client must
 *  keep the draft + attachments so a retry is one tap. */
const NAME = `e2e-corrupt-${Date.now().toString(36)}`;
const HEADERS = {
  'X-Total-Count': '0',
  'X-Run-State': 'none|0|user',
  'X-Run-Live': '0',
  'X-Run-Live-Since': '0',
  'X-Run-Ended': '0',
  'Cache-Control': 'no-store',
};

test('server: corrupted upload → actionable 400, not a raw SyntaxError 500', async ({
  request,
}) => {
  const cr = await request.post('/api/session', { data: { name: NAME } });
  expect(cr.ok()).toBeTruthy();
  const s = (await cr.json()) as { id: string };
  // exactly the live corruption shape: a suffix of the original body —
  // front bytes cut mid-base64 (digit completes a number token, junk follows)
  const r = await request.post(`/api/session/${NAME}/messages`, {
    headers: { 'content-type': 'application/json' },
    // Buffer: the request fixture rewrites plain-string bodies otherwise
    data: Buffer.from(
      '4AAQSkZJRgABAQ' + 'M425G3OupIQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph'.repeat(8)
    ),
  });
  expect(r.status()).toBe(400);
  const d = (await r.json()) as { error?: string };
  expect(d.error || '').toContain('connection');
  expect(d.error || '').not.toContain('SyntaxError');
  await request.delete(`/api/session/${s.id}`);
});

test('client: failed send keeps text + attachments for a one-tap retry', async ({ page }) => {
  await page.route('**/api/session/*/messages*', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'the upload was cut up by the connection — send again',
        }),
      });
    }
    return route.fulfill({ headers: HEADERS, contentType: 'application/json', body: '[]' });
  });
  await page.goto(`/session/${NAME}?id=mock-${NAME}`);
  await page.getByRole('button', { name: 'attach', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles([
    {
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
    },
  ]);
  await expect(page.getByText('shot.png')).toBeVisible();
  await page.getByPlaceholder('message…').fill('hello retry');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  // the honest server message surfaces (not V8 internals)
  await expect(page.getByText(/cut up by the connection/)).toBeVisible();
  // the retry needs nothing re-typed or re-picked
  await expect(page.getByPlaceholder('message…')).toHaveValue('hello retry');
  await expect(page.getByText('shot.png')).toBeVisible();
});
