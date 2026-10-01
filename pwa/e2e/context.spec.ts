import { expect, test } from '@playwright/test';

/**
 * Context injection: a fresh phone session must know where it is, what bifrost
 * is, and which stack carried the question — before touching any file.
 * Guarded by the layered AGENTS.md (~/Work stub → ~/Work/bifrost full).
 */
test('fresh session answers with bifrost context', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill('e2e-context');
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(/\/session\/e2e-context/);

  await page
    .getByPlaceholder('message…')
    .fill('One sentence: what is bifrost, in which directory does it live?');
  await page.getByRole('button', { name: 'send', exact: true }).click();

  // the assistant answer lands as a bubble (tool-only steps are hidden on
  // the phone now) — target the LAST one
  const reply = page.getByText(/\(agent/).last();
  await expect(reply).toBeVisible({ timeout: 90_000 });
  // only the ANSWER (not the prompt echo) contains the location → proves the
  // agent knew it without reading files first
  await expect(page.getByText(/Work\/bifrost/).last()).toBeVisible();

  // context must come from the stub chain, not exploration: ≤1 tool call,
  // and if one ran it's the pointed AGENTS.md read — never a repo crawl
  const sid = new URL(page.url()).searchParams.get('id');
  const raw = (await (
    await fetch(`http://127.0.0.1:4096/session/${sid}/message`)
  ).json()) as Array<{ info: { role: string }; parts: Array<{ type: string; state?: any }> }>;
  const toolParts = raw.flatMap((m) => m.parts || []).filter((p) => p.type === 'tool');
  expect(toolParts.length, 'context question must not crawl the repo').toBeLessThanOrEqual(1);
  for (const t of toolParts) {
    expect(String(t.state?.input?.filePath || '')).toMatch(/bifrost\/AGENTS\.md$/);
  }
});

test('cleanup: delete the context session', async ({ request }) => {
  const list = await request.get('/api/session');
  const s = (await list.json()).find((x: { title: string }) => x.title === 'e2e-context');
  test.skip(!s, 'nothing to clean');
  expect((await request.delete(`/api/session/${s.id}`)).ok()).toBeTruthy();
});
