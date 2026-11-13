import { test, expect } from '@playwright/test';

/** root-coord, real coordinator (no mock): the phone talks to MAIN, MAIN routes the work to a
 *  session, the route tag links to it, MAIN comes back unprompted when it is done, and the home
 *  list shows the child under MAIN with its card. Needs E2E_OC_URL = a root-coord brain on a real
 *  upstream and PW_BASE_URL = this build served against it. Screens → $SHOTS (optional). */
const OC = process.env.E2E_OC_URL || 'http://127.0.0.1:4191';
const SHOTS = process.env.SHOTS;
test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });
test.setTimeout(9 * 60_000);

test('one door: ask MAIN, follow the route tag, MAIN comes back, the tree shows it', async ({ page, request }) => {
  const list = await (await request.get(`${OC}/session`)).json();
  let main = list.find((s: { title: string }) => s.title === '[MAIN]');
  if (!main) main = await (await request.post(`${OC}/session`, { data: { title: '[MAIN]' } })).json();

  await page.goto(`/session/main?id=${main.id}`);
  await page.getByPlaceholder('message…').fill(
    'build me a tiny python script hello.py in a folder named hello that prints hello world, with one pytest test'
  );
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('(you)').first()).toBeVisible();

  // MAIN answers fast; its route tag is a link named after the child it started
  const childOf = async () => {
    const rows = await (await request.get(`${OC}/tree`)).json();
    return rows.find((r: { parentID?: string }) => r.parentID === main.id);
  };
  await expect.poll(async () => !!(await childOf()), { timeout: 90_000 }).toBe(true);
  const child = await childOf();
  const link = page.getByRole('link', { name: child.title });
  await expect(link).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/root-coord-ui-main-routed.png` });

  // …and comes back by itself when the work is done (no message from us): counted on the brain
  const replies = async () =>
    (await (await request.get(`${OC}/session/${main.id}/message`)).json()).filter(
      (m: { info: { role: string; time: { completed?: number } } }) => m.info.role === 'assistant' && m.info.time.completed
    ).length;
  await expect.poll(replies, { timeout: 7 * 60_000, intervals: [5000] }).toBeGreaterThan(1);
  await expect(page.getByText('(agent').nth(1)).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/root-coord-ui-main-reported.png` });

  // the child opens from the route tag and shows its card line
  await link.tap();
  await page.waitForURL(new RegExp(`id=${child.id}`), { timeout: 15_000 });
  await expect(page.getByText(/· (done|working|running)/).first()).toBeVisible({ timeout: 20_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/root-coord-ui-child.png` });

  // home: the child sits in MAIN's tree with its status
  await page.goto('/');
  await expect(page.getByText(/hello/i).first()).toBeVisible({ timeout: 20_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/root-coord-ui-home.png` });
});
