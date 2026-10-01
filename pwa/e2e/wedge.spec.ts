import { expect, test } from '@playwright/test';

/** Regression for the wedge guard killing a live session (req: "no reply —
 *  the run seemed stuck, auto-stopped"): a follow-up prompt lands on opencode
 *  while the previous run is still executing (voice turns stack — the agent
 *  posts straight to opencode, so X-Run-Live stays 0). Last-raw is then the
 *  stacked prompt (|0|user), which read as "runner never picked it up"; the
 *  client's 30s wedge guard aborted and both answers were lost. The proxy
 *  must report the in-flight step BELOW the stack (|0|assistant) so busy
 *  holds, nothing aborts, and both replies arrive. */
const NAME = `e2e-wedge-${Date.now().toString(36)}`;
const OC = 'http://127.0.0.1:4096';
let sessionId = '';
let corpseId = '';

test('stacked prompt behind a live run must not wedge-abort', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  sessionId = new URL(page.url()).searchParams.get('id') || '';
  expect(sessionId).toBeTruthy();

  // voice-style turns: straight to opencode, bypassing the proxy queue
  const post = (text: string) =>
    fetch(`${OC}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });
  // turn 1 runs longer than the 30s wedge threshold
  void post('Run exactly this bash command: sleep 45. Then reply with exactly: A-done');
  // turn 1 picked up once its (un-completed) assistant shell exists
  await expect
    .poll(
      async () => {
        const r = await request.get(`/api/session/${sessionId}/messages?limit=10`);
        return r.headers()['x-run-state'] || '';
      },
      { timeout: 30_000, message: 'turn 1 never started (no |0|assistant state)' }
    )
    .toMatch(/\|0\|assistant$/);

  // watch the session while turn 2 stacks on top of the live run
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  await expect(page.getByText(/working… \d+s/)).toBeVisible({ timeout: 30_000 });
  void post('Reply with exactly: B-done');

  // busy must hold through BOTH turns — no "run seemed stuck" auto-abort —
  // and the indicator must clear only after the stacked turn is answered
  await expect(page.getByText('A-done')).toBeVisible({ timeout: 110_000 });
  await expect(page.getByText('B-done')).toHaveCount(2, { timeout: 110_000 });
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0);
  await expect(page.getByText('no reply — the run seemed stuck')).toHaveCount(0);
});

test('dead run masked by an un-completed step must event-quiet wedge', async ({
  page,
  request,
}) => {
  // 2026-09-30 "no reply — the run seemed stuck" took 15 minutes to surface:
  // a run died right after creating its assistant placeholder, and the stuck
  // |0|assistant state read as "thinking model" — the |0|user wedge guard
  // above can't see that shape. Liveness evidence is the opencode event
  // stream (X-Run-Last-Event): busy + no live prompt + no stream events for
  // the stall window = corpse. ?stall=15 shrinks the 5-minute production
  // window for the test; sleep 25 keeps the step un-completed well past it.
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(`${NAME}-corpse`);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}-corpse`));
  corpseId = new URL(page.url()).searchParams.get('id') || '';
  expect(corpseId).toBeTruthy();

  // agent-style: straight to opencode, NOT awaited — the POST resolves only
  // when the whole run finishes, and the poll must watch the |0|assistant
  // window while sleep holds it (proxy live flag stays 0: exactly the shape
  // the 09-30 incident presented)
  void fetch(`${OC}/session/${corpseId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'Run exactly this bash command: sleep 25. Then reply: C-done' }],
    }),
  });
  await expect
    .poll(
      async () => {
        const r = await request.get(`/api/session/${corpseId}/messages?limit=10`);
        return r.headers()['x-run-state'] || '';
      },
      { timeout: 30_000, message: 'step never started (no |0|assistant state)' }
    )
    .toMatch(/\|0\|assistant$/);

  // entering mid-run arms busy from the streaming step — the sleep emits no
  // stream events, so quiet grows from ~arm time while |0|assistant masks it
  await page.goto(`/session/${NAME}-corpse?id=${corpseId}&stall=15`);
  await expect(page.getByText(/working… \d+s/)).toBeVisible({ timeout: 30_000 });

  // the corpse escape must abort + surface the error while sleep still holds
  await expect(page.getByText('no reply — the run seemed stuck')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0);
  // the prompt stays in the transcript — the user can resend
  await expect(page.getByText(/sleep 25/)).toBeVisible();
});

test('cleanup: delete the wedge test session', async ({ request }) => {
  test.skip(!sessionId && !corpseId, 'nothing to clean');
  if (sessionId) expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
  if (corpseId) expect((await request.delete(`/api/session/${corpseId}`)).ok()).toBeTruthy();
});
