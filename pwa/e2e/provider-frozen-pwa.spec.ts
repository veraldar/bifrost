import { expect, test } from '@playwright/test';

/** PROVIDER-WAVE (10-28): the deploy-order proof. The provider-wave ROOT alone,
 *  behind the FROZEN live PWA (v0.7.0-rc2, build 2-tWDJZQP2Pr6PIGTVDsF — no
 *  banner code at all): a 1310 stop is no longer an empty reply, the error
 *  turn's synthetic text renders as an ordinary agent message. Run via
 *  `e2e/provider-banner.sh frozen-pwa` (a reflink copy of the release's pwa/
 *  served on a scratch port; the release itself is never written). */
const NAME = `e2e-provider-frozenpwa-${Date.now().toString(36)}`;
let sessionId = '';
test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

test('frozen live PWA + new root: the 1310 stop is visible text, not silence', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  sessionId = new URL(page.url()).searchParams.get('id') || '';
  await page.getByPlaceholder('message…').fill('where are we at?');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText(/provider limit exhausted, resets/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/No fallback provider is set/)).toBeVisible();
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0, { timeout: 15_000 });
  const voiceBox = page.getByText(/voice connect failed/);
  if (await voiceBox.count())
    await page
      .getByText('dismiss', { exact: true })
      .click()
      .catch(() => {});
  await page.screenshot({
    path: `${process.env.SHOT_DIR || '../artifacts'}/provider-frozen-pwa.png`,
  });
});

test('cleanup: delete the frozen-pwa test session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
});
