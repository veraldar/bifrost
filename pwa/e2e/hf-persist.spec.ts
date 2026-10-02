import { expect, test } from '@playwright/test';

/** req 10-01 hands-free persistence across sessions:
 *  1. leave a session in hands-free, open another → still hands-free, mic
 *     re-arms (oz-mode was refresh-only — extended to cross-session nav)
 *  2. arriving hands-free on a session whose last reply was never heard
 *     auto-enters the listen/speak cycle (auto-listen), then listening
 *  3. in-session hands-free <-> keyboard switching stays clean (warm room)
 *  plus: history-back navigation between sessions keeps hands-free (and the
 *  slug effect rebinds the voice room on a same-instance arrival), and a
 *  deliberate hands-free exit must STICK (next session opens keyboard).
 *  Names are per-test: the worker can recycle between tests, re-evaluating
 *  module-level Date.now() consts (both full runs failed on that). Run
 *  against the worktree build: E2E_BASE_URL=http://127.0.0.1:8090 */
const tag = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function newSession(page: import('@playwright/test').Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(name);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${name}`));
}

async function enterHandsFree(page: import('@playwright/test').Page) {
  // a quick TAP on the composer mic toggles hands-free (a hold = PTT)
  await page.getByTestId('composer-mic').click();
  const free = page.getByTestId('free-phase');
  await expect(free).toBeVisible({ timeout: 30_000 });
  await expect(free).not.toContainText('connecting', { timeout: 30_000 });
  return free;
}

/** leave via home, open `name` from the list */
async function navHomeOpen(page: import('@playwright/test').Page, name: string) {
  await page.goto('/');
  await page.locator('ul button', { hasText: name }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${name}`));
}

test('hands-free survives home→session navigation + auto-listens the unheard reply', async ({
  page,
}) => {
  const A = `e2e-hfa-${tag()}`;
  const B = `e2e-hfb-${tag()}`;
  await newSession(page, A);
  await newSession(page, B);
  // B gets a completed reply the user never opened after
  await page.getByPlaceholder('message…').fill('Reply with exactly: pong');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('pong')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('working…')).toHaveCount(0);

  // hands-free ON in A
  await page.goto(`/session/${A}`);
  const freeA = await enterHandsFree(page);
  await expect(freeA).toContainText('tap the bars to send');

  // leave A → open B: still hands-free (req 1), and the unheard reply
  // auto-enters the listen/speak cycle (req 2)
  await navHomeOpen(page, B);
  const freeB = page.getByTestId('free-phase');
  await expect(freeB).toBeVisible({ timeout: 30_000 });
  await expect(freeB).not.toContainText('connecting', { timeout: 30_000 });
  await expect(freeB).toContainText('tap the bars to send', { timeout: 30_000 });
  // the auto-listen cycle ran: processing → listening (auto-play of the
  // unheard reply, mic muted during playback, mic back after). Diag is the
  // durable proof (flushes on a 10s timer); the line only fires on an
  // arrival — A's in-session tap-arm suppresses it there.
  await expect(freeB).toHaveAttribute('data-cycle', 'listening');
  await page.waitForTimeout(11_000);
  const diag = await page.request.get('/api/diag').then((r) => r.text());
  expect(
    diag.includes('on-open unheard reply'),
    `no auto-listen on arrival — voice diag tail:\n${diag
      .split('\n')
      .filter((l) => l.includes('[voice]'))
      .slice(-15)
      .join('\n')}`
  ).toBeTruthy();
});

test('history-back between sessions keeps hands-free (room follows the slug)', async ({
  page,
}) => {
  const A = `e2e-hfa-${tag()}`;
  const B = `e2e-hfb-${tag()}`;
  await newSession(page, A);
  await newSession(page, B);
  // hands-free ON in A, then phone-style BACK to B. Fresh mounts restore via
  // oz-mode ('hands-free restored on arrival'); a same-instance arrival goes
  // through the slug-effect rebind ('room rebind … → B' + 'carried across').
  // Either way the user lands in B hands-free with the mic armed.
  await page.goto(`/session/${A}`);
  await enterHandsFree(page);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/session/${B}`));

  const freeB = page.getByTestId('free-phase');
  await expect(freeB).toBeVisible({ timeout: 30_000 });
  await expect(freeB).not.toContainText('connecting', { timeout: 30_000 });
  await expect(freeB).toContainText('tap the bars to send', { timeout: 30_000 });
  await expect(freeB).toHaveAttribute('data-cycle', 'listening');

  await page.waitForTimeout(11_000);
  const diag = await page.request.get('/api/diag').then((r) => r.text());
  expect(
    diag.includes('hands-free restored on arrival') ||
      diag.includes('hands-free carried across') ||
      diag.includes(`room rebind ${A} → ${B}`),
    `hands-free did not follow into ${B} — voice diag tail:\n${diag
      .split('\n')
      .filter((l) => l.includes('[voice]'))
      .slice(-15)
      .join('\n')}`
  ).toBeTruthy();
});

test('deliberate hands-free exit sticks: next session opens keyboard', async ({ page }) => {
  const A = `e2e-hfa-${tag()}`;
  const B = `e2e-hfb-${tag()}`;
  await newSession(page, A);
  await newSession(page, B);
  await page.goto(`/session/${A}`);

  const free = await enterHandsFree(page);
  await expect(free).toContainText('tap the bars to send');
  await page.getByRole('button', { name: 'leave hands-free' }).click();
  await expect(free).toHaveCount(0);

  await navHomeOpen(page, B);
  await expect(page.getByTestId('free-phase')).toHaveCount(0);
  await expect(page.getByText('hold the mic to talk · tap it for hands-free')).toBeVisible();
});

test('in-session hands-free <-> keyboard switching stays clean (warm room)', async ({ page }) => {
  const A = `e2e-hfa-${tag()}`;
  await newSession(page, A);
  const free = await enterHandsFree(page);
  await expect(free).toContainText('tap the bars to send');

  // free → keyboard → free, fast: the warm-room path must re-arm without
  // a reconnect ('connecting…' would mean the room was torn down)
  await page.getByRole('button', { name: 'leave hands-free' }).click();
  await expect(free).toHaveCount(0);
  await page.getByTestId('composer-mic').click();
  await expect(free).toBeVisible({ timeout: 30_000 });
  await expect(free).not.toContainText('connecting', { timeout: 5_000 });
  await expect(free).toContainText('tap the bars to send');
  await page.getByRole('button', { name: 'leave hands-free' }).click();
  await expect(free).toHaveCount(0);
});
