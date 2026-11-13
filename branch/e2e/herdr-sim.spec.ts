import { execFileSync } from 'child_process';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/** Herdr §1.1 triad, the states only a SIMULATED brain can be driven into
 *  (scripts/sim-stack.sh: the sandbox build + the yggdrasil release binary
 *  against the mock LLM; playwright.sim.config.ts). The real provider can't
 *  be told to fail on cue — the mock can, and SIGKILL lands on a sim unit,
 *  never on the user's brain:
 *   - blocked / step-cap: a model that never stops calling tools hits the
 *     run's step cap → the brain declares blocked, the list says so (not
 *     busy, not idle); the next good turn → idle;
 *   - blocked / interrupted: the brain dies mid-turn (SIGKILL, systemd heals
 *     it) → the restarted brain closes the run the dead one left open and
 *     declares it; the open page stops saying "working…". */

const BRAIN_UNIT = 'sim-ygg';
const TAG = `e2e-sim-${Date.now().toString(36)}`;
const made: string[] = [];

test.beforeAll(() => {
  expect(
    process.env.PW_BASE_URL || '',
    'herdr-sim kills its brain: run it only against the sim stack (:8096)'
  ).toContain(':8096');
});

test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/session/${id}`).catch(() => {});
});

async function mk(request: APIRequestContext, name: string): Promise<string> {
  const id = ((await (await request.post('/api/session', { data: { name } })).json()) as {
    id: string;
  }).id;
  expect(id).toBeTruthy();
  made.push(id);
  return id;
}

async function row(request: APIRequestContext, sid: string) {
  const res = await request.get('/api/session');
  if (!res.ok()) return `unreachable (${res.status()})`; // the brain is mid-heal
  const list = (await res.json()) as Array<{
    id: string;
    state: string;
    stateReason?: string;
    stateSource: string;
  }>;
  const r = list.find((s) => s.id === sid);
  return r ? `${r.state}${r.stateReason ? '/' + r.stateReason : ''} (${r.stateSource})` : 'missing';
}

const turn = (request: APIRequestContext, sid: string, text: string) =>
  request.post(`/api/session/${sid}/messages`, { data: { text, async: true } });

async function returning(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('bifrost-door', 'v2');
    localStorage.setItem('bifrost-onboard', JSON.stringify({ lang: 'en', style: 'short' }));
    localStorage.setItem('oz-mode', 'text');
    localStorage.setItem('bifrost-first-turn', '1');
  });
}

test('blocked/step-cap: a run that never ends its tool loop is said as blocked, then heals', async ({
  request,
}) => {
  const sid = await mk(request, `${TAG}-cap`);
  expect(await row(request, sid)).toBe('idle (brain)');
  await turn(request, sid, 'tool:forever'); // the mock calls bash on every step
  await expect
    .poll(() => row(request, sid), { timeout: 60_000, message: 'step cap never surfaced' })
    .toBe('blocked/step-cap (brain)');
  // blocked is not busy: nothing is running, the list must not show a dot
  const list = (await (await request.get('/api/session')).json()) as Array<{
    id: string;
    pending: boolean;
  }>;
  expect(list.find((s) => s.id === sid)?.pending).toBe(false);
  // the user's answer (a new turn) clears it
  await turn(request, sid, 'Reply with exactly: healed');
  await expect.poll(() => row(request, sid), { timeout: 30_000 }).toBe('idle (brain)');
});

test('blocked/interrupted: the brain dies mid-turn — the run is closed and said, the page stops working', async ({
  page,
  request,
}) => {
  const NAME = `${TAG}-kill`;
  const sid = await mk(request, NAME);
  await returning(page);
  await page.goto(`/session/${NAME}?id=${sid}`);
  await page.getByPlaceholder('message…').fill('slow please — count with me');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText(/working…/)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => row(request, sid), { timeout: 15_000 }).toBe('working (brain)');
  // SIGKILL the sim brain mid-stream; its unit (Restart=on-failure) heals it
  execFileSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', BRAIN_UNIT]);
  await expect
    .poll(() => row(request, sid), { timeout: 30_000, message: 'interrupted run never said' })
    .toBe('blocked/interrupted (brain)');
  // the transcript is closed — no ghost step left "running"
  const st = (await request.get(`/api/session/${sid}/messages?limit=5`)).headers()['x-run-state'];
  expect(st, 'the dead run must read completed').not.toMatch(/\|0\|/);
  // the phone is not left on "working…" for a run that no longer exists
  await expect(page.getByText(/working…/)).toHaveCount(0, { timeout: 30_000 });
  // and the session takes the next turn
  await turn(request, sid, 'Reply with exactly: after-kill');
  await expect.poll(() => row(request, sid), { timeout: 30_000 }).toBe('idle (brain)');
  await expect(page.getByText('after-kill').first()).toBeVisible({ timeout: 15_000 });
});
