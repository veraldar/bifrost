import { expect, test } from '@playwright/test';

/** App-state coverage + visual evidence: key states are screenshotted into
 *  artifacts/ so the phone can render them via /api/artifact/... Search
 *  (ring + counter + jump) has no other spec — covered here end-to-end. */
const NAME = `e2e-states-${Date.now().toString(36)}`;
let sessionId = '';

test('home: sessions list screenshot', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bifrost' })).toBeVisible();
  await expect(page.locator('ul button').first()).toBeVisible();
  await page.screenshot({ path: '../artifacts/e2e-home.png' });
});

test('session states: empty → working… → replied, screenshots each', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  sessionId = new URL(page.url()).searchParams.get('id') || '';
  expect(sessionId).toBeTruthy();
  await page.screenshot({ path: '../artifacts/e2e-session-empty.png' });

  await page.getByPlaceholder('message…').fill('Reply with exactly: pong');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  // working animation must show a live elapsed counter, not just text
  await expect(page.getByText(/working… \d+s/)).toBeVisible();
  await page.screenshot({ path: '../artifacts/e2e-working.png' });

  await expect(page.getByText('pong')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0);
  await page.screenshot({ path: '../artifacts/e2e-replied.png' });
});

test('search: hit ring, 1/2 counter, jump, Escape closes', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);

  await page.getByRole('button', { name: 'search transcript' }).click();
  const input = page.getByPlaceholder('search transcript…');
  await input.fill('pong');
  // prompt echo + assistant reply both contain "pong" → 2 hits
  await expect(page.getByText('1/2')).toBeVisible();
  // app semantics: ALL matches ring, the active one is scrolled to
  const ringed = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-mi]')]
        .filter((el) => /oz-active/.test(el.className))
        .map((el) => el.getAttribute('data-mi'))
    );
  expect(await ringed()).toEqual(['0', '1']);
  await page.screenshot({ path: '../artifacts/e2e-search-ring.png' });

  // jump to the next hit — counter advances, both rings stay
  await page.getByRole('button', { name: 'next match' }).click();
  await expect(page.getByText('2/2')).toBeVisible();
  expect(await ringed()).toEqual(['0', '1']);

  // Escape closes (handler lives on the input — it must hold focus)
  await input.click();
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await ringed()).toHaveLength(0);
});

test('hands-free: silence countdown + cancel ack, screenshots', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  await page.getByRole('button', { name: 'hands-free' }).click();
  const phase = page.getByTestId('free-phase');
  await expect(phase).toBeVisible({ timeout: 30_000 });
  // agent joined → ready: the live silence clock replaces "connecting…"
  await expect(phase).not.toContainText('connecting', { timeout: 30_000 });
  await page.screenshot({ path: '../artifacts/e2e-free-listening.png' });
  // cancel is reachable while armed; the ack must never lead to a send.
  // The e2e fake mic emits a loud synthetic tone, so "cancelled" may hand
  // back to listening once the 1.5s ack hold expires — the invariant is
  // that nothing is sent and no message lands while nobody spoke
  await page.getByTestId('free-cancel').click();
  await expect(phase).toContainText('cancelled');
  const userMsgs = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('[data-mi] > div span')].filter(
          (el) => el.textContent === '(you)'
        ).length
    );
  const before = await userMsgs();
  await page.waitForTimeout(1600);
  await expect(page.getByText('sending…')).toHaveCount(0);
  expect(await userMsgs()).toBe(before);
  await page.screenshot({ path: '../artifacts/e2e-free-cancelled.png' });
  await page.getByRole('button', { name: 'text mode' }).click();
});

test('cleanup: delete the states test session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
});
