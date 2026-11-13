import { expect, test, type Page } from '@playwright/test';

/** Settings tell the truth (ONBOARD-UX, user phone test 10-19): a refused
 *  write is said where the user tapped, never swallowed. Brain-agnostic —
 *  runs against yggdrasil (:8090) and opencode (:8080); never writes MAIN. */

const NAME = `e2e-truth-${Date.now().toString(36)}`;
// a settings block by its heading — alerts are looked up INSIDE a block
// (Next's route announcer is a page-wide role=alert too)
const blk = (page: Page, h: string) =>
  page.locator('.oz-blk', { has: page.getByRole('heading', { name: h, exact: true }) });
let sessionId = '';

test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/session', { data: { name: NAME } });
  sessionId = (await r.json()).id;
  expect(sessionId).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await request.delete(`/api/session/${sessionId}`);
});

test('MAIN: tapping the locked name says the rename is refused, and why', async ({
  page,
  request,
}) => {
  const main = await request.get('/api/session/main');
  test.skip(!main.ok(), 'no MAIN session on this brain');
  const before = (await main.json()).title;
  await page.goto('/session/main/settings');
  const field = page.getByLabel('session name');
  await expect(field).toHaveValue(before);
  await field.click();
  await expect(blk(page, 'name').getByRole('alert')).toContainText("MAIN can't be renamed");
  // the guard holds: nothing was written
  expect((await (await request.get('/api/session/main')).json()).title).toBe(before);
});

test('renaming a session to "main": 409 shown inline, field back to the real name', async ({
  page,
  request,
}) => {
  await page.goto(`/session/${NAME}/settings`);
  const field = page.getByLabel('session name');
  await expect(field).toHaveValue(NAME);
  await field.fill('main');
  await field.press('Enter');
  await expect(blk(page, 'name').getByRole('alert')).toContainText('MAIN is reserved');
  await expect(field).toHaveValue(NAME);
  // a refusal is not a crash — no 'fix this' session offered for it
  await expect(page.getByRole('button', { name: 'fix this' })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}/settings`));
  expect((await (await request.get(`/api/session/${sessionId}`)).json()).title).toBe(NAME);
  // typing again clears the refusal
  await field.fill(`${NAME}x`);
  await expect(blk(page, 'name').getByRole('alert')).toHaveCount(0);
});

test('a brain refusal keeps its status + reason through the proxy', async ({ request }) => {
  const r = await request.patch(`/api/session/${sessionId}`, {
    data: { agent: 'e2e-no-such-agent' },
  });
  test.skip(r.ok(), 'this brain accepts any agent name');
  expect(r.status()).toBeGreaterThanOrEqual(400);
  expect(r.status()).toBeLessThan(500);
  const d = await r.json();
  expect(d.error).toBeTruthy();
  expect(d.error).not.toMatch(/^Error: opencode \d+/);
});

test('agent write: 4xx lands inline under AGENT, 5xx in the error box', async ({ page }) => {
  await page.goto(`/session/${NAME}/settings`);
  const agentBlk = blk(page, 'agent');
  const chip = agentBlk.getByRole('button').first();
  await expect(chip).toBeVisible();

  await page.route(`**/api/session/${NAME}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 400, json: { error: 'unknown agent e2e' } })
      : route.fallback()
  );
  await chip.click();
  await expect(agentBlk.getByRole('alert')).toHaveText('unknown agent e2e');
  await expect(page.getByRole('button', { name: 'fix this' })).toHaveCount(0);

  await page.unroute(`**/api/session/${NAME}`);
  await page.route(`**/api/session/${NAME}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 502, json: { error: 'brain down (e2e)' } })
      : route.fallback()
  );
  await chip.click();
  await expect(page.getByText('brain down (e2e)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'fix this' })).toBeVisible();
  await expect(agentBlk.getByRole('alert')).toHaveCount(0);
});

test('no model set: MODEL shows the brain default, labeled default — never "tap to choose"', async ({
  page,
  request,
}) => {
  const s = await (await request.get(`/api/session/${sessionId}`)).json();
  test.skip(!!s.model, 'this brain gave the new session an explicit model');
  expect(s).toHaveProperty('defaultModel');
  const pick = blk(page, 'model').locator('button.oz-pick');
  await page.goto(`/session/${NAME}/settings`);
  if (!s.defaultModel) {
    await expect(pick).toContainText('brain default · not reported');
    return;
  }
  // the default is a real model of this brain, not an invented label
  const providers = await (await request.get('/api/models')).json();
  const key = `${s.defaultModel.providerID}/${s.defaultModel.modelID}`;
  expect(
    providers.some((p: { id: string; models: { id: string }[] }) =>
      p.models.some((m) => `${p.id}/${m.id}` === key)
    )
  ).toBeTruthy();
  await expect(pick).toHaveText(new RegExp(`${key.replace(/[.]/g, '\\.')} · default`));
  await expect(blk(page, 'model')).toContainText('set on the box');
  // the picker marks the same row as the default
  await pick.click();
  await expect(blk(page, 'model').locator('ul button', { hasText: `${key} · default` })).toBeVisible();
});

test('load failures are said per block and heal on retry — no blank, no invented agents', async ({
  page,
}) => {
  const down = { status: 502, json: { error: 'brain down (e2e)' } };
  await page.route('**/api/models', (r) => r.fulfill(down));
  await page.route('**/api/agents', (r) => r.fulfill(down));
  await page.route(`**/api/session/${NAME}`, (r) =>
    r.request().method() === 'GET' ? r.fulfill(down) : r.fallback()
  );
  await page.goto(`/session/${NAME}/settings`);
  const pick = blk(page, 'model').locator('button.oz-pick');
  await expect(pick).toContainText("couldn't load this session — retrying");
  await pick.click();
  await expect(blk(page, 'model')).toContainText(
    "couldn't load models — brain down (e2e) · retrying"
  );
  await expect(blk(page, 'agent')).toContainText(
    "couldn't load agents — brain down (e2e) · retrying"
  );
  // the old fallback chips (build/plan) are gone: no stand-in agent names
  await expect(blk(page, 'agent').getByRole('button')).toHaveCount(0);

  await page.unrouteAll();
  // the 2s retry lands the real data in every block
  await expect(pick).not.toContainText("couldn't load", { timeout: 10_000 });
  await expect(blk(page, 'model').locator('ul button').first()).toBeVisible({ timeout: 10_000 });
  await expect(blk(page, 'agent').getByRole('button').first()).toBeVisible({ timeout: 10_000 });
});

test('model picker: a filter miss says so, it is not an empty brain', async ({ page }) => {
  await page.goto(`/session/${NAME}/settings`);
  await blk(page, 'model').locator('button.oz-pick').click();
  await expect(blk(page, 'model').locator('ul button').first()).toBeVisible();
  await page.getByLabel('filter models').fill('zz-no-such-model');
  await expect(blk(page, 'model')).toContainText('no model matches “zz-no-such-model”');
});
