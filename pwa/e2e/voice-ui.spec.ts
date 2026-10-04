import { expect, test } from '@playwright/test';

/** The one voice-state token (cohesive-2 signal path): rail + glyph + exact
 *  words move together, so color is never the only signal. Covers the held
 *  mic (heard), slide-to-delete (drop), hands-free with its tap-to-send
 *  strip, and the way back to idle. No LLM run needed. */
const NAME = `e2e-voiceui-${Date.now().toString(36)}`;
let sessionId = '';

test.beforeAll(async ({ request }) => {
  sessionId = (await (await request.post('/api/session', { data: { name: NAME } })).json()).id;
});
test.afterAll(async ({ request }) => {
  if (sessionId) await request.delete(`/api/session/${sessionId}`);
});

test('rail, glyph and words follow every voice state', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  const rail = page.locator('.oz-rail');
  const phase = page.locator('.oz-phase');
  await expect(rail).toHaveAttribute('data-s', 'idle');
  await expect(phase).toContainText('○');
  await expect(phase).toContainText('hold the mic to talk');

  // hold the mic → heard: amber rail, ◉, the held key glows
  const mic = page.getByRole('button', { name: 'push to talk' });
  const mb = (await mic.boundingBox())!;
  await page.mouse.move(mb.x + mb.width - 3, mb.y + mb.height / 2);
  await page.mouse.down();
  await expect(rail).toHaveAttribute('data-s', 'heard');
  await expect(phase).toContainText('◉');
  await expect(mic).toHaveClass(/\bheard\b/);
  await expect(page.getByRole('status', { name: 'listening' })).toBeVisible({ timeout: 30_000 });
  await expect(phase).toContainText('release to send');

  // slide left inside the key → drop armed: red, ×, words say what release does
  await page.mouse.move(mb.x + 4, mb.y + mb.height / 2, { steps: 6 });
  await expect(rail).toHaveAttribute('data-s', 'drop');
  await expect(phase).toContainText('release to delete');
  await page.mouse.up();
  await expect(rail).toHaveAttribute('data-s', 'idle');

  // tap → hands-free: heard while listening, the strip is tap-to-send
  await mic.click();
  const free = page.getByTestId('free-phase');
  await expect(free).not.toContainText('connecting', { timeout: 30_000 });
  await expect(rail).toHaveAttribute('data-s', 'heard');
  await expect(free).toContainText('tap the bars to send');
  await expect(page.getByRole('button', { name: 'send what you said' })).toBeEnabled();
  // the exit click must be a real gesture: within 400ms of the entering tap
  // it IS the gesture's ghost and the free-dock guard swallows it (see
  // freeGhostGuardRef) — wait out the window like a human finger would
  await page.waitForTimeout(450);
  await page.getByRole('button', { name: 'leave hands-free' }).click();
  await expect(free).toHaveCount(0);
  await expect(rail).toHaveAttribute('data-s', 'idle');
});
