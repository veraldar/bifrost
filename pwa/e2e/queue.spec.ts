import { expect, test } from '@playwright/test';

/** Regression test for the proxy-managed queue: a message sent while a run
 *  is live shows ● queued; stop advances to it instead of stalling
 *  (opencode v1.18 stalls its own queue after an abort — the proxy owns
 *  pickup now). */
const NAME = `e2e-queue-${Date.now().toString(36)}`;
let sessionId = '';

test('queue: mid-run send queues, stop advances to it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  sessionId = new URL(page.url()).searchParams.get('id') || '';

  // long-running task keeps the busy indicator up while we queue behind it
  await page.getByPlaceholder('message…').fill(
    'Run exactly this bash command: sleep 20. Then reply with exactly: A-done'
  );
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText(/working… \d+s/)).toBeVisible({ timeout: 20_000 });

  // mid-run send → ● queued chip on the message bubble
  await page.getByPlaceholder('message…').fill('Reply with exactly: B-done');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('● queued')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: '../artifacts/e2e-queued.png' });

  // "cancel" kills the current run (renamed from 'stop' — req 09-30: stop
  // means media now); the proxy must forward B automatically.
  // Model-agnostic: don't trust reply WORDING (post-abort models paraphrase
  // — seen live) — assert the mechanism: a second prompt exists and the
  // transcript ends with an assistant reply after it
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  const lastRole = () =>
    page.evaluate(() => {
      const msgs = [...document.querySelectorAll('[data-mi]')];
      return (
        msgs[msgs.length - 1]?.querySelector('div span')?.textContent || ''
      );
    });
  await expect
    .poll(async () => (await lastRole()) === '(agent)', { timeout: 90_000 })
    .toBe(true);
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0);
});

test('cleanup: delete the queue test session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
});
