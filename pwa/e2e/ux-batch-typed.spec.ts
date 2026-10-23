import { expect, test, type Page } from '@playwright/test';

/** UX-BATCH #2 — "I write text but that message stays" (10-23, MAIN, keyboard).
 *  The truth, both places a typed turn can start:
 *   A. the plain keyboard composer (a returning device): the draft leaves the
 *      composer at once, the echo resolves into ONE server message, the reply
 *      lands, "working…" clears, a reload brings no draft back;
 *   B. MAIN right after the door (first-turn card up): a typed turn is a turn —
 *      the card must not stay on "hold the mic" once the words went out.
 *  Throwaway sessions only — MAIN is never touched. */

const returning = async (page: Page, firstDone: boolean) => {
  await page.goto('/');
  await page.evaluate((done) => {
    localStorage.setItem('bifrost-door', 'v2');
    localStorage.setItem('bifrost-onboard', JSON.stringify({ lang: 'en', style: 'short' }));
    localStorage.setItem('oz-mode', 'text');
    if (done) localStorage.setItem('bifrost-first-turn', '1');
    else localStorage.removeItem('bifrost-first-turn');
  }, firstDone);
};

async function makeSession(request: import('@playwright/test').APIRequestContext, tag: string) {
  const name = `e2e-ux-${tag}-${Date.now().toString(36)}`;
  const r = await request.post('/api/session', { data: { name } });
  expect(r.ok()).toBe(true);
  return { slug: name, id: ((await r.json()) as { id: string }).id };
}

test('A · keyboard: typed turn → composer clears, one message, reply lands, busy clears', async ({
  page,
  request,
}) => {
  const s = await makeSession(request, 'typed');
  try {
    await returning(page, true);
    await page.goto(`/session/${s.slug}?id=${s.id}`);
    const box = page.getByPlaceholder('message…');
    const token = `kiwi${Date.now().toString(36).slice(-4)}`;
    const text = `Reply with exactly one word: ${token}`;
    await box.fill(text);
    await page.getByRole('button', { name: 'send', exact: true }).click();
    // the draft leaves the composer the instant it is sent
    await expect(box).toHaveValue('');
    const mine = page.locator('[data-mi]', { hasText: text });
    await expect(mine.first()).toBeVisible();
    // the reply (real yggdrasil run) lands after it
    await expect
      .poll(() => page.locator('[data-mi]', { hasText: new RegExp(token, 'i') }).count(), {
        timeout: 180_000,
      })
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByText('working…')).toHaveCount(0, { timeout: 30_000 });
    // the echo resolved into the server's message: exactly one, never two
    await expect(mine).toHaveCount(1);
    await page.reload();
    await expect(page.getByPlaceholder('message…')).toHaveValue('');
    await expect(page.locator('[data-mi]', { hasText: text })).toHaveCount(1);
  } finally {
    await request.delete(`/api/session/${s.id}`);
  }
});

test('B · after the door: a typed turn moves the first-turn card on (never stays on "hold the mic")', async ({
  page,
  request,
}) => {
  const s = await makeSession(request, 'ftype');
  try {
    await returning(page, false);
    await page.goto(`/session/${s.slug}?id=${s.id}&first=1`);
    const card = page.getByTestId('first-turn');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', /practice|mic/);
    const box = page.getByPlaceholder('message…');
    await box.fill('what is two plus two?');
    await page.getByRole('button', { name: 'send', exact: true }).click();
    await expect(box).toHaveValue('');
    // the words went out → the card says so, then the answer, then "you are in"
    await expect(card).toHaveAttribute('data-state', /sent|heard|in/, { timeout: 15_000 });
    await expect(card).toHaveAttribute('data-state', 'in', { timeout: 180_000 });
    expect(await page.evaluate(() => localStorage.getItem('bifrost-first-turn'))).toBeTruthy();
  } finally {
    await request.delete(`/api/session/${s.id}`);
  }
});

test.describe('the door offers typing (mic already allowed)', () => {
  test.use({ permissions: ['microphone'] });

  test('#1 · first turn: "or type it" next to the mic → typed round-trip → you are in', async ({
    page,
    request,
  }) => {
    const s = await makeSession(request, 'door-type');
    try {
      await returning(page, false);
      await page.goto(`/session/${s.slug}?id=${s.id}&first=1`);
      const card = page.getByTestId('first-turn');
      await expect(card).toHaveAttribute('data-state', 'practice');
      // two first-class ways in, side by side: hold the mic, or type
      await expect(card).toContainText('hold the mic');
      const type = page.getByTestId('first-type');
      await expect(type).toBeVisible();
      await expect(type).toContainText('or type it');
      await page.screenshot({ path: `${process.env.TF_SHOTS || '../artifacts'}/ux-batch-door-type-1.png` });
      await type.click();
      const box = page.getByPlaceholder('message…');
      await expect(box).toBeFocused(); // the keyboard comes up on the phone
      await box.pressSequentially('what is two plus two?');
      await box.press('Enter');
      await expect(box).toHaveValue('');
      await expect(card).toHaveAttribute('data-state', /sent|heard|in/, { timeout: 15_000 });
      // the same proof voice gives: YOUR words in the transcript (server copy), then the reply
      await expect(card).toHaveAttribute('data-state', /heard|in/, { timeout: 20_000 });
      await expect(card).toHaveAttribute('data-state', 'in', { timeout: 180_000 });
      await expect(page.getByTestId('first-in')).toBeVisible();
      await expect(page.getByText(/\b(4|four)\b/i).first()).toBeVisible();
      const diag = await page.evaluate(() =>
        (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { kind: string; msg: string }[]).map(
          (e) => `${e.kind} ${e.msg}`
        )
      );
      expect(diag.some((l) => /first-turn: typed turn landed/.test(l))).toBe(true);
      expect(diag.some((l) => /first-turn: reply \d+ms after send/.test(l))).toBe(true);
      await page.screenshot({ path: `${process.env.TF_SHOTS || '../artifacts'}/ux-batch-door-type-2-in.png` });
      await page.getByTestId('first-ok').click();
      await page.reload();
      await expect(page.getByTestId('first-turn')).toHaveCount(0); // never comes back
    } finally {
      await request.delete(`/api/session/${s.id}`);
    }
  });
});
