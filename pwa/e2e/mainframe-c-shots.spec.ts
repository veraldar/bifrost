import { type Page, expect, test } from '@playwright/test';

/** MAINFRAME-C · the roots on a phone: 360 / 412 / 430 wide × the three
 *  worlds × idle · pressed · working · replied — a fixed list (mocked), so
 *  the shots compare. Writes artifacts/mainframe-c-shot-<theme>-<w>-<state>.png
 *  (the bottom of the screen: the last rows and the roots). */

const SHOTS = process.env.TF_SHOTS || '../artifacts';
const now = Date.now();
const LIST = [
  { id: 'ses_main', title: '[MAIN]', preview: 'you are in — say what to build next', updated: now - 60_000, lastRole: 'assistant', lastAt: now - 60_000, msgs: 4 },
  { id: 'ses_1', title: 'v07 gate waves', preview: 'WAVE CONTINUATION received — chaining. First: verify…', updated: now - 50_000, lastRole: 'assistant', lastAt: now - 50_000, msgs: 9 },
  { id: 'ses_2', title: 'film naming', preview: 'one naming ladder across veraldar.org, both doors…', updated: now - 40_000, lastRole: 'assistant', lastAt: now - 40_000, msgs: 9 },
  { id: 'ses_3', title: 'door v3', preview: 'any provider · back-safe history on both doors…', updated: now - 30_000, lastRole: 'assistant', lastAt: now - 30_000, msgs: 9 },
];

async function open(page: Page, theme: string, list: object[]) {
  await page.route(
    (u) => u.pathname === '/api/session',
    (r) => (r.request().method() === 'GET' ? r.fulfill({ json: list }) : r.continue())
  );
  await page.addInitScript((t) => {
    localStorage.setItem('theme', t);
    localStorage.setItem('bifrost-roots-held', '1');
    localStorage.removeItem('bifrost-voice-test');
    localStorage.setItem('oz-read-init', '1');
    localStorage.setItem('oz-read', JSON.stringify({ main: Date.now() - 30_000 }));
  }, theme);
  await page.goto('/');
  await expect(page.getByTestId('roots')).toBeVisible();
  await expect(page.locator('.oz-row').first()).toBeVisible();
}

for (const theme of ['aether', 'terminus', 'drift']) {
  for (const width of [360, 412, 430]) {
    test(`shots · ${theme} · ${width}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      const clip = { x: 0, y: 760 - 300, width, height: 300 };
      const shot = (s: string) =>
        page.screenshot({ path: `${SHOTS}/mainframe-c-shot-${theme}-${width}-${s}.png`, clip });

      await open(page, theme, LIST);
      await shot('idle');
      // pressed: amber in the same frame (slid off afterwards — nothing happens)
      const b = (await page.getByTestId('roots-hit').boundingBox())!;
      await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.55);
      await page.mouse.down();
      await page.waitForTimeout(120);
      await shot('heard');
      await page.mouse.move(b.x + 20, b.y - 300, { steps: 2 });
      await page.mouse.up();
      await page.unroute((u) => u.pathname === '/api/session');

      await open(page, theme, LIST.map((s) => (s.id === 'ses_main' ? { ...s, pending: true } : s)));
      await page.waitForTimeout(2_600); // the roots' first slot of the walk
      await shot('working');
      await page.unroute((u) => u.pathname === '/api/session');

      await open(
        page,
        theme,
        LIST.map((s) =>
          s.id === 'ses_main'
            ? { ...s, preview: 'green · 57/0 · the report is in artifacts', lastAt: Date.now(), updated: Date.now() }
            : s
        )
      );
      await page.waitForTimeout(1_200); // mid-climb
      await shot('replied');
      await ctx.close();
    });
  }
}
