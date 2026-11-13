import { OC } from './brain';
import { expect, test } from '@playwright/test';

/**
 * Context injection: a fresh phone session must know where it is, what bifrost
 * is, and which stack carried the question — before touching any file.
 * Guarded by the layered AGENTS.md (~/Work stub → ~/Work/bifrost full).
 */
test('fresh session answers with bifrost context', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session', exact: true }).click();
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

  // Context must come from the injected AGENTS.md chain, not exploration —
  // but the injection is a BRAIN property, not a client one: opencode (live
  // :8080) injects the layered AGENTS.md; yggdrasil (sandbox :4100) injects
  // no context file yet (10-23 probe: it answered the SAME question right
  // with 2 read-only tools, ls/find + grep — honest path, no crawl). The
  // served app names its brain's dialect so the referee asserts the right
  // law on the right stack.
  const sid = new URL(page.url()).searchParams.get('id');
  expect(sid).toBeTruthy();
  const raw = (await (
    await fetch(`${OC}/session/${sid}/message`)
  ).json()) as Array<{
    info: { role: string };
    parts: Array<{ type: string; tool?: string; state?: any }>;
  }>;
  const toolParts = raw.flatMap((m) => m.parts || []).filter((p) => p.type === 'tool');
  const dialect = (
    await (await request.get('/api/brain-dialect').catch(() => null))?.text()
  )?.trim();
  if (dialect === 'yggdrasil') {
    // yggdrasil's injected-context gap is FILED (~/Work/bifrost
    // docs/open-questions.md, OG-ctx). Current law: never a MUTATION — write/edit are forbidden.
    // bash may appear (10-23 probe: it runs read-only `ls; find` through it
    // — a general tool used read-only; a tool-name-level read-only law is
    // not enforceable while bash exists and is not what this guard owns).
    const mutating = toolParts.filter((t) => ['write', 'edit'].includes(String(t.tool)));
    expect(mutating, 'context question must never mutate anything').toEqual([]);
  } else {
    // opencode: the stub chain does the pointing — ≤1 tool call, the
    // pointed AGENTS.md read, never a repo crawl
    expect(toolParts.length, 'context question must not crawl the repo').toBeLessThanOrEqual(1);
    for (const t of toolParts) {
      expect(String(t.state?.input?.filePath || '')).toMatch(/bifrost\/AGENTS\.md$/);
    }
  }
});

test('cleanup: delete the context session', async ({ request }) => {
  const list = await request.get('/api/session');
  const s = (await list.json()).find((x: { title: string }) => x.title === 'e2e-context');
  test.skip(!s, 'nothing to clean');
  expect((await request.delete(`/api/session/${s.id}`)).ok()).toBeTruthy();
});
