import { type Page, expect, test } from '@playwright/test';

/** VOICE-BUGS 11-11: footer textless in ptt · one owner bubble per send · reply speaks to the end. */
const S22 = { width: 360, height: 780 };
// UXCALM_SHOTS=<dir>: phone shots of the footer per state (for the report)
const SHOTS = process.env.VB_SHOTS || '';
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/vb1111-${name}.png` });
};
test.use({
  viewport: S22,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  permissions: ['microphone'],
});

const made: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of made.splice(0)) await page.request.delete(`/api/session/${id}`);
});

async function newSession(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/session', { data: { name } });
  expect(r.ok()).toBe(true);
  const j = (await r.json()) as { id?: string };
  if (j.id) made.push(j.id);
  return `/session/${name}${j.id ? `?id=${j.id}` : ''}`;
}

// the reply's speech, without the Mac: 6 s of a 220 Hz tone, after a visible
// "synthesizing" (the deck's own path — fetch, decode, play)
async function stubTts(page: Page) {
  const pcm = Buffer.alloc(24000 * 6 * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  await page.route('**/api/tts/stream', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: pcm });
  });
}

async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  return { send, done: () => cdp.detach() };
}

const REPLY = process.env.PW_BASE_URL?.includes(':8096') ? 'reply with exactly: calm' : 'Reply with exactly: calm';

test('one owner bubble per send (double tap too), footer textless in ptt, reply speaks to the end', async ({ page }) => {
  test.setTimeout(240_000);
  await stubTts(page);
  await page.goto(await newSession(page, `e2e-vb1111-${Date.now().toString(36)}`));
  const ta = page.getByPlaceholder('message…');
  await expect(ta).toBeVisible();
  const phase = page.locator('.oz-phase');

  // ptt: held mic → "heard" rides aria-label + data-s, NEVER text
  const mic = (await page.getByTestId('composer-mic').boundingBox())!;
  const f = await finger(page);
  await f.send('touchStart', mic.x + mic.width / 2, mic.y + mic.height / 2);
  await expect(phase).toHaveAttribute('aria-label', 'heard', { timeout: 30_000 });
  await page.waitForTimeout(300);
  expect((await page.locator('.oz-dock, .oz-deck, .oz-phase').allInnerTexts()).join('').trim(), 'footer text during ptt').toBe('');
  await shot(page, 'ptt-footer-empty');
  await f.send('touchEnd');
  await f.done();

  // one text turn, send tapped twice in a row → still exactly one owner bubble
  await ta.fill(REPLY);
  const send = page.getByRole('button', { name: 'send', exact: true });
  await send.tap();
  await send.tap({ timeout: 500 }).catch(() => {});
  await expect(page.locator('header [aria-label="working"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('listen-chip')).toBeVisible({ timeout: 120_000 });
  const owner = page.getByText(REPLY, { exact: true });
  await page.waitForTimeout(3_500); // past a full poll: the echo must have been reconciled
  await expect(owner).toHaveCount(1);
  await shot(page, 'single-bubble');

  // the reply actually plays: synthesizing → deck → ends on its own, footer stays textless
  await page.getByTestId('listen-chip').tap();
  await expect(page.locator('.oz-deck')).toBeVisible({ timeout: 10_000 });
  expect((await page.locator('.oz-dock, .oz-deck, .oz-phase').allInnerTexts()).join('').trim()).toBe('');
  await expect(page.locator('.oz-deck')).toHaveCount(0, { timeout: 30_000 });
  await expect(phase).toHaveAttribute('data-s', 'idle');
  await shot(page, 'after-reply-idle');
});
