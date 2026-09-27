import { type APIRequestContext, expect, test } from '@playwright/test';

// Sub-sessions are created by opencode itself (agent task runs), never through
// the phone — so this spec seeds a real parent+child pair directly on the
// opencode server and asserts only on the PWA's rendering of the pair.
const OC = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
const TAG = `e2e-subs-${Date.now().toString(36)}`;
let parentId = '';
let childId = '';

/** The proxy caches the enriched session list for 60s; only creates/deletes
 *  through it bust that cache. A throwaway round-trip forces a fresh list. */
async function bustListCache(request: APIRequestContext) {
  const r = await request.post('/api/session', { data: { name: `${TAG}-bust` } });
  const s = (await r.json()) as { id?: string };
  if (s.id) await request.delete(`/api/session/${s.id}`);
}

test('sub-sessions nest under their parent behind the subs pill', async ({ page, request }) => {
  const p = (await (
    await request.post(`${OC}/session`, { data: { title: `${TAG}-parent` } })
  ).json()) as { id?: string };
  parentId = p.id || '';
  expect(parentId).toBeTruthy();
  const c = (await (
    await request.post(`${OC}/session`, { data: { title: `${TAG}-child`, parentID: parentId } })
  ).json()) as { id?: string };
  childId = c.id || '';
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

test('cleanup: delete seeded parent + child', async ({ request }) => {
  if (childId) await request.delete(`/api/session/${childId}`);
  if (parentId) await request.delete(`/api/session/${parentId}`);
});
