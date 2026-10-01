import { afterAll, expect, test } from '@playwright/test';
import { unlink, writeFile } from 'fs/promises';
import path from 'path';

// the artifacts dir the pwa serves from (playwright cwd = pwa/)
const DIR = path.join(process.cwd(), '..', 'artifacts');

const made: string[] = [];
afterAll(async () => {
  for (const f of made) await unlink(path.join(DIR, f)).catch(() => {});
});

// the dir is LIVE — parallel sessions drop files at any moment, so the
// badge count is never pinned to an exact number; assertions watch our
// own file's effect on it (drops by one / hits zero) instead
async function badgeCount(page: import('@playwright/test').Page): Promise<number> {
  const label =
    (await page.getByRole('link', { name: /artifacts — \d+ unseen/ }).getAttribute('aria-label')) ||
    '';
  return Number(label.match(/(\d+)/)?.[1] || 0);
}

/** The first-visit mercy (mark everything seen) is a localStorage write at
 *  the END of the first load — reloading before it commits re-runs it with
 *  the new file included, swallowing the unread. Wait it out, THEN write. */
async function mercyDone(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => localStorage.getItem('oz-artifact-init') === '1', null, {
    timeout: 15_000,
  });
}

test('bell: unseen artifact counts, gallery opens it, tap marks seen', async ({ page }) => {
  // first visit seeds the mercy watermark with whatever is already on disk
  await page.goto('/');
  await mercyDone(page);
  // drop a fresh artifact AFTER the mercy run — the bell must catch it
  const name = `e2e-bell-${Date.now().toString(36)}.md`;
  made.push(name);
  await writeFile(path.join(DIR, name), 'bell spec payload');
  await page.reload();
  // the link SSRs as "0 unseen" before the client fetch lands — poll the
  // count instead of trusting first paint
  await expect
    .poll(() => badgeCount(page), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  const before = await badgeCount(page);
  await expect(page.getByTestId('artifact-badge')).toHaveText(String(before));
  // bell → the artifacts page, newest first with the unread row on top
  await page.getByRole('link', { name: /artifacts — \d+ unseen/ }).click();
  await expect(page).toHaveURL(/\/artifacts$/);
  // default view: html-only thumbnail cards — our md is NOT here, the html
  // designs are, with live iframe thumbnails
  await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0);
  const grid = page.getByTestId('artifact-grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('iframe').first()).toBeVisible();
  // "all" reveals the rest — our md row appears (chip may carry an unseen count)
  await page.getByRole('button', { name: /^all( \d+)?$/ }).click();
  const row = page.getByRole('button', { name: new RegExp(name) });
  await expect(row).toBeVisible();
  // tap → viewer renders the md, opening marks it seen
  await row.click();
  await expect(page.getByText('bell spec payload')).toBeVisible();
  await page.getByRole('button', { name: 'back to list' }).click();
  await expect(page.getByText(/0 unseen|unseen/).first()).toBeVisible();
  // back home: the count dropped by exactly our one file
  await page.goBack();
  await expect
    .poll(() => badgeCount(page), { timeout: 15_000 })
    .toBe(before - 1);
});

test('mark all read clears every unseen', async ({ page }) => {
  await page.goto('/');
  await mercyDone(page);
  const name = `e2e-bell2-${Date.now().toString(36)}.md`;
  made.push(name);
  await writeFile(path.join(DIR, name), 'second payload');
  await page.reload();
  await expect
    .poll(() => badgeCount(page), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await page
    .getByRole('link', { name: /artifacts — [1-9]\d* unseen/ })
    .click();
  await expect(page).toHaveURL(/\/artifacts$/);
  await page.getByRole('button', { name: 'mark all read' }).click();
  await expect(page.getByText(/0 unseen/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'mark all read' })).toBeHidden();
  await page.goBack();
  await expect.poll(() => badgeCount(page), { timeout: 15_000 }).toBe(0);
});

test('html thumbnail opens full-screen view page', async ({ page }) => {
  await page.goto('/artifacts');
  await mercyDone(page);
  const hn = `e2e-view-${Date.now().toString(36)}.html`;
  made.push(hn);
  await writeFile(path.join(DIR, hn), '<h1>view page payload</h1>');
  await page.reload();
  // anchored: the card also has a sibling "open … in new tab" corner button
  const card = page.getByRole('button', { name: new RegExp(`^${hn}$`) });
  await expect(card).toBeVisible();
  // tap → its own page, full-bleed sandboxed iframe; browser back returns
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/artifacts/view/${hn}$`));
  await expect(page.locator(`iframe[title="${hn}"]`)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/artifacts$/);
});

test('card corner opens the view page in a new tab', async ({ page }) => {
  await page.goto('/artifacts');
  await mercyDone(page);
  const hn = `e2e-newtab-${Date.now().toString(36)}.html`;
  made.push(hn);
  await writeFile(path.join(DIR, hn), '<p>new tab payload</p>');
  await page.reload();
  const corner = page.getByRole('button', { name: new RegExp(`open ${hn} in new tab`) });
  await expect(corner).toBeVisible();
  const [popup] = await Promise.all([page.waitForEvent('popup'), corner.click()]);
  await expect(popup).toHaveURL(new RegExp(`/artifacts/view/${hn}$`));
  await expect(popup.locator(`iframe[title="${hn}"]`)).toBeVisible();
  // the gallery page itself never navigated
  await expect(page).toHaveURL(/\/artifacts$/);
});

test('api: artifact list is newest-first, names stay sanitized', async ({ request }) => {
  const r = await request.get('/api/artifact');
  expect(r.ok()).toBeTruthy();
  const list = (await r.json()) as { name: string; mtime: number; size: number }[];
  expect(Array.isArray(list)).toBeTruthy();
  expect(list.length).toBeGreaterThan(0);
  for (let i = 1; i < list.length; i++)
    expect(list[i - 1].mtime).toBeGreaterThanOrEqual(list[i].mtime);
  for (const f of list) expect(f.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
});
