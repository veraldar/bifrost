import { type Page, expect, test } from '@playwright/test';

/** Tree-first first run, end to end on the SANDBOX (:8090, own config —
 *  playwright.tree-first.config.ts): fresh device → the tree alone → tap →
 *  onboarding session (hands-free armed, the brain's greeting lands) →
 *  completion → MAIN → home shows the list + the corner door, MAIN has no
 *  delete. The voice round-trip itself can't be asserted headless: the
 *  brain's closing marker is injected into the messages poll (the same
 *  shape the real brain writes), everything after it runs for real. */

const SHOTS = process.env.TF_SHOTS || '../artifacts';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/tree-first-${name}.png` });

test('tree-first: first open → onboarding → MAIN → corner door', async ({ page, request }) => {
  test.setTimeout(240_000);

  // 1 · a fresh device: the tree alone — no list, no chrome
  await page.goto('/');
  const tree = page.getByTestId('tree-first');
  await expect(tree).toBeVisible();
  await expect(page.getByText('tap the tree — set up your box by voice')).toBeVisible();
  await expect(page.locator('.oz-row')).toHaveCount(0);
  await expect(page.locator('header')).toHaveCount(0);
  await expect(page.getByTestId('tree-door')).toHaveCount(0);
  await shot(page, '1-first-open');

  // 2 · tap → onboarding session, hands-free armed, the greeting lands
  await tree.click();
  await expect(tree).toHaveClass(/wake/);
  await page.waitForURL(/\/session\/onboarding-[a-z0-9]+/, { timeout: 20_000 });
  const slug = new URL(page.url()).pathname.split('/').pop() as string;
  expect(await page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('free');
  // the existing hands-free path engaged (same testid the live suite reads)
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 20_000 });
  // the brain speaks first; its priming prompt is never on screen.
  // TF_BRAIN_DOWN=1: the brain's upstream is failing (e.g. 529 overloaded) —
  // the greeting can't land, so record the honest state and go on: nothing
  // after this point depends on the greeting
  if (process.env.TF_BRAIN_DOWN) {
    await expect(page.getByText('setup — your box speaks first')).toBeVisible();
  } else {
    await expect(page.getByText('(agent)').first()).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(1_500); // let the greeting finish streaming in
  }
  await expect(page.getByText('[bifrost onboarding')).toHaveCount(0);
  await expect(page.getByText('(you)')).toHaveCount(0);
  await shot(page, process.env.TF_BRAIN_DOWN ? '2-onboarding-brain-down' : '2-onboarding');

  // 3 · completion: the brain's closing marker (stable time — a real
  //     message never changes its timestamp between polls)
  const closingAt = Date.now();
  await page.route(`**/api/session/${slug}/messages*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const msgs = (await res.json()) as unknown[];
    msgs.push({
      role: 'assistant',
      text:
        "A woman's voice, short and fast, the local brain. Want me shorter, faster, or more detailed? Just ask.\n" +
        '[[bifrost:onboarded voice=woman style=short brain=local]]',
      images: [],
      time: closingAt,
      done: true,
    });
    await route.fulfill({ response: res, json: msgs });
  });
  // the marker is for the PWA only — the closing line shows without it
  await expect(page.getByText('Just ask.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('[[bifrost:')).toHaveCount(0);
  const done = page.waitForResponse(
    (r) => r.url().endsWith('/api/onboard') && r.request().method() === 'POST',
    { timeout: 90_000 }
  );
  const doneRes = await done;
  expect(doneRes.status()).toBe(200);
  expect(JSON.parse(doneRes.request().postData() || '{}')).toMatchObject({
    step: 'done',
    from: slug,
    prefs: { voice: 'woman', style: 'short', brain: 'local' },
  });
  await page.waitForURL(/\/session\/main(\?|$)/, { timeout: 20_000 });
  const ls = await page.evaluate(() => ({
    done: localStorage.getItem('tree-first-done'),
    mode: localStorage.getItem('oz-mode'),
    prev: localStorage.getItem('tree-first-prev-mode'),
    shrink: sessionStorage.getItem('tree-first-shrink'),
  }));
  expect(ls.done).toBeTruthy();
  expect(ls.mode).toBe('text'); // hands-free was scoped to the setup session
  expect(ls.prev).toBeNull();
  expect(ls.shrink).toBe('1');
  await page.unroute(`**/api/session/${slug}/messages*`);

  // 4 · home afterwards: the locked list + the tree shrunk to its corner
  await page.goto('/');
  const door = page.getByTestId('tree-door');
  await expect(door).toBeVisible();
  await expect(door).toHaveClass(/shrink/); // the one-time shrink plays
  await page.waitForTimeout(250);
  await shot(page, '3a-shrinking');
  await expect(door).not.toHaveClass(/shrink/, { timeout: 5_000 });
  await expect(page.getByTestId('tree-first')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'BIFROST' })).toBeVisible();
  const mainRow = page.locator('.oz-sw', { hasText: '[MAIN]' });
  await expect(mainRow).toHaveCount(1);
  await expect(door).toHaveAttribute('href', '/session/main');
  await shot(page, '3-corner-door');

  // 5 · MAIN offers no delete: no zone, a left drag doesn't move it, no toast
  await expect(mainRow.locator('.oz-zone')).toHaveCount(0);
  await expect(mainRow).toHaveAttribute('data-locked', '');
  await expect(page.locator('.oz-sw:not([data-locked]) .oz-zone').first()).toBeAttached();
  const box = (await mainRow.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(mainRow).toHaveCount(1);
  // the proxy refuses it too (the server half, from the previous run)
  const del = await request.delete('/api/session/main');
  expect(del.status()).toBe(403);
  // and its settings page has no delete block, the name is read-only
  await page.goto('/session/main/settings');
  await expect(page.getByRole('heading', { name: 'name' })).toBeVisible();
  await expect(page.getByRole('button', { name: /delete session/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'session name' })).toHaveAttribute('readonly', '');

  // 6 · the door opens MAIN; a second open skips the first run, no replay
  await page.goto('/');
  await expect(page.getByTestId('tree-door')).not.toHaveClass(/shrink/);
  await page.getByTestId('tree-door').click();
  await page.waitForURL(/\/session\/main$/);
  await expect(page.getByText('(you)').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, '4-main');
  await page.goto('/');
  await expect(page.getByTestId('tree-first')).toHaveCount(0);
  await expect(page.getByTestId('tree-door')).toBeVisible();

  // cleanup: the onboarding session was a test run (MAIN stays — reserved)
  await request.delete(`/api/session/${slug}`);
});
