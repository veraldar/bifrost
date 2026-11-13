import { expect, test } from '@playwright/test';

/** hf-strip round3 (owner 11-11): hands-free shows NO word and NO ◉ glyph under
 *  the mic; the state word survives as aria-label only. */
test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 780 } });
let id = '';
test.beforeAll(async ({ request }) => {
  id = (await (await request.post('/api/session', { data: { name: `e2e-hfr3-${Date.now().toString(36)}` } })).json()).id;
});
test.afterAll(async ({ request }) => {
  if (id) await request.delete(`/api/session/${id}`);
});

test('hands-free: no visible way word or glyph under the mic', async ({ page }) => {
  await page.goto(`/session/${id}`);
  const mic = page.getByTestId('composer-mic');
  await expect(mic).toBeVisible({ timeout: 20_000 });
  const b = (await mic.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(120);
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const phase = page.getByTestId('free-phase');
  await expect(phase).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(3_000);
  const r = await page.evaluate(() => {
    const vis: string[] = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement!;
      if (/hands-free|[○◉●]/i.test(n.textContent || '') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.sr-only,[aria-hidden="true"]')) vis.push(n.textContent!);
    }
    const phase = document.querySelector('[data-testid="free-phase"]')!.textContent;
    return { vis, phase, aria: [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).filter((a) => /hands-free|connecting|working/.test(a || '')) };
  });
  console.log(JSON.stringify(r));
  await page.screenshot({ path: '../../bifrost/artifacts/hf-strip-round3-shot.png' });
  expect(r.vis).toEqual([]);
  expect(r.phase).toBe('');
  expect(r.aria.length).toBeGreaterThan(0);
});
