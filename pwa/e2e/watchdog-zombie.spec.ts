import { expect, test } from '@playwright/test';

/** Regression for the 2026-10-01 15:17 "no reply — the run seemed stuck,
 *  auto-stopped. Send again.": an AGENT/voice turn posts straight to
 *  opencode, so the proxy's live tracker never sees it (X-Run-Live stays 0)
 *  — and the stall watchdog scanned ONLY that tracker (liveSids). When the
 *  agent's run hung, nothing ever aborted it: opencode kept the session busy
 *  for 18h (09-30 21:08 → 10-01 15:14) and every later prompt silently
 *  serialized behind the zombie (message lands in the transcript, run never
 *  starts, zero stream events). The watchdog must also scan opencode's own
 *  busy map (GET /session/status — covers agent/voice/CLI runs) and abort a
 *  busy session whose event stream went quiet past the stall limit.
 *  OC_STALL_MS=20s comes from playwright.watchdog.config.ts; sleep 90 keeps
 *  the run busy well past the earliest possible verdict (quiet>20s + 30s
 *  scan cadence). */
const NAME = `e2e-zombie-${Date.now().toString(36)}`;
const OC = 'http://127.0.0.1:4096';

test('untracked (agent-style) stalled run must be aborted by the server watchdog', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  const sessionId = new URL(page.url()).searchParams.get('id') || '';
  expect(sessionId).toBeTruthy();

  // agent-style: straight to opencode, NOT awaited, NOT via the proxy —
  // exactly the voice-agent path
  void fetch(`${OC}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'Run exactly this bash command: sleep 90. Then reply: Z-done' }],
    }),
  });
  let liveHeader = '';
  await expect
    .poll(
      async () => {
        const r = await request.get(`/api/session/${sessionId}/messages?limit=10`);
        liveHeader = r.headers()['x-run-live'] || '';
        return r.headers()['x-run-state'] || '';
      },
      { timeout: 30_000, message: 'run never started (no |0|assistant state)' }
    )
    .toMatch(/\|0\|assistant$/);
  // THE point: the proxy tracker never saw this run (live=0) — the old
  // watchdog had no scan source for it at all
  expect(liveHeader).toBe('0');

  // (re)enter mid-run: arms busy from the streaming step + subscribes the
  // run-events SSE the push error arrives on
  await page.reload();
  await expect(page.getByText(/working… \d+s/)).toBeVisible({ timeout: 30_000 });

  // the server watchdog must abort the quiet run and push the error —
  // without the /session/status scan source this waits forever
  await expect(page.getByText(/no reply — run stalled/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/working… \d+s/)).toHaveCount(0);
  // the prompt stays in the transcript — the user can resend
  await expect(page.getByText(/sleep 90/)).toBeVisible();

  expect(await request.delete(`/api/session/${sessionId}`).then((r) => r.ok())).toBeTruthy();
});
