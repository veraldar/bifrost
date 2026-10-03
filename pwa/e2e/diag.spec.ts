import { expect, test } from '@playwright/test';

// req 10-02 mode awareness: diag events carry the interaction mode, the send
// payload carries it server-side, and the agent's hands-free ctx tag never
// reaches a rendered surface.

const NAME = `e2e-diag-${Date.now().toString(36)}`;
const NAME2 = `e2e-diag-ctx-${Date.now().toString(36)}`;
let sessionId = '';

test('mode rides diag events and the send payload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  await page.getByPlaceholder('session name…').fill(NAME);
  await page.getByRole('button', { name: 'create & open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${NAME}`));
  sessionId = new URL(page.url()).searchParams.get('id') || '';
  expect(sessionId).toBeTruthy();

  // capture send payloads (pass through to the real proxy)
  const sendBodies: unknown[] = [];
  await page.route('**/api/session/*/messages', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') sendBodies.push(req.postDataJSON());
    await route.continue();
  });

  const dump = () => page.evaluate(() => (window as any).ozDiagDump?.() || '');

  // tap the mic FIRST (clean session: no unheard reply yet — the on-open
  // autoplay would flip the cycle to processing and unmount free-exit).
  // A fast click IS the tap gesture: released inside the 250ms arm window.
  await page.getByTestId('composer-mic').click();
  await expect
    .poll(() => dump(), { timeout: 30_000 })
    .toMatch(/\[voice·free\]/);

  // exit hands-free (free-exit renders while listening)
  await page.getByTestId('free-exit').click();
  await expect(page.getByTestId('composer-mic')).toBeVisible({ timeout: 20_000 });

  // hold ≥ the 250ms arm → PTT: the hold event is stamped mode 'ptt'
  const mic = page.getByTestId('composer-mic');
  const box = await mic.boundingBox();
  expect(box).toBeTruthy();
  // hold well past the 250ms arm AND the ~200ms mic re-acquire — a release
  // that lands before pttDown's enable resolved races pttUp's mute and the
  // hold event never fires
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_500);
  await page.mouse.up();
  await expect
    .poll(() => dump(), { timeout: 30_000 })
    .toMatch(/\[ptt·ptt\]/);

  // keyboard send LAST → payload mode 'text' (its reply lands unheard, but
  // hands-free is over by then — no cycle left to autoplay it)
  await page.getByPlaceholder('message…').fill('Reply with exactly: pong');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  expect
    .poll(() => sendBodies.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect((sendBodies[0] as { mode?: string }).mode).toBe('text');
});

test('agent ctx tag is stripped from the transcript the phone sees', async ({ request }) => {
  // through the REAL proxy (a mocked endpoint would bypass the server-side
  // strip): create a session, send a prompt carrying the tag the agent would
  // append, and read the transcript back
  const mk = await request.post('/api/session', { data: { name: NAME2 } });
  const created = (await mk.json()) as { id?: string };
  const sid = created.id || '';
  expect(sid).toBeTruthy();

  const tag =
    '\n\n[ctx: mode=hands-free; the user is talking, the reply will be read aloud — keep it short, conversational, spoken-style]';
  const send = await request.post(`/api/session/${sid}/messages`, {
    data: { text: `Reply with exactly: ctxstrip${tag}`, async: true, mode: 'text' },
  });
  expect(send.ok()).toBeTruthy();

  // run completes → transcript shows the prompt WITHOUT the protocol tag
  await expect
    .poll(
      async () => {
        const r = await request.get(`/api/session/${sid}/messages?limit=60`);
        if (!r.ok()) return 'pending';
        const msgs = (await r.json()) as { role: string; text: string }[];
        const mine = msgs.find((m) => m.role === 'user' && m.text.includes('ctxstrip'));
        return mine ? JSON.stringify(msgs) : 'pending';
      },
      { timeout: 90_000, intervals: [2_500] }
    )
    .toContain('ctxstrip');
  const r = await request.get(`/api/session/${sid}/messages?limit=60`);
  const msgs = (await r.json()) as { role: string; text: string }[];
  for (const m of msgs) expect(m.text).not.toContain('[ctx:');
});
