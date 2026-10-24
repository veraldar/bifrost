import { readFile } from 'fs/promises';
import path from 'path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { runState } from '../lib/run-state';

/** Herdr folds (10-24, docs/research/herdr-takeaways.md §1.1 + §1.2 + §1.4):
 *  1. the working/blocked/idle TRIAD, harness-owned — the layering truth
 *     table (unit) and the wire (list `state`/`stateSource`: the brain's own
 *     declaration on yggdrasil). blocked/step-cap and blocked/interrupted
 *     are driven by the sim stack (e2e/herdr-sim.spec.ts — a mock upstream
 *     can be told to fail; the real one cannot);
 *  2. IDENTITY-PINNED waits — a page pins the session id it opened, never
 *     the slug: a second session wearing the same name, or the replacement
 *     of a deleted one, never receives its turns; a queued turn dies with
 *     its session;
 *  3. the voice-test room switch DEFAULTS OFF (user product; the fleet turns
 *     it on per device — ux-batch-voicetest.spec.ts). */

const TAG = `e2e-herdr-${Date.now().toString(36)}`;
const made: string[] = [];

async function mk(request: APIRequestContext, name: string): Promise<string> {
  const r = await request.post('/api/session', { data: { name } });
  const id = (await r.json()).id as string;
  expect(id, `create ${name}`).toBeTruthy();
  made.push(id);
  return id;
}

/** a returning device in keyboard mode (no door, no first-turn card) */
async function returning(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('bifrost-door', 'v2');
    localStorage.setItem('bifrost-onboard', JSON.stringify({ lang: 'en', style: 'short' }));
    localStorage.setItem('oz-mode', 'text');
    localStorage.setItem('bifrost-first-turn', '1');
  });
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder('message…').fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).click();
}

/** user turns the BRAIN holds for a session id (pinned read, never by slug) */
async function userTexts(request: APIRequestContext, sid: string): Promise<string[]> {
  const r = await request.get(`/api/session/${sid}/messages?limit=100`, {
    headers: { 'X-Session-Pin': sid },
  });
  if (!r.ok()) return [];
  return ((await r.json()) as { role: string; text: string }[])
    .filter((m) => m.role === 'user')
    .map((m) => m.text);
}

test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/session/${id}`).catch(() => {});
});

test('triad layering: a declaration always beats the detector', () => {
  const NOW = Date.now();
  const fresh = NOW - 1_000;
  const quiet = NOW - 11 * 60_000;
  const stall = 10 * 60_000;
  // the brain declares — it owns the run loop
  expect(runState({ type: 'working' }, false, false, quiet, stall)).toEqual({
    state: 'working',
    source: 'brain',
  });
  expect(runState({ type: 'blocked', reason: 'step-cap' }, false, true, quiet, stall)).toEqual({
    state: 'blocked',
    reason: 'step-cap',
    source: 'brain',
  });
  // a declared idle is never overridden by the corpse detector
  expect(runState({ type: 'idle' }, false, true, quiet, stall)).toEqual({
    state: 'idle',
    source: 'brain',
  });
  // the proxy's in-flight record: a forward the brain has not started yet
  expect(runState({ type: 'idle' }, true, false, fresh, stall).state).toBe('working');
  expect(runState({ type: 'blocked', reason: 'error' }, true, false, fresh, stall).state).toBe(
    'working'
  );
  // a brain that declares nothing (opencode): the detector is the fallback
  expect(runState(undefined, false, true, quiet, stall)).toEqual({
    state: 'blocked',
    reason: 'stalled',
    source: 'detector',
  });
  expect(runState(undefined, false, true, fresh, stall).state).toBe('idle');
  expect(runState(undefined, false, false, quiet, stall).state).toBe('idle');
  expect(runState(undefined, true, false, quiet, stall)).toEqual({
    state: 'working',
    source: 'proxy',
  });
});

test('wire: a run reads working, settles idle — declared by the brain on yggdrasil', async ({
  request,
}) => {
  const sid = await mk(request, `${TAG}-wire`);
  const dialect = (await (await request.get('/api/brain-dialect')).text()).trim();
  const row = async () => {
    const list = (await (await request.get('/api/session')).json()) as Array<{
      id: string;
      state?: string;
      stateSource?: string;
    }>;
    return list.find((s) => s.id === sid);
  };
  expect((await row())?.state).toBe('idle');
  void request.post(`/api/session/${sid}/messages`, {
    data: { text: 'Run exactly this bash command: sleep 12. Then reply: herdr-done', async: true },
  });
  await expect
    .poll(async () => (await row())?.state, { timeout: 20_000, message: 'never read working' })
    .toBe('working');
  await expect
    .poll(async () => (await row())?.state, { timeout: 90_000, message: 'never settled idle' })
    .toBe('idle');
  if (dialect === 'yggdrasil') {
    // the harness owns the truth: the brain's own declaration, not a guess
    expect((await row())?.stateSource).toBe('brain');
  }
});

test('identity pin: a page opened on one session never sends into its namesake', async ({
  page,
  request,
}) => {
  const NAME = `${TAG}-twin`;
  const first = await mk(request, NAME);
  const second = await mk(request, NAME); // same slug, newer — the slug resolves here
  await returning(page);
  await page.goto(`/session/${NAME}?id=${first}`);
  await send(page, 'Reply with exactly: pin-to-first');
  await expect
    .poll(async () => (await userTexts(request, first)).join('\n'), {
      timeout: 20_000,
      message: 'the turn never reached the session the page opened',
    })
    .toContain('pin-to-first');
  expect(
    (await userTexts(request, second)).join('\n'),
    'the namesake received a turn meant for another session'
  ).not.toContain('pin-to-first');
});

test('identity pin: a replaced session receives nothing — the page says the session is gone', async ({
  page,
  request,
}) => {
  const NAME = `${TAG}-repl`;
  const old = await mk(request, NAME);
  await returning(page);
  await page.goto(`/session/${NAME}?id=${old}`);
  await expect(page.getByPlaceholder('message…')).toBeVisible();
  // the identity dies while the page is open; a new session takes its name
  expect((await request.delete(`/api/session/${old}`)).ok()).toBeTruthy();
  const repl = await mk(request, NAME);
  await send(page, 'Reply with exactly: pin-stranger');
  await expect(page.getByText(/this session is gone/)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3_000); // any late fire would have landed by now
  expect(
    (await userTexts(request, repl)).join('\n'),
    'the replacement received the dead session’s turn — pin broken'
  ).not.toContain('pin-stranger');
  // the proxy's own reads are pinned too: the gone session never shows the
  // replacement's transcript
  const r = await request.get(`/api/session/${NAME}/messages`, {
    headers: { 'X-Session-Pin': old },
  });
  expect(r.status()).toBe(404);
  expect((await r.json()).code).toBe('session_gone');
});

test('identity pin: a queued turn dies with its session', async ({ request }) => {
  const sid = await mk(request, `${TAG}-queue`);
  void request.post(`/api/session/${sid}/messages`, {
    data: { text: 'Run exactly this bash command: sleep 15. Then reply: q-first', async: true },
  });
  await expect
    .poll(
      async () =>
        (await request.get(`/api/session/${sid}/messages?limit=5`)).headers()['x-run-live'],
      { timeout: 20_000, message: 'the first run never went live' }
    )
    .toBe('1');
  const q = await request.post(`/api/session/${sid}/messages`, {
    data: { text: 'q-QUEUED-behind', async: true },
  });
  expect((await q.json()).queued).toBeTruthy();
  // the proxy's queue file (server cwd = this runner's cwd: pwa/)
  const FILE = path.join(process.cwd(), '.oc-queue.json');
  const onDisk = async () => readFile(FILE, 'utf8').catch(() => '');
  expect(await onDisk(), 'the queued turn is on disk behind the live run').toContain(
    'q-QUEUED-behind'
  );
  expect((await request.delete(`/api/session/${sid}`)).ok()).toBeTruthy();
  expect(await onDisk(), 'a deleted session left its queue behind').not.toContain(
    'q-QUEUED-behind'
  );
});

test('voice-test room switch defaults OFF on a fresh device', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('voice-test-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('voice-test-state')).toContainText('off');
});
