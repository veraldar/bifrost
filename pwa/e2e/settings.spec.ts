import { expect, test } from '@playwright/test';

const BASE_NAME = `e2e-set-${Date.now().toString(36)}`;
const RENAMED = `${BASE_NAME}-r`;
let sessionId = '';
let pickerSessionId = '';

test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/session', { data: { name: BASE_NAME } });
  sessionId = (await r.json()).id;
  expect(sessionId).toBeTruthy();
  // think level → derived model switch, agent via the v2 passthrough
  const p = await request.patch(`/api/session/${sessionId}`, {
    data: {
      model: { providerID: 'zai-coding-plan', modelID: 'glm-5.3-flash', variant: 'high' },
      agent: 'build',
    },
  });
  const pd = await p.json();
  expect(pd.model?.variant).toBe('high');
  expect(pd.model?.modelID).toBe('glm-5.3-flash');
  expect(pd.agent).toBe('build');
});

test.afterAll(async ({ request }) => {
  // id + slug both resolve — cover the pre- and post-rename identities
  await request.delete(`/api/session/${sessionId}`);
  await request.delete(`/api/session/${RENAMED}`);
  if (pickerSessionId) await request.delete(`/api/session/${pickerSessionId}`);
});

test('header slug opens settings — NAME/MODEL/THINK/AGENT tiles render', async ({ page }) => {
  await page.goto(`/session/${BASE_NAME}?id=${sessionId}`);
  await page.getByLabel('session settings').click();
  await expect(page).toHaveURL(new RegExp(`/session/${BASE_NAME}/settings`));
  for (const tile of ['name', 'model', 'think', 'agent']) {
    await expect(page.getByRole('heading', { name: tile, exact: true })).toBeVisible();
  }
  // model tile shows the BASE id; think shows the configured levels with the
  // current one called out; agent is build+plan — opencode's utility prompts
  // (title/summary/compaction) and subagents (general/explore) must NOT appear
  await expect(page.getByText('zai-coding-plan/glm-5.3-flash')).toBeVisible();
  for (const level of ['low', 'high', 'max']) {
    await expect(page.getByRole('button', { name: level, exact: true })).toBeVisible();
  }
  await expect(page.getByText('current — high')).toBeVisible();
  await expect(page.getByRole('button', { name: 'build', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'plan', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'general', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'title', exact: true })).toHaveCount(0);
});

test('think: tap switches the derived model server-side, tap reverts', async ({
  page,
  request,
}) => {
  await page.goto(`/session/${BASE_NAME}/settings`);
  // active level shown from the server → tap it → back to model default
  await page.getByRole('button', { name: 'high', exact: true }).click();
  await expect(page.getByText(/current — model default/)).toBeVisible();
  const afterRevert = await (await request.get(`/api/session/${sessionId}`)).json();
  expect(afterRevert.model?.variant).toBeNull();
  expect(afterRevert.model?.modelID).toBe('glm-5.3-flash');
  // set a different level → caption + server (derived modelID) agree
  await page.getByRole('button', { name: 'low', exact: true }).click();
  await expect(page.getByText('current — low')).toBeVisible();
  const afterSet = await (await request.get(`/api/session/${sessionId}`)).json();
  expect(afterSet.model?.variant).toBe('low');
  expect(afterSet.model?.modelID).toBe('glm-5.3-flash');
});

test('rename: PATCH + URL follows the new slug (typed fast, mid-fetch)', async ({ page }) => {
  await page.goto(`/session/${BASE_NAME}/settings`);
  await page.getByLabel('session name').fill(RENAMED);
  await page.getByLabel('session name').press('Enter');
  await expect(page).toHaveURL(new RegExp(`/session/${RENAMED}/settings`));
  // the proxy really renamed it at opencode (resolveId matches by slug)
  const list = await (await page.request.get('/api/session')).json();
  expect(list.some((s: { title: string }) => s.title === RENAMED)).toBeTruthy();
});

test('model picker: filter + apply persists; models without think levels say so', async ({
  page,
  request,
}) => {
  const cr = await request.post('/api/session', { data: { name: `${BASE_NAME}-picker` } });
  pickerSessionId = (await cr.json()).id;
  await page.goto(`/session/${BASE_NAME}-picker/settings`);
  await page.getByRole('button', { name: 'tap to choose ›' }).click();
  await page.getByLabel('filter models').fill('4.7');
  const pick = page.locator('ul button', { hasText: /^zai-coding-plan\/glm-4\.7$/ }).first();
  await expect(pick).toBeVisible();
  await pick.click();
  await expect(page.getByText(/zai-coding-plan\/glm-4\.7/).first()).toBeVisible();
  const s = await (await request.get(`/api/session/${pickerSessionId}`)).json();
  expect(s.model?.modelID).toBe('glm-4.7');
  // glm-4.7 exposes no think variants → honest empty state
  await expect(page.getByText('no think levels configured for this model')).toBeVisible();
});

test('delete: two taps from settings removes the session and returns to the list', async ({
  page,
  request,
}) => {
  const dr = await request.post('/api/session', { data: { name: `${BASE_NAME}-del` } });
  const delId = (await dr.json()).id;
  expect(delId).toBeTruthy();
  await page.goto(`/session/${BASE_NAME}-del/settings`);
  // first tap only arms — the session must still exist
  await page.getByRole('button', { name: 'delete session' }).click();
  await expect(page.getByRole('button', { name: 'tap again to delete' })).toBeVisible();
  expect((await (await request.get(`/api/session/${delId}`)).json()).id).toBe(delId);
  // second tap deletes → back on the session list, row gone
  await page.getByRole('button', { name: 'tap again to delete' }).click();
  await expect(page).toHaveURL(/\/(\?|$)/);
  const list = await (await request.get('/api/session')).json();
  expect(list.some((s: { id: string }) => s.id === delId)).toBeFalsy();
});
