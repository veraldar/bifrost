import { type Page, expect, test } from '@playwright/test';

/** THE DOOR (v2), end to end on the SANDBOX (:8090, own config —
 *  playwright.tree-first.config.ts): fresh device → the tree in the server
 *  HTML → press = amber in the same frame → release = the greeting from the
 *  pre-recorded pack → language · style (MAIN seeded with them) · the brain
 *  the box runs, shown → MAIN with the first-turn card → home: list + corner
 *  door, MAIN locked. The voice turn itself is first-turn-voice.spec.ts. */

const SHOTS = process.env.TF_SHOTS || '../artifacts';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/door-${name}.png` });

/** diag events persist in localStorage (lib/diag.ts ring) */
async function diag(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { kind: string; msg: string }[]).map(
      (e) => `${e.kind} ${e.msg}`
    )
  );
}
async function firstAudioMs(page: Page, id: string, lang = 'en'): Promise<number> {
  const re = new RegExp(`prerender ${id} ${lang} first audio (\\d+)ms`);
  let ms = -1;
  await expect
    .poll(
      async () => {
        const hit = (await diag(page)).map((l) => re.exec(l)).find(Boolean);
        ms = hit ? Number(hit[1]) : -1;
        return ms;
      },
      { timeout: 10_000, message: `no first audio for ${id}` }
    )
    .toBeGreaterThanOrEqual(0);
  return ms;
}

test('door: first paint → hold → greeting → language · style · brain → MAIN', async ({ page, request }) => {
  test.setTimeout(180_000);

  // 0 · the tree is in the server HTML: it paints before any script runs
  const html = await (await request.get('/')).text();
  expect(html).toContain('data-testid="tree-first"');
  expect(html).toContain('hold the tree to begin');
  expect(html).toContain("localStorage.removeItem('labmic')"); // the boot script heals stuck phones

  // 1 · a fresh device: the tree alone — no list, no chrome
  const mp3s: { url: string; at: number }[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/onboarding/')) mp3s.push({ url: r.url(), at: Date.now() });
  });
  await page.goto('/');
  // the user's phone after the 10-14 run: a stuck lab-mic flag, and v1's
  // abandoned setup left hands-free armed — the door must undo both
  await page.evaluate(() => {
    localStorage.setItem('labmic', '1');
    localStorage.setItem('oz-mode', 'free');
    localStorage.setItem('tree-first-prev-mode', 'text');
  });
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('labmic'))).toBeNull();
  const tree = page.getByTestId('tree-first');
  await expect(tree).toBeVisible();
  await expect(page.locator('header')).toHaveCount(0);
  await expect(page.getByTestId('tree-door')).toHaveCount(0);
  await expect(page.getByText('hold the tree to begin')).toBeVisible();
  await shot(page, '1-first-open');

  // 2 · press → amber in the same frame (no React round-trip)
  const b = (await tree.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  expect(await tree.evaluate((el) => el.classList.contains('heard'))).toBe(true);
  await expect(page.getByText('heard', { exact: true })).toBeVisible();
  await shot(page, '2-held');
  // the greeting was fetched into memory before the finger landed
  expect(mp3s.some((m) => m.url.endsWith('/onboarding/en/greet.mp3'))).toBe(true);

  // 3 · release → the door speaks: greeting from the pack, ≤ 1 s to first audio
  await page.mouse.up();
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'lang');
  await expect(page.getByTestId('door-say')).toContainText('this is bifrost');
  const greetMs = await firstAudioMs(page, 'greet');
  console.log(`door: greet first audio ${greetMs}ms`);
  expect(greetMs).toBeLessThanOrEqual(1_000);
  await shot(page, '3-greeting');

  // 4 · language → style; the pick is confirmed in the same voice
  await page.getByTestId('door-lang-en').click();
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'style');
  await expect(page.getByTestId('door-say')).toContainText(/english|short answers/);
  const confirmMs = await firstAudioMs(page, 'lang_set');
  console.log(`door: answer → spoken confirmation ${confirmMs}ms`);
  expect(confirmMs).toBeLessThanOrEqual(1_000);
  await shot(page, '4-style');

  // 5 · style → MAIN is seeded with both answers, the brain is SHOWN
  const seeded = page.waitForResponse(
    (r) => r.url().endsWith('/api/onboard') && r.request().method() === 'POST'
  );
  await page.getByTestId('door-style-short').click();
  const res = await seeded;
  expect(res.status()).toBe(200);
  expect(JSON.parse(res.request().postData() || '{}')).toEqual({
    step: 'main',
    prefs: { lang: 'en', style: 'short' },
  });
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'brain');
  const box = (await (await request.get('/api/onboard')).json()) as {
    brain: { model: string; class: string };
  };
  await expect(page.getByTestId('door-brain')).toContainText(box.brain.model);
  await expect(page.getByTestId('door-brain')).toContainText('set on the box');
  await expect(page.getByTestId('door-say')).toContainText('the brain', { timeout: 15_000 });
  // desktop (fine pointer, no touch): the QR hands the door to the phone
  await expect(page.getByTestId('door-qr').locator('img')).toBeVisible();
  await expect(page.getByTestId('door-enter')).toHaveText('continue here');
  await shot(page, '5-brain-qr');

  // 6 · enter → MAIN, planted, the first-turn card — no voice turn here
  await page.getByTestId('door-enter').click();
  await page.waitForURL(/\/session\/main\?id=.+&first=1/, { timeout: 20_000 });
  const card = page.getByTestId('first-turn');
  await expect(card).toBeVisible();
  if ((await card.getAttribute('data-state')) === 'mic') {
    await page.getByTestId('first-allow-mic').click();
  }
  await expect(card).toHaveAttribute('data-state', 'practice');
  await expect(card).toContainText('planted. this is main.');
  await expect(card).toContainText('hold the mic');
  const ls = await page.evaluate(() => ({
    door: localStorage.getItem('bifrost-door'),
    prefs: localStorage.getItem('bifrost-onboard'),
    first: localStorage.getItem('bifrost-first-turn'),
    labmic: localStorage.getItem('labmic'),
    mode: localStorage.getItem('oz-mode'),
    prev: localStorage.getItem('tree-first-prev-mode'),
    shrink: sessionStorage.getItem('tree-first-shrink'),
  }));
  expect(ls).toEqual({
    door: 'v2',
    prefs: JSON.stringify({ lang: 'en', style: 'short' }),
    first: null,
    labmic: null,
    mode: 'text', // the first turn is hold-to-talk: never hands-free here
    prev: null,
    shrink: '1',
  });
  await expect(page.getByTestId('composer-mic')).toBeVisible();
  // a TAP is not a turn (and never flips hands-free during the first turn)
  const mic = page.getByTestId('composer-mic');
  await mic.click({ delay: 60 });
  await expect(card).toContainText('released — nothing sent');
  await expect(page.getByTestId('free-strip')).toHaveCount(0);
  const lines = await diag(page);
  expect(lines.some((l) => /prerender miss/.test(l))).toBe(false);
  await shot(page, '6-main-first-turn');

  // 7 · home afterwards: the list + the tree shrunk to its corner, MAIN locked
  await page.goto('/');
  const door = page.getByTestId('tree-door');
  await expect(door).toBeVisible();
  await expect(page.getByTestId('tree-first')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'BIFROST' })).toBeVisible();
  await expect(door).not.toHaveClass(/shrink/, { timeout: 5_000 });
  await expect(door).toHaveAttribute('href', '/session/main');
  const mainRow = page.locator('.oz-sw', { hasText: '[MAIN]' });
  await expect(mainRow).toHaveCount(1);
  await expect(mainRow).toHaveAttribute('data-locked', '');
  expect((await request.delete('/api/session/main')).status()).toBe(403);
  await shot(page, '7-corner-door');

  // 8 · a returning device never sees the door again (hidden before paint)
  await page.reload();
  await expect(page.getByTestId('tree-first')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.door)).toBe('done');
});

test.describe('phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('door: answers carried from veraldar.org skip their steps, no QR on a phone', async ({ page }) => {
    // the seed POST is answered here: the real one ran in the test above, and
    // a second set of answers would rewrite MAIN's standing preferences
    let posted: unknown = null;
    await page.route('**/api/onboard', (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      posted = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ json: { id: 'ses_e2e', title: '[MAIN]', slug: 'main', created: false } });
    });
    await page.goto('/#door=v1.fr.detail');
    const tree = page.getByTestId('tree-first');
    await expect(tree).toBeVisible();
    await tree.tap();
    // straight to the brain step, in French, with the site's answers
    await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'brain');
    await expect(page.getByTestId('door-say')).toContainText('voici bifrost. vos réponses ont suivi');
    await expect.poll(() => posted).toEqual({ step: 'main', prefs: { lang: 'fr', style: 'detail' } });
    await expect(page.getByTestId('door-brain')).toContainText('plus de détail');
    await expect(page.getByTestId('door-qr')).toHaveCount(0);
    await expect(page.getByTestId('door-enter')).toHaveText('continuer');
    await shot(page, 'p1-carried-fr');
  });
});
