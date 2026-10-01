import { expect, test } from '@playwright/test';

const NAME = `e2e-base-${Date.now().toString(36)}`;
let sessionId = '';

test('home: sessions list renders from live opencode', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bifrost' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'new session' })).toBeVisible();
  // at least one real session row (list must never be silently empty)
  const rows = page.locator('ul button');
  await expect(rows.first()).toBeVisible();
});

test('create session → opens session view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  await expect(page.getByText('empty session')).toBeVisible();
  // capture ?id= for cleanup + later specs
  sessionId = new URL(page.url()).searchParams.get('id') || '';
  expect(sessionId).toBeTruthy();
});

test('text round-trip: prompt → busy → assistant reply → busy clears', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  await page.getByPlaceholder('message…').fill('Reply with exactly: pong');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  // optimistic echo shows instantly
  await expect(page.getByText('(you)').first()).toBeVisible();
  // agent replies (real opencode run — generous window)
  await expect(page.getByText('pong')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('(agent')).toBeVisible();
  // busy indicator must be gone (run settled, not merely first step)
  await expect(page.getByText('working…')).toHaveCount(0);
});

test('messages proxy exposes run-state headers', async ({ request }) => {
  const r = await request.get(`/api/session/${sessionId}/messages?limit=60`);
  expect(r.ok()).toBeTruthy();
  expect(r.headers()['x-total-count']).toBeDefined();
  expect(r.headers()['x-run-state']).toBeDefined();
});

test('attachments: image + file chips, remove, send via REST', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  await page.getByRole('button', { name: 'attach', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# hello\nworld') },
    {
      name: 'dot.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
    },
  ]);
  await expect(page.getByText('note.md')).toBeVisible();
  await expect(page.getByText('dot.png')).toBeVisible();
  // remove the image chip, keep the file
  await page.getByRole('button', { name: 'remove dot.png' }).click();
  await expect(page.getByText('dot.png')).toHaveCount(0);
  await page.getByRole('button', { name: 'send', exact: true }).click();
  // the sent file lands in the transcript as its own collapsible chunk
  await expect(page.locator('[data-mi] summary', { hasText: 'note.md' })).toBeVisible({
    timeout: 30_000,
  });
});

test('voice: PTT connects to LiveKit, keyboard mode keeps the room warm', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  let livekitWs = 0;
  const sockets: Array<{ isClosed(): boolean }> = [];
  page.on('websocket', (ws) => {
    if (ws.url().includes('7880') || ws.url().includes('livekit')) {
      livekitWs += 1;
      sockets.push(ws);
    }
  });
  // the mic is tap-to-toggle / hold-to-talk (req 09-30): a real PTT press is
  // a HOLD — a click would now classify as a tap and toggle hands-free
  const micBtn = page.getByRole('button', { name: 'push to talk' });
  await micBtn.hover();
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
  await expect
    .poll(() => livekitWs, { timeout: 30_000, message: 'no LiveKit websocket opened' })
    .toBeGreaterThan(0);
  // compact mic UI: no persistent banner — the opened socket above IS the
  // connect proof; the button just has to stay usable
  await expect(page.getByRole('button', { name: 'push to talk' })).toBeEnabled();
  // keyboard mode releases the mic CAPTURE DEVICE but keeps the room + agent
  // warm: a teardown forced the next press to re-dispatch the voice agent and
  // a hold shorter than that join dropped the whole turn (req 09-29). The
  // LiveKit socket must therefore STAY open after the switch. The only mode
  // switch is the composer mic (req 09-30): a TAP toggles hands-free —
  // text → hands-free → text, the button never moves.
  await micBtn.click();
  await page.getByRole('button', { name: 'leave hands-free' }).click();
  await expect
    .poll(() => sockets.filter((s) => s.isClosed()).length, {
      timeout: 5_000,
      message: 'keyboard mode must keep the room warm (only the mic device is released)',
    })
    .toBe(0);
});

test('hands-free mode arms without error', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  // tap the composer mic (req 09-30): the tap toggles hands-free on
  await page.getByRole('button', { name: 'push to talk' }).click();
  await expect(page.getByText(/hands-free/).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'leave hands-free' }).click();
  await expect(page.getByTestId('free-phase')).toHaveCount(0);
});

test('cleanup: delete the e2e session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  const r = await request.delete(`/api/session/${sessionId}`);
  expect(r.ok()).toBeTruthy();
});
