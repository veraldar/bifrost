import { expect, test, type CDPSession, type Page } from '@playwright/test';

/** Swipe message-history browser: swipe → on a message steps into the past,
 *  ← back toward the present, past the newest closes ("back to no message").
 *  Screenshots land in artifacts/ for the phone. */
const NAME = `e2e-hist-${Date.now().toString(36)}`;
let sessionId = '';

/** Pointer-driven horizontal drag (mouse fires the same pointer events as
 *  touch here); stepped moves so the horizontal-vs-vertical decision fires. */
async function dragX(page: Page, selector: string, dx: number) {
  const b = (await page.locator(selector).first().boundingBox())!;
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

/** Real touch events through the browser's gesture pipeline (CDP), with the
 *  slight vertical drift a real finger has. */
async function swipeTouch(page: Page, cdp: CDPSession, sel: string, dx: number) {
  const b = (await page.locator(sel).first().boundingBox())!;
  const x0 = b.x + b.width / 2;
  const y0 = b.y + b.height / 2;
  const dispatch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    touchPoints: { x: number; y: number }[]
  ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  await dispatch('touchStart', [{ x: x0, y: y0 }]);
  for (let s = 1; s <= 6; s++) {
    await dispatch('touchMove', [{ x: x0 + (dx * s) / 6, y: y0 + s }]);
  }
  await dispatch('touchEnd', []);
}

/** The 2026-09-28 phone bug: pointer-only swipe handling died on touch
 *  because the browser claimed drift-y gestures for scrolling (pointercancel
 *  before commit). This drives REAL touch events through the browser's
 *  gesture pipeline (CDP, touch context) with vertical drift — the hook must
 *  preventDefault the scroll and still commit the swipe. */
test('history touch: swipe with drift works through the real touch pipeline', async ({
  browser,
}) => {
  test.skip(!sessionId, 'no session from the mouse test');
  const ctx = await browser.newContext({
    hasTouch: true,
    viewport: { width: 360, height: 780 },
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  await page.goto(`/session/${NAME}?id=${sessionId}`);
  await expect(page.locator('[data-mi="1"]')).toBeVisible();

  // swipe RIGHT on the newest message → the past one opens
  await swipeTouch(page, cdp, '[data-mi="1"]', 140);
  const dialog = page.getByRole('dialog', { name: 'message history' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 / 2');

  // swipe LEFT twice inside the viewer → newest → past it closes
  await swipeTouch(page, cdp, '[data-testid="hist-card"]', -140);
  await expect(dialog).toContainText('2 / 2');
  await swipeTouch(page, cdp, '[data-testid="hist-card"]', -140);
  await expect(dialog).toHaveCount(0);
  await ctx.close();
});

/** Composer history recall (req 09-28): ArrowUp on the PC steps back through
 *  the user's own sent messages, ArrowDown returns (past the newest = back
 *  to the live draft); on the phone the same walk lives on the textarea —
 *  slide right = past, slide left = back. */
test('input recall: ArrowUp/Down on the textarea, slide on touch', async ({ browser }) => {
  test.skip(!sessionId, 'no session from the mouse test');
  const ctx = await browser.newContext({
    hasTouch: true,
    viewport: { width: 360, height: 780 },
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  const ta = page.getByPlaceholder('message…');
  await expect(ta).toBeVisible();

  // ArrowUp recalls the (single) sent message; a second Up stays at oldest
  await ta.click();
  await page.keyboard.press('ArrowUp');
  await expect(ta).toHaveValue('Reply with exactly: pong');
  await expect(page.getByTestId('hist-chip')).toContainText('history 1/1');
  await page.keyboard.press('ArrowUp');
  await expect(ta).toHaveValue('Reply with exactly: pong');
  // ArrowDown past the newest → back to the live (empty) draft
  await page.keyboard.press('ArrowDown');
  await expect(ta).toHaveValue('');
  await expect(page.getByTestId('hist-chip')).toHaveCount(0);

  // a live draft is parked while browsing and restored on the way back
  await ta.fill('draft xyz');
  await page.keyboard.press('ArrowUp');
  await expect(ta).toHaveValue('Reply with exactly: pong');
  await page.keyboard.press('ArrowDown');
  await expect(ta).toHaveValue('draft xyz');

  // phone: slide RIGHT on the textarea → past message; slide LEFT → draft
  await swipeTouch(page, cdp, 'textarea[placeholder="message…"]', 90);
  await expect(ta).toHaveValue('Reply with exactly: pong');
  await swipeTouch(page, cdp, 'textarea[placeholder="message…"]', -90);
  await expect(ta).toHaveValue('draft xyz');
  await ctx.close();
});

test('cleanup: delete the history test session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
});
