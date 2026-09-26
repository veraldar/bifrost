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

test('cleanup: delete the wedge test session', async ({ request }) => {
  test.skip(!sessionId, 'nothing to clean');
  expect((await request.delete(`/api/session/${sessionId}`)).ok()).toBeTruthy();
});
