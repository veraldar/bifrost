import { type APIRequestContext, expect, test } from '@playwright/test';

// Sub-sessions are created by opencode itself (agent task runs), never through
// the phone — so this spec seeds a real parent+child pair directly on the
// opencode server and asserts only on the PWA's rendering of the pair.
const OC = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
const TAG = `e2e-subs-${Date.now().toString(36)}`;
const created: string[] = [];

/** The proxy caches the enriched session list for 60s; only creates/deletes
 *  through it bust that cache. A throwaway round-trip forces a fresh list. */
async function bustListCache(request: APIRequestContext) {
  const r = await request.post('/api/session', { data: { name: `${TAG}-bust` } });
  const s = (await r.json()) as { id?: string };
  if (s.id) await request.delete(`/api/session/${s.id}`);
}

test.afterAll(async ({ request }) => {
  // runs even when a test above fails — a failed assertion must never
  // leak seeded sessions into the user's list (that happened once)
  for (const id of created) await request.delete(`/api/session/${id}`);
});

test('sub-sessions nest under their parent behind the subs pill', async ({ page, request }) => {
  const p = (await (
    await request.post(`${OC}/session`, { data: { title: `${TAG}-parent` } })
  ).json()) as { id?: string };
  const parentId = p.id || '';
  created.push(parentId);
  expect(parentId).toBeTruthy();
  const c = (await (
    await request.post(`${OC}/session`, { data: { title: `${TAG}-child`, parentID: parentId } })
  ).json()) as { id?: string };
  const childId = c.id || '';
  created.push(childId);
  expect(childId).toBeTruthy();

  await bustListCache(request);
  await page.goto('/');

  // parent row carries the pill (collapsed by default) — scoped to the
  // seeded row: other live sessions may have their own sub-sessions
  const row = page.locator('li', { hasText: `${TAG}-parent` });
  const pill = row.getByRole('button', { name: '1 sub-session', exact: true });
  await expect(pill).toBeVisible();

  // child must NOT sit at the top level while collapsed
  await expect(page.getByText(`${TAG}-child`)).toHaveCount(0);

  // tap the pill → child row unfolds under the parent
  await pill.click();
  const childRow = row.getByText(`${TAG}-child`);
  await expect(childRow).toBeVisible();

  // tapping the child row opens the child session, not the parent
  await childRow.click();
  await expect(page).toHaveURL(new RegExp(`id=${childId}`));
});

/** Swipe the child row left past the delete threshold (mouse drag). */
async function swipeChildLeft(page: import('@playwright/test').Page, title: string) {
  const childRow = page.locator('li', { hasText: title }).getByText(title);
  const box = (await childRow.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 90, y, { steps: 6 });
  await page.mouse.up();
}

test('sub-session swipes left to delete, with undo window', async ({ page, request }) => {
  const p = (await (
    await request.post(`${OC}/session`, { data: { title: `${TAG}-swipe-parent` } })
  ).json()) as { id?: string };
  const parentId = p.id || '';
  created.push(parentId);
  const c = (await (
    await request.post(`${OC}/session`, {
      data: { title: `${TAG}-swipe-child`, parentID: parentId },
    })
  ).json()) as { id?: string };
  const childId = c.id || '';
  created.push(childId);
  expect(parentId).toBeTruthy();
  expect(childId).toBeTruthy();

  await bustListCache(request);
  await page.goto('/');
  const row = page.locator('li', { hasText: `${TAG}-swipe-parent` });
  await row.getByRole('button', { name: '1 sub-session', exact: true }).click();

  // swipe → optimistic vanish + undo toast (0 msgs → short 3s window)
  await swipeChildLeft(page, `${TAG}-swipe-child`);
  await expect(page.getByText(`deleted “${TAG}-swipe-child”`)).toBeVisible();
  await expect(row.getByText(`${TAG}-swipe-child`)).toHaveCount(0);

  // undo restores the child under its parent
  await page.getByRole('button', { name: 'undo' }).click();
  await expect(row.getByText(`${TAG}-swipe-child`)).toBeVisible();

  // second swipe, no undo → window expires → the delete commits server-side
  await swipeChildLeft(page, `${TAG}-swipe-child`);
  await expect(page.getByText(`deleted “${TAG}-swipe-child”`)).toBeVisible();
  await page.waitForTimeout(3500);
  await bustListCache(request);
  await page.reload();
  const row2 = page.locator('li', { hasText: `${TAG}-swipe-parent` });
  await expect(row2).toBeVisible(); // parent untouched
  await expect(page.getByText(`${TAG}-swipe-child`)).toHaveCount(0); // child gone
});
