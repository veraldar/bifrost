import { expect, test } from '@playwright/test';

/** Session-settings referee — CATALOG-DERIVED (10-23): every model/level/
 *  agent name below is read from the catalog the SERVED app exposes
 *  (/api/models, /api/agents via the settings API), never hardcoded. The old
 *  assertions named the live stack's provider (`zai-coding-plan`) + its
 *  derived think models — truth on :8080, fiction under the sandbox brain
 *  (provider `yggdrasil`, no variants) → RED-by-env, not by product. One
 *  spec, green against both stacks. */

const BASE_NAME = `e2e-set-${Date.now().toString(36)}`;
const RENAMED = `${BASE_NAME}-r`;
let sessionId = '';
let pickerSessionId = '';

type Catalog = {
  providerID: string;
  modelID: string;
  variants: string[];
  other?: { providerID: string; modelID: string; variants: string[] };
  agents: string[];
};

let cat: Catalog;

test.beforeAll(async ({ request }) => {
  const list = (await (await request.get('/api/models')).json()) as Array<{
    id: string;
    models: { id: string; variants: string[] }[];
  }>;
  const providers = list.filter((p) => p.models?.length);
  expect(providers.length, 'the served app must expose a model catalog').toBeGreaterThan(0);
  const prov =
    providers.find((p) => p.models.some((m) => m.id === 'glm-5.3-flash')) || providers[0];
  const model = prov.models.find((m) => m.id === 'glm-5.3-flash') || prov.models[0];
  const other = prov.models.find((m) => m.id !== model.id);
  const agents = ((await (await request.get('/api/agents').catch(() => null))?.json()) ??
    []) as Array<{ name?: string }>;
  cat = {
    providerID: prov.id,
    modelID: model.id,
    variants: model.variants || [],
    other: other ? { providerID: prov.id, modelID: other.id, variants: other.variants || [] } : undefined,
    agents: agents.map((a) => a.name || '').filter(Boolean),
  };

  const r = await request.post('/api/session', { data: { name: BASE_NAME } });
  sessionId = (await r.json()).id;
  expect(sessionId).toBeTruthy();
  // set the base model (+ the first catalogued think level, if any) and the
  // first primary agent via the v2 passthroughs
  const p = await request.patch(`/api/session/${sessionId}`, {
    data: {
      model: {
        providerID: cat.providerID,
        modelID: cat.modelID,
        ...(cat.variants.length ? { variant: cat.variants[0] } : {}),
      },
      ...(cat.agents.length ? { agent: cat.agents[0] } : {}),
    },
  });
  const pd = await p.json();
  expect(pd.error, pd.error || 'settings PATCH refused').toBeUndefined();
  expect(pd.model?.variant ?? null).toBe(cat.variants.length ? cat.variants[0] : null);
  expect(pd.model?.modelID).toBe(cat.modelID);
  if (cat.agents.length) expect(pd.agent).toBe(cat.agents[0]);
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
  // model tile shows the catalogued id (provider/model); think shows the
  // configured levels — or the honest empty state when the model has none
  await expect(page.getByText(`${cat.providerID}/${cat.modelID}`)).toBeVisible();
  if (cat.variants.length) {
    for (const level of cat.variants) {
      await expect(page.getByRole('button', { name: level, exact: true })).toBeVisible();
    }
    await expect(page.getByText(`current — ${cat.variants[0]}`)).toBeVisible();
  } else {
    await expect(page.getByText('no think levels configured for this model')).toBeVisible();
  }
  // agent tile lists the CATALOG's primary agents — utility prompts and
  // subagents must NOT appear
  for (const a of cat.agents) {
    await expect(page.getByRole('button', { name: a, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'title', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'general', exact: true })).toHaveCount(0);
});

test('think: tap switches the derived model server-side, tap reverts', async ({
  page,
  request,
}) => {
  test.skip(cat.variants.length < 2, 'catalog exposes fewer than two think levels');
  const [active, next] = cat.variants;
  await page.goto(`/session/${BASE_NAME}/settings`);
  // active level shown from the server → tap it → back to model default
  await page.getByRole('button', { name: active, exact: true }).click();
  await expect(page.getByText(/current — model default/)).toBeVisible();
  const afterRevert = await (await request.get(`/api/session/${sessionId}`)).json();
  expect(afterRevert.model?.variant).toBeNull();
  expect(afterRevert.model?.modelID).toBe(cat.modelID);
  // set a different level → caption + server (derived modelID) agree
  await page.getByRole('button', { name: next, exact: true }).click();
  await expect(page.getByText(`current — ${next}`)).toBeVisible();
  const afterSet = await (await request.get(`/api/session/${sessionId}`)).json();
  expect(afterSet.model?.variant).toBe(next);
  expect(afterSet.model?.modelID).toBe(cat.modelID);
});

test('rename: PATCH + URL follows the new slug (typed fast, mid-fetch)', async ({ page }) => {
  await page.goto(`/session/${BASE_NAME}/settings`);
  await page.getByLabel('session name').fill(RENAMED);
  await page.getByLabel('session name').press('Enter');
  await expect(page).toHaveURL(new RegExp(`/session/${RENAMED}/settings`));
  // the proxy really renamed it at the brain (resolveId matches by slug)
  const list = await (await page.request.get('/api/session')).json();
  expect(list.some((s: { title: string }) => s.title === RENAMED)).toBeTruthy();
});

test('model picker: filter + apply persists; models without think levels say so', async ({
  page,
  request,
}) => {
  test.skip(!cat.other, 'catalog has no second model to switch to');
  const target = cat.other!;
  const cr = await request.post('/api/session', { data: { name: `${BASE_NAME}-picker` } });
  pickerSessionId = (await cr.json()).id;
  await page.goto(`/session/${BASE_NAME}-picker/settings`);
  // a model-less session's tile names the brain default (settings-truth),
  // not 'tap to choose' — open the picker by the tile itself
  await page.locator('button.oz-pick').click();
  await page.getByLabel('filter models').fill(target.modelID.slice(0, 8));
  const pick = page
    .locator('ul button', { hasText: new RegExp(`^${target.providerID}/${target.modelID}$`) })
    .first();
  await expect(pick).toBeVisible();
  await pick.click();
  await expect(page.getByText(`${target.providerID}/${target.modelID}`).first()).toBeVisible();
  const s = await (await request.get(`/api/session/${pickerSessionId}`)).json();
  expect(s.model?.modelID).toBe(target.modelID);
  // honest empty state — only when this model truly has no derived levels
  if (!target.variants.length) {
    await expect(page.getByText('no think levels configured for this model')).toBeVisible();
  }
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
