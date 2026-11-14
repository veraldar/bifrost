import { type Page, devices, expect, test } from '@playwright/test';

/** Google's harness (11-14): Antigravity CLI (`agy`) — it replaced Gemini CLI. An agent on it is
 *  made in the app's agent editor the way one is made on Claude Code or Codex, picked from
 *  Google's current models merged with what `agy models` lists; a session on it runs the REAL agy.
 *  PW_BASE_URL = an app whose brain is E2E_OC_URL. agy signed in (this tree, 11-14): a real turn
 *  answers and the next one resumes the same agy conversation. E2E_AGY_SIGNED_OUT=1 (a brain whose
 *  agy has no credentials): the session says plainly how to sign in. */
const OC = process.env.E2E_OC_URL || 'http://127.0.0.1:4101';
const SIGNED_OUT = process.env.E2E_AGY_SIGNED_OUT === '1';
test.use({ ...devices['Pixel 7'] });

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('message…');
  await box.tap();
  await box.fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).tap();
}

/** an agent message matching `re` shows up on screen — polls, never a reload */
async function replyShows(page: Page, re: RegExp, timeout = 180_000) {
  await expect(
    page.locator('[data-mi]', { hasText: '(agent' }).filter({ hasText: re })
  ).toBeVisible({
    timeout,
  });
}

/** the run's error box (not Next's empty route announcer, also role=alert) */
const failure = (page: Page) => page.locator('[role="alert"]', { hasText: 'reply failed' });

test('the agent editor offers Antigravity with Google’s current models; a session on it runs the real agy', async ({
  page,
  request,
}) => {
  test.setTimeout(6 * 60_000);
  const name = `agy-e2e-${Date.now().toString(36)}`;
  let sid = '';
  try {
    // agents → + new agent → name → create: the editor opens on a new agent
    await page.goto('/agents');
    await page.getByRole('button', { name: 'new agent' }).tap();
    const field = page.getByLabel('new agent name');
    await field.tap();
    await field.fill(name);
    await page.getByRole('button', { name: 'create', exact: true }).tap();
    await page.waitForURL(new RegExp(`/agents/${name}`));
    const runsOn = page.locator('.oz-blk', { has: page.getByRole('heading', { name: 'runs on' }) });
    await expect(runsOn.getByRole('button', { name: /Gemini/ })).toHaveCount(0);
    await runsOn.getByRole('button', { name: 'Antigravity', exact: true }).tap();
    await expect(runsOn.getByRole('button', { name: 'Antigravity', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // the picker: agy's own pick first, then Google's current models (+ what `agy models` lists)
    const build = await (await request.get(`${OC}/agent/build`)).json();
    const offered = (build.models_by_harness.antigravity || []) as string[];
    const labels = (build.model_labels.antigravity || {}) as Record<string, string>;
    expect(build.models_by_harness.gemini, 'Gemini CLI is no longer a harness').toBeUndefined();
    expect(offered.slice(0, 4)).toEqual([
      'default',
      'gemini-4-carbon',
      'gemini-4-argon',
      'gemini-4-hydrogen',
    ]);
    expect(offered).toContain('gemini-3.8-flash');
    if (!SIGNED_OUT) expect(offered, 'merged with `agy models`').toContain('gemini-3.8-flash-low');
    const pick = SIGNED_OUT ? 'gemini-3.8-flash' : 'gemini-3.8-flash-low';
    const model = page.locator('.oz-blk', { has: page.getByRole('heading', { name: 'model' }) });
    if (offered.length > 8) {
      // a select: every model, each with its label
      const select = model.getByLabel('model', { exact: true });
      for (const m of offered) {
        await expect(select.locator(`option[value="${m}"]`)).toHaveText(`${m} — ${labels[m]}`);
      }
      expect(labels['gemini-4-carbon']).toMatch(/^Gemini 4 Carbon — strongest/);
      await select.selectOption(pick);
    } else {
      for (const m of offered)
        await expect(model.getByRole('button', { name: m, exact: true })).toBeVisible();
      await model.getByRole('button', { name: pick, exact: true }).tap();
    }
    await expect(model.locator('p.note')).toContainText(labels[pick]);
    await page.getByRole('button', { name: 'create agent' }).tap();
    await expect(page.getByText('saved')).toBeVisible({ timeout: 20_000 });
    const made = await (await request.get(`${OC}/agent/${name}`)).json();
    expect(made.harness).toBe('antigravity');
    expect(made.model).toBe(pick);

    // the agents list says where it runs
    await page.goto('/agents');
    await expect(
      page
        .getByTestId('agent-row')
        .filter({ hasText: name })
        .getByText('Antigravity', { exact: true })
    ).toBeVisible();

    // a session on it: the turn runs the real agy
    const s = await (
      await request.post(`${OC}/session`, { data: { title: `agy e2e ${name}`, agent: name } })
    ).json();
    sid = s.id;
    expect(s.model).toEqual({ id: pick, providerID: 'antigravity' });
    await page.goto(`/session/agy-e2e-${name}?id=${sid}`);
    await send(page, 'Remember the word walrus. Reply with exactly: ready');
    if (SIGNED_OUT) {
      await expect(failure(page)).toContainText('Antigravity is not signed in', {
        timeout: 90_000,
      });
      await expect(failure(page)).toContainText('run `agy` once in a terminal');
      await expect(failure(page)).toContainText('GEMINI_API_KEY');
      return;
    }
    await replyShows(page, /ready/i);
    const h1 = (await (await request.get(`${OC}/session/${sid}`)).json()).harness;
    expect(h1.kind).toBe('antigravity');
    expect(h1.id, 'the agy conversation id is kept').toMatch(/^[0-9a-f-]{36}$/);
    // turn 2 resumes that conversation (--conversation <id>): it remembers
    await send(page, 'What word did I ask you to remember? Reply with only that word.');
    await replyShows(page, /walrus/i);
    const h2 = (await (await request.get(`${OC}/session/${sid}`)).json()).harness;
    expect(h2.id, 'turn 2 resumed the same agy conversation').toBe(h1.id);
    await expect(failure(page)).toHaveCount(0);
  } finally {
    if (sid) await request.delete(`/api/session/${sid}`).catch(() => {});
    await request.delete(`${OC}/agent/${name}`).catch(() => {});
  }
});

test('a model this sign-in does not serve is said plainly on the phone', async ({
  page,
  request,
}) => {
  test.skip(SIGNED_OUT, 'signed out, every turn says how to sign in');
  test.setTimeout(3 * 60_000);
  const name = `agy-e2e-c-${Date.now().toString(36)}`;
  let sid = '';
  try {
    // Gemini 4 Carbon is in the picker (Google's current models); agy serves it on a key only
    const made = await (
      await request.put(`${OC}/agent/${name}`, {
        data: { harness: 'antigravity', model: 'gemini-4-carbon' },
      })
    ).json();
    expect(made.model).toBe('gemini-4-carbon');
    const labels = made.model_labels.antigravity as Record<string, string>;
    test.skip(
      !labels['gemini-4-carbon'].endsWith('needs GEMINI_API_KEY'),
      'this brain runs agy on an API key'
    );
    const s = await (
      await request.post(`${OC}/session`, { data: { title: `agy e2e ${name}`, agent: name } })
    ).json();
    sid = s.id;
    await page.goto(`/session/agy-e2e-${name}?id=${sid}`);
    await send(page, 'say hi');
    await expect(failure(page)).toContainText(
      'Antigravity does not offer gemini-4-carbon on this sign-in',
      {
        timeout: 60_000,
      }
    );
    await expect(failure(page)).toContainText('GEMINI_API_KEY');
  } finally {
    if (sid) await request.delete(`/api/session/${sid}`).catch(() => {});
    await request.delete(`${OC}/agent/${name}`).catch(() => {});
  }
});
