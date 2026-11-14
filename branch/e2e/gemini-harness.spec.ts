import { type Page, devices, expect, test } from '@playwright/test';

/** Google's harness (11-13): an agent on Gemini CLI, made in the app's agent editor the way one is
 *  made on Claude Code or Codex — picked from the CLI's own model list — and a session on it.
 *  This box's Gemini CLI is not signed in: the session must say so plainly on the phone.
 *  PW_BASE_URL = :8447, E2E_OC_URL = its brain :4101. */
const OC = process.env.E2E_OC_URL || 'http://127.0.0.1:4101';
test.use({ ...devices['Pixel 7'] });

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('message…');
  await box.tap();
  await box.fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).tap();
}

test('agent editor offers Gemini CLI with its own models; a session on it says plainly it is not signed in', async ({
  page,
  request,
}) => {
  test.setTimeout(4 * 60_000);
  const name = `gem-e2e-${Date.now().toString(36)}`;
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
    await runsOn.getByRole('button', { name: 'Gemini CLI', exact: true }).tap();
    await expect(runsOn.getByRole('button', { name: 'Gemini CLI', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // the model picker lists what `gemini models` says, not a guess
    const offered = ((await (await request.get(`${OC}/agent/build`)).json()).models_by_harness
      .gemini || []) as string[];
    expect(offered.length, 'the brain read the CLI model list').toBeGreaterThan(1);
    expect(offered).toContain('gemini-2.5-pro');
    const model = page.locator('.oz-blk', { has: page.getByRole('heading', { name: 'model' }) });
    for (const m of offered) await expect(model.getByRole('button', { name: m, exact: true })).toBeVisible();
    await model.getByRole('button', { name: 'gemini-3.5-flash', exact: true }).tap();
    await page.getByRole('button', { name: 'create agent' }).tap();
    await expect(page.getByText('saved')).toBeVisible({ timeout: 20_000 });
    const made = await (await request.get(`${OC}/agent/${name}`)).json();
    expect(made.harness).toBe('gemini');
    expect(made.model).toBe('gemini-3.5-flash');

    // the agents list says where it runs
    await page.goto('/agents');
    await expect(
      page.getByTestId('agent-row').filter({ hasText: name }).getByText('Gemini CLI')
    ).toBeVisible();

    // a session on it: the turn runs the real CLI, which is not signed in on this box
    const s = await (await request.post(`${OC}/session`, { data: { title: `gemini e2e ${name}`, agent: name } })).json();
    sid = s.id;
    expect(s.model).toEqual({ id: 'gemini-3.5-flash', providerID: 'gemini' });
    await page.goto(`/session/gemini-e2e-${name}?id=${sid}`);
    await send(page, 'say hi');
    // the run's error box (not Next's empty route announcer, also role=alert)
    const box = page.locator('[role="alert"]', { hasText: 'reply failed' });
    await expect(box).toContainText('Gemini CLI is not signed in', { timeout: 60_000 });
    await expect(box).toContainText('GEMINI_API_KEY');
  } finally {
    if (sid) await request.delete(`/api/session/${sid}`).catch(() => {});
    await request.delete(`${OC}/agent/${name}`).catch(() => {});
  }
});
