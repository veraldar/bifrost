import { expect, test, type Page } from '@playwright/test';

/** Swipe message-history browser: swipe → on a message steps into the past,
 *  ← back toward the present, past the newest closes ("back to no message").
 *  Screenshots land in artifacts/ for the phone. */
const NAME = `e2e-hist-${Date.now().toString(36)}`;
let sessionId = '';

/** Pointer-driven horizontal drag (mouse fires the same pointer events as
 *  touch here); stepped moves so the horizontal-vs-vertical decision fires. */
async function dragX(page: Page, selector: string, dx: number) {
  const b = await page.locator(selector).first().boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let s = 1; s <= 6; s++) await page.mouse.move(x + (dx * s) / 6, y);
  await page.mouse.up();
}

test('history: swipe → opens the past, ← returns, past newest closes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  sessionId = new URL(page.url()).searchParams.get('id') || '';
  expect(sessionId).toBeTruthy();

  // one turn → 2 messages: [0] the prompt (you), [1] the reply (assistant)
  await page.getByPlaceholder('message…').fill('Reply with exactly: pong');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('pong')).toBeVisible({ timeout: 90_000 });

  // swipe RIGHT on the newest message → the PAST one fills the screen
  await dragX(page, '[data-mi="1"]', 120);
  const dialog = page.getByRole('dialog', { name: 'message history' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 / 2');
  await expect(dialog).toContainText('(you)');
  await expect(dialog).toContainText('Reply with exactly: pong');
  await page.screenshot({ path: '../artifacts/e2e-history-open.png' });

  // swipe LEFT inside the viewer → back to the newest message
  await dragX(page, '[data-testid="hist-card"]', -140);
  await expect(dialog).toContainText('2 / 2');
  await expect(dialog).toContainText('pong');

  // swipe LEFT past the newest → closed, back to no message
  await dragX(page, '[data-testid="hist-card"]', -140);
  await expect(dialog).toHaveCount(0);

  // swipe LEFT on the newest in the transcript itself = already no message:
  // nothing opens
  await dragX(page, '[data-mi="1"]', -120);
  await expect(dialog).toHaveCount(0);

  // reopen and close with Escape too
  await dragX(page, '[data-mi="1"]', 120);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.screenshot({ path: '../artifacts/e2e-history-closed.png' });
});

test('cleanup: delete the history test session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
});
