import { expect, test } from '@playwright/test';

/** PROVIDER-WAVE (10-28): the brain's provider answers 429 code 1310 (z.ai's
 *  weekly/monthly limit) — the session page must SAY so: an error turn in the
 *  transcript and the banner "provider limit exhausted, resets <time>", the
 *  working state ended, and a second turn answered with its own error turn
 *  (stacked turns never vanish). Runs against a scratch stack only
 *  (e2e/provider-banner.sh: mock → scratch root → scratch `next start`):
 *  ROOT=new = the provider-wave root (structured error + /provider/health),
 *  ROOT=old = the frozen v0.7.0 root binary (only `UnknownError` + an empty
 *  text part — the PWA recovers kind + reset from the provider's body). */
const ROOT = process.env.ROOT || 'new';
test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
const NAME = `e2e-provider-${ROOT}-${Date.now().toString(36)}`;
let sessionId = '';

test(`provider banner (${ROOT} root): 1310 → error turn + "provider limit exhausted, resets …"`, async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session', exact: true }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  sessionId = new URL(page.url()).searchParams.get('id') || '';

  await page.getByPlaceholder('message…').fill('where are we at?');
  await page.getByRole('button', { name: 'send', exact: true }).click();

  const turn = page.getByTestId('error-turn');
  await expect(turn).toHaveCount(1, { timeout: 30_000 });
  await expect(turn).toHaveAttribute('data-kind', 'quota');
  await expect(turn).toContainText(/provider limit exhausted, resets \d{1,2}:\d{2}/);
  await expect(turn).toContainText('Weekly/Monthly Limit Exhausted');

  const banner = page.getByTestId('provider-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-mode', 'out');
  await expect(banner).toContainText(/provider limit exhausted, resets \d{1,2}:\d{2}/);
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0, { timeout: 15_000 });
  // the provider stop is not ALSO a generic "no reply" box
  await expect(page.getByText(/no reply — /)).toHaveCount(0);
  // the scratch stack has no LiveKit: its voice-token box is not this test's subject
  const voiceBox = page.getByText(/voice connect failed/);
  if (await voiceBox.count())
    await page
      .getByText('dismiss', { exact: true })
      .click()
      .catch(() => {});
  await page.screenshot({ path: `../artifacts/provider-banner-${ROOT}.png` });

  // a second turn: its own error turn — nothing vanishes
  await page.getByPlaceholder('message…').fill('are you there?');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(turn).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0, { timeout: 15_000 });

  // refresh-proof: the banner comes back from the transcript (+ the brain's health)
  await page.reload();
  await expect(page.getByTestId('provider-banner')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('error-turn')).toHaveCount(2);
});

test('provider banner: the health route says what the brain says', async ({ request }) => {
  const h = await (await request.get('/api/provider-health')).json();
  if (ROOT === 'old') {
    expect(h.known).toBe(false); // the frozen root has no /provider/health — not an error
  } else {
    expect(h).toMatchObject({ known: true, status: 'exhausted', out: true });
    expect(h.alert.kind).toBe('quota');
    expect(h.alert.resetsAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(h)).not.toContain('mock-1310'); // no key material
  }
});

test('cleanup: delete the provider test session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
});
